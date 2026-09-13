---
description: Run a Codex code review against local git state
---

Run a Codex review through the built-in Codex reviewer by calling the `codex_review` tool.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Codex's output verbatim to the user.

Argument mapping:
- `--base <ref>` becomes the `base` argument.
- `--scope <auto|working-tree|branch>` becomes the `scope` argument.
- `--model <model>` becomes the `model` argument.
- `--background` sets `background: true`. Otherwise run in the foreground and wait for the result.
- `--wait` means foreground. Do not forward it.
- `/codex-review` is native-review only. It does not support staged-only review, unstaged-only review, or extra focus text.
- If the user added focus text, tell them to use `/codex-adversarial-review` with that text instead of running this review.

Output rules:
- Return the tool output verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output. If the user wants fixes, they will ask.
- When `background` was used, tell the user: "Codex review started in the background. Check `/codex-status` for progress."
