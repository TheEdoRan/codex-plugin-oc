---
description: Show active and recent Codex jobs for this repository
---

Call the `codex_status` tool.

Raw slash-command arguments:
`$ARGUMENTS`

Argument mapping:
- The first non-flag token is the `jobId`.
- `--all` sets `all: true`.
- `--wait` sets `wait: true`. It needs a `jobId`.

If the user did not pass a job ID:
- Render the tool output as a single Markdown table for the current and past runs in this session.
- Keep it compact. Do not include progress blocks or extra prose outside the table.
- Preserve the actionable fields from the output, including job ID, kind, status, phase, elapsed or duration, summary, and follow-up commands.

If the user did pass a job ID:
- Present the full tool output to the user.
- Do not summarize or condense it.
