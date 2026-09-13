import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./args.mjs";
import {
  buildPersistentTaskThreadName,
  DEFAULT_CONTINUE_PROMPT,
  findLatestTaskThread,
  getCodexAuthStatus,
  getCodexAvailability,
  parseStructuredOutput,
  readOutputSchema,
  runAppServerReview,
  runAppServerTurn
} from "./codex.mjs";
import { readStdinIfPiped } from "./fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./git.mjs";
import { binaryAvailable } from "./process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./prompts.mjs";
import { generateJobId, listJobs, saveState, upsertJob, writeJobFile } from "./state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob
} from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);

/**
 * Jobs currently executing in this process, keyed by job id. Cancel aborts the
 * controller, which closes that job's private codex app-server.
 * @type {Map<string, AbortController>}
 */
const activeJobs = new Map();

/**
 * @typedef {{
 *   cwd: string,
 *   sessionId?: string | null,
 *   readStdin?: boolean,
 *   progressToStderr?: boolean,
 *   signal?: AbortSignal | null,
 *   onProgress?: ((event: unknown) => void) | null
 * }} CommandContext
 * @typedef {{ payload: unknown, rendered: string, exitStatus: number }} CommandResult
 */

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh.`
    );
  }
  return normalized;
}

export function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options, ctx) {
  return options.cwd ? path.resolve(ctx.cwd, options.cwd) : ctx.cwd;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

function commandResult(payload, rendered, exitStatus = 0) {
  return { payload, rendered, exitStatus };
}

async function buildSetupReport(cwd) {
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);

  const nextSteps = [];
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `codex login` in a terminal.");
    nextSteps.push("If browser login is blocked, retry with `codex login --device-auth` or `codex login --with-api-key`.");
  }

  return {
    ready: nodeStatus.available && codexStatus.available && authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    codex: codexStatus,
    auth: authStatus,
    nextSteps
  };
}

/** @param {string[]} argv @param {CommandContext} ctx @returns {Promise<CommandResult>} */
export async function setup(argv, ctx) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const report = await buildSetupReport(resolveCommandCwd(options, ctx));
  return commandResult(report, renderSetupReport(report));
}

function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex-setup`.");
  }
}

