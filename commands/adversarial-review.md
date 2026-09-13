---
description: Run a Codex review that challenges the implementation approach and design choices
---

Run an adversarial Codex review by calling the `codex_adversarial_review` tool.
Position it as a challenge review that questions the chosen implementation, design choices, tradeoffs, and assumptions.
It is not just a stricter pass over implementation defects.

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
- Everything else in the arguments is the user's focus text. Pass it as the `focus` argument without weakening or rewriting it.
- `--scope staged` and `--scope unstaged` are not supported.

Output rules:
- Return the tool output verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output. If the user wants fixes, they will ask.
- When `background` was used, tell the user: "Codex adversarial review started in the background. Check `/codex-status` for progress."
