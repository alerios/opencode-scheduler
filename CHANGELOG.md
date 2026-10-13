# Changelog

## 2.0.0-alpha.0

- Requires OpenCode v2 (`@opencode/plugin` 2.x). Tool names are unchanged; tools are registered as direct tools.
- `opencode run` flags follow v2: `attachUrl` → `--server`, `variant` → `--model model#variant`. `port`, `share` and `command` are not supported.
- New job options: `autoApprove` (`--auto`; without it, unattended runs reject permission requests) and `standalone` (`--standalone`).
- Jobs created under v1 keep their v1 command line until you run `migrate_jobs` (dry run first, then `confirm=true`). `list_jobs` marks them.
- The skill is registered automatically; `install_skill` now writes to `.opencode/skills/`.
- Supervisor sets `PWD` to the job workdir.
- Tests added (bun test).
