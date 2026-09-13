---
description: Check whether the local Codex CLI is installed and authenticated
---

Call the `codex_setup` tool.

If the result says Codex is unavailable and npm is available:
- Use the `question` tool exactly once to ask whether to install Codex now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Codex (Recommended)`
  - `Skip for now`
- If the user chooses install, run `npm install -g @openai/codex` with the bash tool, then call `codex_setup` again.

If Codex is already installed or npm is unavailable:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Codex is installed but not authenticated, tell the user to run `codex login` in a terminal, then rerun `/codex-setup`.
