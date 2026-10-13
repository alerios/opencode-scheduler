# Changelog

## Unreleased

- Windows (Task Scheduler) scheduled runs now go through `supervisor.ps1` (written next to `supervisor.pl`, refreshed on plugin load). It runs in the job `workdir` with `PWD` set, writes the same log, `===` markers and run records as the Perl supervisor, updates `lastRun*`, skips overlapping runs and enforces `timeoutSeconds`. The prompt stays in the job JSON instead of the task command line.
- Windows: the opencode path is resolved to an absolute `opencode.exe` (`OPENCODE_SCHEDULER_OPENCODE_PATH`, which must be absolute and must exist, with `.cmd`/`.bat` refused unless `OPENCODE_SCHEDULER_ALLOW_CMD_SHIM=1`; then absolute `PATH` folders scanned in JS rather than with `where.exe`; then the running binary; then standard install folders). `schtasks`, `powershell` and `taskkill` are run by absolute path under `%SystemRoot%`. If nothing is found, `schedule_job` fails with a message naming `OPENCODE_SCHEDULER_OPENCODE_PATH` instead of storing a bare `opencode` (which failed with 0x80070002).
- Windows: tasks are set to start and keep running on battery, to start when available after a missed time, and to have no execution time limit (`PT0S`; `timeoutSeconds` is enforced by the supervisor). If that step fails, the tasks are removed and `schedule_job` reports the error.
- GitHub install works on OpenCode v2.0.26: renamed the `build` script to `build:dist` so the git-dependency prepare step (which spawns an embedded npm that fails) is not triggered. Do not add `build`/`prepare`/`prepack`/`install`/`postinstall` scripts.
- `main` and `exports["."]` now point at `server.ts` (source); removed the nonexistent `types` field and `dist` from `files`; `dist/` is gitignored.

## 2.0.0-alpha.0

- Requires OpenCode v2 (`@opencode/plugin` 2.x). Tool names are unchanged; tools are registered as direct tools.
- `opencode run` flags follow v2: `attachUrl` → `--server`, `variant` → `--model model#variant`. `port`, `share` and `command` are not supported.
- New job options: `autoApprove` (`--auto`; without it, unattended runs reject permission requests) and `standalone` (`--standalone`).
- Jobs created under v1 keep their v1 command line until you run `migrate_jobs` (dry run first, then `confirm=true`). `list_jobs` marks them.
- The skill is registered automatically; `install_skill` now writes to `.opencode/skills/`.
- Supervisor sets `PWD` to the job workdir.
- Tests added (bun test).
