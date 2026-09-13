// OpenCode plugin entry. Registers the /codex-* commands, the codex-rescue
// subagent, the gpt-5-4-prompting skill, and the codex_* tools that drive the
// Codex app-server runtime in lib/.
//
// Add it to opencode.json: { "plugin": ["@theedoran/codex-plugin-oc"] }
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { tool } from "@opencode-ai/plugin";

import * as commands from "./lib/commands.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const z = tool.schema;

const SCOPES = ["auto", "working-tree", "branch"];
const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];

function readMarkdown(file) {
  const raw = fs.readFileSync(file, "utf8");
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { description: "", body: raw.trim() };
  }
  const description = (match[1].match(/^description:\s*(.+)$/m)?.[1] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
  return { description, body: match[2].trim() };
}

function flagsToArgv(flags, positionals = []) {
  const argv = [];
  for (const [key, value] of Object.entries(flags)) {
    if (value === true) {
      argv.push(`--${key}`);
    } else if (typeof value === "string" && value.trim()) {
      argv.push(`--${key}`, value.trim());
    }
  }
  return [...argv, ...positionals.filter((value) => typeof value === "string" && value.trim())];
}

export default async function CodexPlugin({ client, directory }) {
  const rootSessionCache = new Map();

  try {
    commands.sweepOrphanedJobs(directory);
  } catch {
    // A broken state file must not stop the plugin from loading.
  }

  // Subagents run in child sessions. Jobs are scoped to the root session so
  // /codex-status in the parent sees what /codex-rescue started.
  async function rootSessionId(sessionID) {
    if (!sessionID) {
      return null;
    }
    if (rootSessionCache.has(sessionID)) {
      return rootSessionCache.get(sessionID);
    }
    let current = sessionID;
    try {
      for (let depth = 0; depth < 16; depth += 1) {
        const response = await client.session.get({ path: { id: current } });
        const parentID = response?.data?.parentID;
        if (!parentID) {
          break;
        }
        current = parentID;
      }
    } catch {
      current = sessionID;
    }
    rootSessionCache.set(sessionID, current);
    return current;
  }

  async function runCommand(handler, argv, context) {
    const { rendered } = await handler(argv, {
      cwd: context.directory ?? directory,
      sessionId: await rootSessionId(context.sessionID),
      signal: context.abort,
      onProgress: (event) => {
        if (event?.message) {
          context.metadata({ title: event.message });
        }
      }
    });
    return rendered;
  }

  return {
    config: async (config) => {
      config.command ??= {};
      const commandsDir = path.join(ROOT, "commands");
      for (const file of fs.readdirSync(commandsDir).filter((name) => name.endsWith(".md")).sort()) {
        const name = path.basename(file, ".md");
        const { description, body } = readMarkdown(path.join(commandsDir, file));
        config.command[`codex-${name}`] = {
          description,
          template: body,
          ...(name === "rescue" ? { agent: "codex-rescue", subtask: true } : {})
        };
      }

      config.agent ??= {};
      const rescue = readMarkdown(path.join(ROOT, "agents", "codex-rescue.md"));
      config.agent["codex-rescue"] = {
        description: rescue.description,
        mode: "subagent",
        prompt: rescue.body,
        tools: {
          codex_task: true,
          codex_review: false,
          codex_adversarial_review: false,
          codex_status: false,
          codex_result: false,
          codex_cancel: false,
          codex_setup: false,
          bash: false,
          edit: false,
          write: false,
          patch: false,
          task: false,
          webfetch: false
        }
      };

      config.skills ??= {};
      config.skills.paths ??= [];
      const skillsDir = path.join(ROOT, "skills");
      if (!config.skills.paths.includes(skillsDir)) {
        config.skills.paths.push(skillsDir);
      }
    },

    tool: {
      codex_setup: tool({
        description: "Check whether the Codex CLI is installed and authenticated for this repository.",
        args: {},
        execute: (_args, context) => runCommand(commands.setup, [], context)
      }),

      codex_review: tool({
        description:
          "Run Codex's built-in read-only code review on the working tree or on the current branch against a base ref. Review only: it never edits files. Returns the review text verbatim.",
        args: {
          base: z.string().optional().describe("Base ref for a branch review, for example main. Omit to review uncommitted changes."),
          scope: z.enum(SCOPES).optional().describe("auto (default), working-tree, or branch."),
          model: z.string().optional().describe("Codex model override. Omit to use the Codex default."),
          background: z.boolean().optional().describe("Queue the review as a background job and return its job id immediately.")
        },
        execute: ({ base, scope, model, background }, context) =>
          runCommand(commands.review, flagsToArgv({ base, scope, model, background }), context)
      }),

      codex_adversarial_review: tool({
        description:
          "Run a steerable Codex review that challenges the implementation approach, design choices and assumptions. Accepts free-form focus text. Review only: it never edits files. Returns structured findings verbatim.",
        args: {
          focus: z.string().optional().describe("What the review should challenge or focus on."),
          base: z.string().optional().describe("Base ref for a branch review, for example main. Omit to review uncommitted changes."),
          scope: z.enum(SCOPES).optional().describe("auto (default), working-tree, or branch."),
          model: z.string().optional().describe("Codex model override. Omit to use the Codex default."),
          background: z.boolean().optional().describe("Queue the review as a background job and return its job id immediately.")
        },
        execute: ({ focus, base, scope, model, background }, context) =>
          runCommand(commands.adversarialReview, flagsToArgv({ base, scope, model, background }, [focus]), context)
      }),

      codex_task: tool({
        description:
          "Delegate an investigation, fix, or implementation task to Codex in this repository. Returns Codex's final answer verbatim. Use resume to continue the latest Codex task thread from this session.",
        args: {
          prompt: z.string().optional().describe("The task for Codex. Optional when resume is true."),
          write: z.boolean().optional().describe("Allow Codex to edit files in the workspace. Default false (read-only)."),
          resume: z.boolean().optional().describe("Continue the latest Codex task thread for this repository instead of starting fresh."),
          model: z.string().optional().describe("Codex model override, for example gpt-5.4-mini or spark."),
          effort: z.enum(EFFORTS).optional().describe("Reasoning effort override."),
          background: z.boolean().optional().describe("Queue the task as a background job and return its job id immediately.")
        },
        execute: ({ prompt, write, resume, model, effort, background }, context) =>
          runCommand(
            commands.task,
            flagsToArgv({ write, "resume-last": resume, model, effort, background }, [prompt]),
            context
          )
      }),

      codex_status: tool({
        description: "Show running and recent Codex jobs for this repository, or the details of one job.",
        args: {
          jobId: z.string().optional().describe("Job id or unique prefix. Omit for the overview."),
          all: z.boolean().optional().describe("Include every recorded job instead of the most recent ones."),
          wait: z.boolean().optional().describe("With jobId: block until the job finishes (up to a few minutes).")
        },
        execute: ({ jobId, all, wait }, context) => runCommand(commands.status, flagsToArgv({ all, wait }, [jobId]), context)
      }),

      codex_result: tool({
        description: "Show the stored final output of a finished Codex job. Defaults to the latest finished job from this session.",
        args: {
          jobId: z.string().optional().describe("Job id or unique prefix.")
        },
        execute: ({ jobId }, context) => runCommand(commands.result, flagsToArgv({}, [jobId]), context)
      }),

      codex_cancel: tool({
        description: "Cancel an active Codex job. Defaults to the only active job from this session.",
        args: {
          jobId: z.string().optional().describe("Job id or unique prefix.")
        },
        execute: ({ jobId }, context) => runCommand(commands.cancel, flagsToArgv({}, [jobId]), context)
      })
    },

    event: async ({ event }) => {
      if (event?.type !== "session.deleted") {
        return;
      }
      const info = event.properties?.info;
      if (!info?.id) {
        return;
      }
      try {
        commands.cleanupSessionJobs(info.directory ?? directory, info.id);
      } catch {
        // Never let cleanup break the host.
      }
    },

    dispose: async () => {
      commands.abortAllJobs();
    }
  };
}
