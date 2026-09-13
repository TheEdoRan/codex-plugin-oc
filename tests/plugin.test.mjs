import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { listJobs, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "../lib/state.mjs";
import plugin from "../index.mjs";

process.env.CODEX_PLUGIN_DATA_DIR = makeTempDir("codex-plugin-state-");

const EXPECTED_COMMANDS = [
  "codex-adversarial-review",
  "codex-cancel",
  "codex-rescue",
  "codex-result",
  "codex-review",
  "codex-setup",
  "codex-status"
];
const EXPECTED_TOOLS = [
  "codex_adversarial_review",
  "codex_cancel",
  "codex_result",
  "codex_review",
  "codex_setup",
  "codex_status",
  "codex_task"
];

function fakeClient(sessions = {}) {
  return {
    session: {
      get: async ({ path: { id } }) => ({ data: sessions[id] ?? { id } })
    }
  };
}

function toolContext(sessionID, directory) {
  return {
    sessionID,
    messageID: "msg",
    agent: "build",
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata() {},
    ask: async () => {}
  };
}

function makeRepo() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

async function withFakeCodex(behavior, fn) {
  const binDir = makeTempDir();
  installFakeCodex(binDir, behavior);
  const previousPath = process.env.PATH;
  process.env.PATH = buildEnv(binDir).PATH;
  try {
    return await fn(binDir);
  } finally {
    process.env.PATH = previousPath;
  }
}

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

test("config hook registers the commands, the rescue agent and the skills directory", async () => {
  const hooks = await plugin({ client: fakeClient(), directory: process.cwd() });
  const config = {};
  await hooks.config(config);

  assert.deepEqual(Object.keys(config.command).sort(), EXPECTED_COMMANDS);
  assert.match(config.command["codex-review"].description, /Codex code review/);
  assert.match(config.command["codex-review"].template, /codex_review/);
  assert.equal(config.command["codex-rescue"].agent, "codex-rescue");
  assert.equal(config.command["codex-rescue"].subtask, true);
  assert.equal(config.command["codex-status"].agent, undefined);

  assert.equal(config.agent["codex-rescue"].mode, "subagent");
  assert.match(config.agent["codex-rescue"].prompt, /codex_task/);
  assert.equal(config.agent["codex-rescue"].tools.codex_task, true);
  assert.equal(config.agent["codex-rescue"].tools.bash, false);

  assert.equal(config.skills.paths.length, 1);
  assert.equal(fs.existsSync(path.join(config.skills.paths[0], "gpt-5-4-prompting", "SKILL.md")), true);

  assert.deepEqual(Object.keys(hooks.tool).sort(), EXPECTED_TOOLS);
});

test("tools run in-process, scope jobs to the root session, and expose background results", async () => {
  await withFakeCodex("slow-task", async () => {
    const repo = makeRepo();
    const sessions = {
      root: { id: "root" },
      child: { id: "child", parentID: "root" },
      sibling: { id: "sibling", parentID: "root" }
    };
    const hooks = await plugin({ client: fakeClient(sessions), directory: repo });
    const child = toolContext("child", repo);

    const empty = await hooks.tool.codex_status.execute({}, child);
    assert.match(empty, /# Codex Status/);
    assert.match(empty, /No jobs recorded yet/);

    const launch = await hooks.tool.codex_task.execute({ prompt: "investigate the failing test", background: true }, child);
    const jobId = launch.match(/as (task-[a-z0-9-]+)\./)?.[1];
    assert.ok(jobId, launch);

    const waited = await hooks.tool.codex_status.execute({ jobId, wait: true }, toolContext("sibling", repo));
    assert.match(waited, /completed/);

    const overview = await hooks.tool.codex_status.execute({}, toolContext("root", repo));
    assert.match(overview, new RegExp(jobId));

    const result = await hooks.tool.codex_result.execute({ jobId }, child);
    assert.match(result, /Handled the requested task/);

    const jobs = listJobs(repo);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].sessionId, "root");
    assert.equal(jobs[0].pid, null);
  });
});

test("codex_cancel aborts an in-process background job and keeps it cancelled", async () => {
  await withFakeCodex("interruptible-slow-task", async () => {
    const repo = makeRepo();
    const hooks = await plugin({ client: fakeClient(), directory: repo });
    const ctx = toolContext("sess", repo);

    const launch = await hooks.tool.codex_task.execute({ prompt: "long running task", background: true }, ctx);
    const jobId = launch.match(/as (task-[a-z0-9-]+)\./)?.[1];
    assert.ok(jobId, launch);

    await waitFor(() => listJobs(repo).find((job) => job.id === jobId && job.threadId));

    const cancelled = await hooks.tool.codex_cancel.execute({ jobId }, ctx);
    assert.match(cancelled, /cancelled/i);

    // Give the aborted run time to unwind; it must not overwrite the cancelled status.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const job = listJobs(repo).find((entry) => entry.id === jobId);
    assert.equal(job.status, "cancelled");
    assert.match(fs.readFileSync(job.logFile, "utf8"), /Cancelled by user/);
  });
});

test("session.deleted prunes only that session's jobs", async () => {
  await withFakeCodex("review-ok", async () => {
    const repo = makeRepo();
    const hooks = await plugin({ client: fakeClient(), directory: repo });

    await hooks.tool.codex_task.execute({ prompt: "first" }, toolContext("keep", repo));
    await hooks.tool.codex_task.execute({ prompt: "second" }, toolContext("gone", repo));
    assert.equal(listJobs(repo).length, 2);

    await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "gone", directory: repo } } } });

    const remaining = listJobs(repo);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].sessionId, "keep");
  });
});

test("plugin start marks jobs from a dead host as failed and leaves live ones alone", async () => {
  const repo = makeRepo();
  const deadPid = 2 ** 22 - 7;
  const seed = (id, hostPid) => {
    const logFile = resolveJobLogFile(repo, id);
    fs.writeFileSync(logFile, "", "utf8");
    const job = { id, status: "running", phase: "running", title: "Codex Task", jobClass: "task", hostPid, logFile };
    writeJobFile(repo, id, job);
    upsertJob(repo, job);
  };
  seed("task-dead", deadPid);
  seed("task-alive", process.pid);

  await plugin({ client: fakeClient(), directory: repo });

  const byId = Object.fromEntries(listJobs(repo).map((job) => [job.id, job]));
  assert.equal(byId["task-dead"].status, "failed");
  assert.match(byId["task-dead"].errorMessage, /OpenCode server exited/);
  assert.equal(JSON.parse(fs.readFileSync(resolveJobFile(repo, "task-dead"), "utf8")).status, "failed");
  assert.equal(byId["task-alive"].status, "running");
});
