---
description: Show the stored final output for a finished Codex job in this repository
---

Call the `codex_result` tool. The first non-flag token in the arguments is the `jobId`; omit it for the latest finished job.

Raw slash-command arguments:
`$ARGUMENTS`

Present the full tool output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result payload, including verdict, summary, findings, details, artifacts, and next steps
- File paths and line numbers exactly as reported
- Any error messages or parse errors
- Follow-up commands such as `/codex-status <id>` and `/codex-review`

Do not fix any issues mentioned in the output. If the user wants fixes, they will ask.