function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/codex-review\` maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/codex-adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/codex-review` target is not supported by the built-in reviewer. Retry with `/codex-adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function filterJobsForSession(jobs, sessionId) {
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function resolveLatestTrackedTaskThread(cwd, { excludeJobId = null, sessionId = null } = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== excludeJobId);
  const visibleJobs = filterJobsForSession(jobs, sessionId);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && isActiveJobStatus(job.status));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /codex-status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      onProgress: request.onProgress,
      signal: request.signal
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress,
    signal: request.signal
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeThreadId = null;
  if (request.resumeLast) {
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId,
      sessionId: request.sessionId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt or use --resume-last.");
  }

  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    sandbox: request.write ? "workspace-write" : "read-only",
    onProgress: request.onProgress,
    signal: request.signal,
    persistThread: true,
    threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedJobLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /codex-status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, sessionId, write = false }) {
  return createJobRecord(
    {
      id: generateJobId(prefix),
      kind,
      kindLabel: getJobKindLabel(kind, jobClass),
      title,
      workspaceRoot,
      jobClass,
      summary,
      write
    },
    sessionId
  );
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: (event) => {
        createJobProgressUpdater(job.workspaceRoot, job.id)(event);
        options.onProgress?.(event);
      }
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write, sessionId) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    sessionId,
    write
  });
}

function readTaskPrompt(cwd, options, positionals, ctx) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  if (positionalPrompt || !ctx.readStdin) {
    return positionalPrompt;
  }
  return readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt or use --resume-last.");
  }
}

function trackJob(jobId, signal = null) {
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }
  activeJobs.set(jobId, controller);
  return controller;
}

async function runForegroundJob(job, runner, ctx) {
  const { logFile, progress } = createTrackedProgress(job, {
    stderr: ctx.progressToStderr,
    onProgress: ctx.onProgress
  });
  const controller = trackJob(job.id, ctx.signal);
  try {
    return await runTrackedJob(job, () => runner({ onProgress: progress, signal: controller.signal }), {
      logFile,
      signal: controller.signal
    });
  } finally {
    activeJobs.delete(job.id);
  }
}

async function runStoredJob(workspaceRoot, jobId) {
  const storedJob = readStoredJob(workspaceRoot, jobId);
  const request = storedJob?.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${jobId} is missing its request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    { ...storedJob, workspaceRoot },
    { logFile: storedJob.logFile ?? null }
  );
  const controller = trackJob(jobId);
  const execute = storedJob.jobClass === "review" ? executeReviewRun : executeTaskRun;
  try {
    await runTrackedJob(
      { ...storedJob, workspaceRoot, logFile },
      () => execute({ ...request, onProgress: progress, signal: controller.signal }),
      { logFile, signal: controller.signal }
    );
  } finally {
    activeJobs.delete(jobId);
  }
}

function enqueueBackgroundJob(job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: null,
    hostPid: process.pid,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  // ponytail: in-process promise instead of a detached worker; the host
  // process (OpenCode server or the CLI) stays alive until the job ends.
  void runStoredJob(job.workspaceRoot, job.id).catch(() => {});

  const payload = {
    jobId: job.id,
    status: "queued",
    title: job.title,
    summary: job.summary,
    logFile
  };
  return commandResult(payload, renderQueuedJobLaunch(payload));
}

async function runReviewCommand(argv, ctx, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options, ctx);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const focusText = positionals.join(" ").trim();
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary,
    sessionId: ctx.sessionId
  });
  const request = {
    cwd,
    base: options.base,
    scope: options.scope,
    model: options.model,
    focusText,
    reviewName: config.reviewName
  };

  if (options.background) {
    ensureCodexAvailable(cwd);
    return enqueueBackgroundJob(job, request);
  }

  return runForegroundJob(job, (extra) => executeReviewRun({ ...request, ...extra }), ctx);
}

/** @param {string[]} argv @param {CommandContext} ctx @returns {Promise<CommandResult>} */
export function review(argv, ctx) {
  return runReviewCommand(argv, ctx, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

/** @param {string[]} argv @param {CommandContext} ctx @returns {Promise<CommandResult>} */
export function adversarialReview(argv, ctx) {
  return runReviewCommand(argv, ctx, { reviewName: "Adversarial Review" });
}

/** @param {string[]} argv @param {CommandContext} ctx @returns {Promise<CommandResult>} */
export async function task(argv, ctx) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options, ctx);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals, ctx);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({ prompt, resumeLast });
  const job = buildTaskJob(workspaceRoot, taskMetadata, write, ctx.sessionId);
  const request = {
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId: job.id,
    sessionId: ctx.sessionId ?? null
  };

  if (options.background) {
    ensureCodexAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);
    return enqueueBackgroundJob(job, request);
  }

  return runForegroundJob(job, (extra) => executeTaskRun({ ...request, ...extra }), ctx);
}

/** @param {string[]} argv @param {CommandContext} ctx @returns {Promise<CommandResult>} */
export async function status(argv, ctx) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options, ctx);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    return commandResult(snapshot, renderJobStatusReport(snapshot.job));
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all, sessionId: ctx.sessionId });
  return commandResult(report, renderStatusReport(report));
}

/** @param {string[]} argv @param {CommandContext} ctx @returns {CommandResult} */
export function result(argv, ctx) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options, ctx);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference, ctx.sessionId);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  return commandResult({ job, storedJob }, renderStoredJobResult(job, storedJob));
}

/** @param {string[]} argv @param {CommandContext} ctx @returns {CommandResult} */
export function cancel(argv, ctx) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options, ctx);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, ctx.sessionId);
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};

  activeJobs.get(job.id)?.abort();
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title
  };
  return commandResult(payload, renderCancelReport(nextJob));
}

/** Abort and forget every job that belongs to an ended session. */
export function cleanupSessionJobs(cwd, sessionId) {
  if (!sessionId) {
    return;
  }
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = listJobs(workspaceRoot);
  const remaining = jobs.filter((job) => job.sessionId !== sessionId);
  if (remaining.length === jobs.length) {
    return;
  }
  for (const job of jobs) {
    if (job.sessionId === sessionId) {
      activeJobs.get(job.id)?.abort();
    }
  }
  saveState(workspaceRoot, { jobs: remaining });
}

function hostAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Mark queued or running jobs whose host process is gone as failed. Background
 * jobs live inside the OpenCode server, so they die with it.
 */
export function sweepOrphanedJobs(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const completedAt = nowIso();
  for (const job of listJobs(workspaceRoot)) {
    if (!isActiveJobStatus(job.status) || activeJobs.has(job.id) || hostAlive(job.hostPid)) {
      continue;
    }
    const errorMessage = "Interrupted: the OpenCode server exited before this job finished.";
    appendLogLine(job.logFile, errorMessage);
    const stored = readStoredJob(workspaceRoot, job.id) ?? {};
    writeJobFile(workspaceRoot, job.id, { ...stored, ...job, status: "failed", phase: "failed", errorMessage, completedAt });
    upsertJob(workspaceRoot, { id: job.id, status: "failed", phase: "failed", errorMessage, completedAt });
  }
}

/** Abort every job still running in this process. Used on host shutdown. */
export function abortAllJobs() {
  for (const controller of activeJobs.values()) {
    controller.abort();
  }
  activeJobs.clear();
}
