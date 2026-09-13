#!/usr/bin/env node
// Thin command-line front for lib/commands.mjs. OpenCode never calls this;
// it exists for local debugging and for the runtime test suite.
import process from "node:process";

import * as commands from "./lib/commands.mjs";

const HANDLERS = {
  setup: commands.setup,
  review: commands.review,
  "adversarial-review": commands.adversarialReview,
  task: commands.task,
  status: commands.status,
  result: commands.result,
  cancel: commands.cancel
};

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  const handler = HANDLERS[subcommand];
  if (!handler) {
    throw new Error(`Usage: node cli.mjs <${Object.keys(HANDLERS).join("|")}> [options]`);
  }

  const json = commands.normalizeArgv(argv).includes("--json");
  const { payload, rendered, exitStatus } = await handler(argv, {
    cwd: process.cwd(),
    sessionId: process.env.CODEX_COMPANION_SESSION_ID ?? null,
    readStdin: true,
    progressToStderr: !json
  });

  process.stdout.write(json ? `${JSON.stringify(payload, null, 2)}\n` : rendered);
  if (exitStatus) {
    process.exitCode = exitStatus;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
