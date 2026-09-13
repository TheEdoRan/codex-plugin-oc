# Changelog

## 1.1.0

- Ported the plugin from Claude Code to OpenCode as `codex-plugin-oc`.
- Commands are now `/codex-review`, `/codex-adversarial-review`, `/codex-rescue`, `/codex-status`, `/codex-result`, `/codex-cancel`, and `/codex-setup`.
- The Codex runtime is exposed as in-process OpenCode tools (`codex_*`) so every model can call it.
- Added the `codex-rescue` subagent and registered the `gpt-5-4-prompting` skill.
- Background jobs run inside the OpenCode server; cancel and Esc abort the job's own Codex app-server.
- Job state moved to `$XDG_DATA_HOME/opencode/codex-plugin` (override with `CODEX_PLUGIN_DATA_DIR`).
- Removed the stop-time review gate, the Claude session transfer command, the shared app-server broker, and the tsc typecheck.

## 1.0.0

- Initial version of the Codex plugin for Claude Code
