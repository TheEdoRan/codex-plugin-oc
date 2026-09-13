---
description: Delegate investigation, an explicit fix request, or follow-up rescue work to the Codex rescue subagent
---

Forward this rescue request to Codex with exactly one `codex_task` call and return Codex's output verbatim.

Raw user request:
$ARGUMENTS

Argument mapping:
- `--background` sets `background: true`. `--wait` means foreground. Neither is part of the task text.
- `--resume` sets `resume: true`. `--fresh` means do not set `resume`. Neither is part of the task text.
- If neither `--resume` nor `--fresh` is present and the request clearly continues prior Codex work in this repository, such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", set `resume: true`. Otherwise start fresh.
- `--model <model>` becomes the `model` argument. `spark` maps to `gpt-5.3-codex-spark`. Leave it unset unless the user asked for a model.
- `--effort <none|minimal|low|medium|high|xhigh>` becomes the `effort` argument. Leave it unset unless the user asked for it.
- Set `write: true` unless the user explicitly asks for read-only behavior or only wants review, diagnosis, or research without edits.
- Everything else is the task text. Pass it as the `prompt` argument as-is, apart from stripping the flags above.

Operating rules:
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- If the tool reports that Codex is missing or unauthenticated, stop and tell the user to run `/codex-setup`.
- If the user did not supply a request, ask what Codex should investigate or fix.
- Return the `codex_task` output verbatim. Do not paraphrase, summarize, rewrite, or add commentary before or after it.
