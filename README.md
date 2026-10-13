# opencode-scheduler

Run AI agents on a schedule. Set up recurring tasks that execute autonomously—even when you're away.

```
Schedule a daily job at 9am to search Facebook Marketplace for posters under $100 and send the top 5 deals to my Telegram
```

This is an [OpenCode](https://opencode.ai) plugin that uses your OS's native scheduler (launchd on macOS, systemd on Linux, Task Scheduler on Windows), with cron fallback where native backends are unavailable.

As of `v1.2.0`, jobs are scoped by `workdir` (so different projects don't collide), and scheduled runs are supervised (no overlap + optional timeout).

## Install (OpenCode v2)

Add to your OpenCode config (`~/.config/opencode/opencode.json` or `.opencode/opencode.json`):

```json
{ "plugins": ["opencode-scheduler"] }
```

Install straight from GitHub (no npm publish required):

```json
{ "plugins": ["github:alerios/opencode-scheduler"] }
```

or `opencode plugin add github:alerios/opencode-scheduler`. The plugin loads from source (`server.ts`); there is no build step on install.

For a local checkout, use the directory path instead: `{ "plugins": ["/path/to/opencode-scheduler"] }`.

### Changes from v1
- Requires OpenCode v2 (`@opencode/plugin` 2.x). Tool names are unchanged; tools are registered as direct tools.
- `opencode run` flags follow v2: `attachUrl` → `--server`, `variant` → `--model model#variant`. `port`, `share` and `command` are not supported.
- New job options: `autoApprove` (`--auto`; without it, unattended runs reject permission requests) and `standalone` (`--standalone`).
- Jobs created under v1 keep their v1 command line until you run `migrate_jobs` (dry run first, then `confirm=true`). `list_jobs` marks them.
- The skill is registered automatically; `install_skill` now writes to `.opencode/skills/`.

## Examples

**Daily deal hunting:**
```
Schedule a daily job at 9am to search for standing desks under $300
```

**Weekly reports:**
```
Schedule a job every Monday at 8am to summarize my GitHub notifications
```

**Recurring reminders:**
```
Schedule a job every 6 hours to check if my website is up and alert me on Slack if it's down
```

## Commands

| Command | Example |
|---------|---------|
| Schedule a job | `Schedule a daily job at 9am to...` |
| List jobs | `Show my scheduled jobs` |
| Get version | `Show scheduler version` |
| Install skill template | `Install the scheduled job best practices skill` |
| Get job | `Show details for standing-desk` |
| Update job | `Update standing-desk to run at 10am` |
| Run immediately | `Run the standing-desk job now` |
| View logs | `Show logs for standing-desk` |
| Delete | `Delete the standing-desk job` |
| Global cleanup (dry run) | `Run scheduler global cleanup` |

## How It Works

1. You describe what you want scheduled in natural language
2. The plugin writes a job file (scoped by `workdir`) and installs a timer in your OS scheduler
3. At the scheduled time, the OS scheduler calls a small supervisor script
4. The supervisor runs the job, appends logs, and updates job metadata

You can also trigger a job immediately via `run_job`—it runs fire-and-forget and appends to the same log file.

Jobs run from the working directory where you created them, picking up your `opencode.json` and MCP configurations.

### Reliability Guarantees (Scheduled Runs)

- **No overlap**: if the previous run is still active, the next scheduled tick is skipped.
- **Non-interactive by default**: scheduled runs force `OPENCODE_PERMISSION` to deny "question" prompts, so jobs don't hang waiting for approvals.
- **Optional timeout**: set `timeoutSeconds` to hard-stop long runs (SIGTERM, then SIGKILL).

### Platform Support

| Platform | Scheduler backend | Notes |
|------|------|------|
| macOS | `launchd` | Full support (supervised scheduled runs) |
| Linux (systemd available) | `systemd --user` | Full support (supervised scheduled runs) |
| Linux / POSIX (no systemd) | `cron` (`crontab`) | Fallback backend (no missed-run catch-up) |
| Windows | `schtasks` (Task Scheduler) | Supervised scheduled runs via `supervisor.ps1`; cron subset mapping (see below) |

### Windows

- **Install**: clone the repo and point `plugins` at the folder, for example `{ "plugins": ["C:/Users/you/opencode-scheduler"] }` in `.opencode/opencode.json`. The GitHub spec (`github:alerios/opencode-scheduler`) is the alternative once `opencode plugin add` works on Windows (it failed in our Windows 11 test).
- **opencode path**: the task stores an absolute path to `opencode.exe`, found via `OPENCODE_SCHEDULER_OPENCODE_PATH`, then `where.exe opencode`, then the running OpenCode binary, then `%USERPROFILE%\.opencode\bin\opencode.exe` and `%LOCALAPPDATA%\Programs\opencode\opencode.exe`. If none is found, `schedule_job` fails and asks you to set `OPENCODE_SCHEDULER_OPENCODE_PATH` to the full path of `opencode.exe` (point it at the `.exe`, not an npm `.cmd` shim).
- **How runs work**: each task runs `powershell.exe ... -File %USERPROFILE%\.config\opencode\scheduler\supervisor.ps1 <job.json>`. Like the Perl supervisor on macOS/Linux, it runs the job in its `workdir` (with `PWD` set), skips a run while the previous one is still active, enforces `timeoutSeconds` (kills the process tree), and records the result. Tasks allow starting and continuing on battery and start late after a missed time.
- **Who and when**: tasks run as the logged-in user, and only while that user is logged on.
- **Logs**: use `job_logs`, or open `%USERPROFILE%\.config\opencode\logs\scheduler\<scopeId>\<slug>.log`. Run records are in `%USERPROFILE%\.config\opencode\scheduler\scopes\<scopeId>\runs\<slug>.jsonl`.
- **Cron limits**: unsupported combinations (for example, month + weekday constraints, or month-only without explicit day-of-month) return a clear error with guidance. Complex schedules may be expanded into several tasks under `\\OpenCode\\opencode-job-...`; `delete_job` removes all of them.
- Tasks created before this supervisor existed run the command directly. Run `update_job` (for example, set the same schedule again) to switch them to `supervisor.ps1`.

---

## Reference

### Cron Syntax

Jobs use standard 5-field cron expressions:

```
┌───────────── minute (0-59)
│ ┌───────────── hour (0-23)
│ │ ┌───────────── day of month (1-31)
│ │ │ ┌───────────── month (1-12)
│ │ │ │ ┌───────────── day of week (0-6, Sunday=0)
│ │ │ │ │
* * * * *
```

| Expression | Meaning |
|------------|---------|
| `0 9 * * *` | Daily at 9:00 AM |
| `0 */6 * * *` | Every 6 hours |
| `30 8 * * 1` | Mondays at 8:30 AM |
| `0 9,17 * * *` | At 9 AM and 5 PM daily |

### Tools

| Tool | Description |
|------|-------------|
| `schedule_job` | Create a new scheduled job |
| `list_jobs` | List all scheduled jobs |
| `get_version` | Show scheduler and opencode versions |
| `get_skill` | Get built-in skill templates (best practices) |
| `install_skill` | Install a built-in skill into your repo |
| `get_job` | Fetch job details and metadata |
| `update_job` | Update an existing job |
| `delete_job` | Remove a scheduled job |
| `cleanup_global` | Remove scheduler artifacts across all scopes (dry-run by default) |
| `run_job` | Execute a job immediately (fire-and-forget) |
| `job_logs` | View the latest logs from a job |

`schedule_job` and `update_job` accept an optional `timeoutSeconds` (integer seconds). Use `0` (or omit) to disable.

Tools accept an optional `format: "json"` argument to return structured output with `success`, `output`, `shouldContinue`, and `data`.

### Global Cleanup

Use `cleanup_global` to clean scheduler artifacts across all scopes. It always starts in dry-run mode unless you pass `confirm: true`.

- Dry run (safe default):

```json
{ "confirm": false }
```

- Execute global cleanup of job definitions + lock files + scheduler units:

```json
{ "confirm": true }
```

- Also delete logs and run history:

```json
{ "confirm": true, "includeHistory": true }
```

The tool reports exactly how many artifacts were removed, grouped by location (jobs, locks, logs, runs, launchd/systemd units).

### Storage

| What | Where |
|------|-------|
| Job configs (scoped) | `~/.config/opencode/scheduler/scopes/<scopeId>/jobs/*.json` |
| Run records (scoped) | `~/.config/opencode/scheduler/scopes/<scopeId>/runs/*.jsonl` |
| Locks (scoped) | `~/.config/opencode/scheduler/scopes/<scopeId>/locks/*.json` |
| Logs (scoped) | `~/.config/opencode/logs/scheduler/<scopeId>/*.log` |
| Supervisor script | `~/.config/opencode/scheduler/supervisor.pl` |
| launchd plists (Mac) | `~/Library/LaunchAgents/com.opencode.job.<scopeId>.*.plist` |
| systemd units (Linux) | `~/.config/systemd/user/opencode-job-<scopeId>-*.{service,timer}` |
| Task Scheduler entries (Windows) | `\\OpenCode\\opencode-job-<scopeId>-*` |

Legacy note: older versions stored jobs in `~/.config/opencode/jobs/*.json` and used unscoped unit names. `delete_job` removes both scoped and legacy artifacts.

### Working Directory

Jobs run from a specific directory to pick up MCP configs:

```
Schedule a daily job at 9am from /path/to/project to run my-task
```

By default, jobs use the directory where you created them.

### Scopes

Scopes are derived from the job's `workdir` (normalized absolute path). This isolates job storage, logs, and OS scheduler unit names per project.

- `list_jobs` defaults to the **current scope** (your current working directory).
- Use `allScopes: true` to list jobs across all scopes.
- Use `includeLegacy: true` to include pre-`v1.2.0` jobs stored in `~/.config/opencode/jobs`.

### Attach URL (optional)

If you have an OpenCode backend running via `opencode serve` or `opencode web`, you can set `attachUrl` on a job so runs use that backend:

```
Update the standing-desk job to use attachUrl http://localhost:4096
```

## Project Philosophy

- This plugin is intentionally a thin wrapper: it schedules `opencode run` via launchd/systemd/schtasks, with cron fallback when native backends are unavailable.
- Logs are the source of truth for scheduled runs: `~/.config/opencode/logs/*.log`.
- Resiliency/reporting roadmap (not implemented): `PRD-resilient-execution.md`.

### Built-in Skill Templates

To install the built-in skill into your project (no copy/paste), open OpenCode in your repo and run:

```
Install the scheduled job best practices skill
```

This calls the plugin’s `install_skill` tool and writes `.opencode/skills/scheduled-job-best-practices/SKILL.md`.

(If you prefer, you can also say: `Get skill from opencode-scheduler and add it to my skills`.)

Then add `@scheduled-job-best-practices` at the top of scheduled job prompts.

(Manual option: use `get_skill` to fetch `scheduled-job-best-practices` and copy it into `.opencode/skills/scheduled-job-best-practices/SKILL.md`.)

## Troubleshooting

**Jobs not running?**

1. Check if installed:
   - Mac: `launchctl list | grep opencode`
   - Linux: `systemctl --user list-timers | grep opencode`
   - Windows: `schtasks /Query /TN "\\OpenCode\\opencode-job-*"`

2. Check logs: `Show logs for my-job`

3. Verify the working directory has the right `opencode.json` with MCP configs

**MCP tools not available?**

Make sure the job's working directory contains an `opencode.json` with your MCP server configurations.

## License

MIT
