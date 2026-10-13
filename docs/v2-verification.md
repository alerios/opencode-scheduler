# Live verification on opencode v2.0.26

Host: `opencode v2.0.26` (`/home/arios/.opencode/bin/opencode`), systemd user instance healthy
(585 units loaded, 0 failed at test start). Scratch project: `/tmp/sched-v2` (fresh `git init`).
Plugin source under test: `/home/arios/Tech/ai-magic/opencode-scheduler-v2-wt` at commit `03958ab`.

`bun run build` was run first and produced `dist/plugin.js` (103.65 KB) cleanly with
`@opencode/plugin` and `effect` external.

## Step 1: Load through the `plugins` key (directory path)

```bash
mkdir -p .opencode && cat > .opencode/opencode.json <<'EOF'
{ "plugins": ["/home/arios/Tech/ai-magic/opencode-scheduler-v2-wt"] }
EOF
opencode plugin list
```

Output:

```
ID                  VERSION  SOURCE
-                   local    /home/arios/.config/opencode/plugins/superpowers.js
-                   -        opencode-chrome-devtools
-                   -        opencode-scheduler
opencode-scheduler  local    /home/arios/Tech/ai-magic/opencode-scheduler-v2-wt/server.ts
```

**Result: PASS.** `opencode-scheduler` is listed as active (ID and VERSION resolved), loaded from
`server.ts` at the repo root — **not** `dist/plugin.js`, even though `package.json` `main`/`exports`
point at `dist/plugin.js`. The directory-based plugin resolver picks up the `server.ts` entry
point at the repo root directly via Bun; `dist/` was not consulted for this load path. (The other
three unresolved rows are pre-existing, unrelated entries from the host's own global config/npm
cache — a broken `superpowers.js` plugin, a stale `opencode-chrome-devtools` npm plugin, and a
stale `opencode-scheduler@latest` npm plugin from the npm registry; none of these were touched or
created by this test and they are out of scope.) Confirmed again via `opencode serve --print-logs
--log-level debug`:
```
msg="loading plugin" id=/home/arios/Tech/ai-magic/opencode-scheduler-v2-wt entrypoint=file:///home/arios/Tech/ai-magic/opencode-scheduler-v2-wt/server.ts
```
with no accompanying "failed to load plugin" warning for our plugin (the three npm/global ones
each logged `failed to load plugin ... Plugin must export a default definition`, confirming those
are unrelated broken entries, not ours).

**Finding for future plugins (Workflows, Sources DB, AMM):** a directory-based `plugins` entry
resolves through the root-level `server.ts` re-export, not through the `package.json` `main`
field and not by requiring a built `dist/`. Future ported plugins should keep a thin `server.ts`
at the package root that re-exports the real entry (as this plugin already does), since that is
what the directory resolver actually loads — matching `package.json`'s `main` is not sufficient
on its own for this load path.

## Step 2: The legacy `plugin` key

Changed `.opencode/opencode.json` to `{ "plugin": [...] }` (singular key) and reran:

```bash
opencode plugin list
```

Output: identical to Step 1 — `opencode-scheduler` still listed as active, loaded from the same
`server.ts` path. Restored to `"plugins"` afterward (also reverified identical).

**Result: PASS.** The v1 `plugin` key is still accepted and converted to the v2 shape, consistent
with `core/src/config/normalize.ts` converting it internally.

## Step 3: Skill and command registered

Initial naive attempt:
```bash
opencode api skill.list | grep -c scheduled-job-best-practices   # => 0
opencode api command.list | grep -c '"jobs"'                      # => 0
```
Both came back 0. Diagnosis: `opencode api` with no `--standalone`/`--server` connects to the
**background service** rooted at whatever directory it was first started from (`/home/arios`, not
`/tmp/sched-v2` — visible via `"location":{"directory":"/home/arios"}` in the raw response), so it
never saw our project's plugin config at all. Re-running with `--standalone` fixed the directory
(`"location":{"directory":"/tmp/sched-v2"}`) but still returned `"data":[]` for both — a second,
separate issue: `ctx.skill.transform`/`ctx.command.transform` registrations are populated lazily,
on the first agent session in that server process, not at server boot. A one-shot `--standalone`
invocation of `opencode api` exits before any session has run, so the plugin's `setup()` transforms
never get exercised by that API call even though the plugin itself loaded successfully (confirmed
via `--print-logs --log-level all`: `loading plugin id=.../opencode-scheduler-v2-wt` with no
failure, but no skill/command transform activity logged at boot either).

Resolution: started a long-lived `opencode serve --port 4199` in `/tmp/sched-v2`, ran one
`opencode run --server http://127.0.0.1:4199 ...` against it (Step 4's command), then re-queried:

```bash
OPENCODE_PASSWORD=<pw> opencode api --server http://127.0.0.1:4199 skill.list | grep -c scheduled-job-best-practices
# => 1
OPENCODE_PASSWORD=<pw> opencode api --server http://127.0.0.1:4199 command.list
# => {"location":{"directory":"/tmp/sched-v2"},"data":[...,{"name":"jobs","description":"Show the scheduled jobs for this workspace"}]}
```

**Result: PASS** (both counts ≥ 1), but only after a session ran in that server process.

**Finding for future plugins:** `skill.list`/`command.list` reflect a plugin's registrations only
after the plugin's `setup()` transforms have actually executed in that server process's lifetime,
which happens lazily on first session activity rather than eagerly on server boot. `opencode plugin
list` (loaded vs failed) is a separate, earlier-available signal and should not be conflated with
skill/command registration being live yet. Also: bare `opencode api ...` with no `--server`/
`--standalone` talks to whatever directory the long-running background service happened to start
in, not your current `cwd` — always pass `--standalone` or `--server <url>` explicitly when
testing a project-scoped plugin via `opencode api`.

## Step 4: Tools are direct tools and the workdir is the project

```bash
opencode run --server http://127.0.0.1:4199 --format json --auto \
  "Use the list_jobs tool with format json and show me the raw result."
```

Output (relevant `tool_use` event):

```json
{"type":"tool_use", ... "part":{..."tool":"list_jobs","state":{"status":"completed","input":{"format":"json"},"output":"{\n  \"success\": true,\n  \"output\": \"No scheduled jobs yet....\",\n  \"shouldContinue\": false,\n  \"data\": {\n    \"jobs\": []\n  }\n}", ...}}}
```

Scope check: after creating a job (Step 5), `~/.config/opencode/scheduler/scopes/` contained
`sched-v2-3f76f23048cb` — a scope id derived from `/tmp/sched-v2`, not the service's own directory.

**Result: PASS.** `list_jobs` runs as a direct tool with `state.status: "completed"`, and the scope
id is correctly derived from the project directory the session ran against, not from wherever the
background service process happened to start.

## Step 5: A real scheduled run under systemd

```bash
opencode run --server http://127.0.0.1:4199 --auto \
  "Use schedule_job to create a job named pong-check with schedule '*/2 * * * *' and prompt 'Reply with exactly: PONG', autoApprove true, standalone true."
```

Response text: *"I created the `pong-check` job. ... It's using the cron platform, working
directory `/tmp/sched-v2`."* — **not systemd**, despite `systemctl --user show-environment`
succeeding directly and the host having a healthy systemd user instance.

Server log captured the real cause:
```
Created symlink .../timers.target.wants/opencode-job-sched-v2-3f76f23048cb-pong-check.timer → ...
Failed to start opencode-job-sched-v2-3f76f23048cb-pong-check.timer: Unit opencode-job-sched-v2-3f76f23048cb-pong-check.timer has a bad unit file setting.
```
and `journalctl --user -u opencode-job-sched-v2-3f76f23048cb-pong-check.timer`:
```
.../opencode-job-....timer:5: Failed to parse calendar specification, ignoring: * *-*-* *:00:00
... (one such line per generated OnCalendar entry) ...
opencode-job-....timer: Timer unit lacks value setting. Refusing.
```

Root cause (confirmed with `systemd-analyze calendar`):
```bash
$ systemd-analyze calendar "* *-*-* *:00:00"
Failed to parse calendar specification '* *-*-* *:00:00': Invalid argument
$ systemd-analyze calendar "*-*-* *:00:00"
Normalized form: *-*-* *:00:00     # valid
```
`cronToSystemdCalendars()` in `src/index.ts` (around line 606) always prefixes the generated
calendar string with a day-of-week token even when it is the wildcard `"*"`:
```ts
calendars.push(`${dowValue} *-${monthValue}-${domValue} ${hourValue}:${minuteValue}:00`)
```
producing `"* *-*-* *:00:00"` for any schedule without an explicit weekday (i.e. nearly every
cron expression a user would type, including this test's `*/2 * * * *`). systemd rejects the
redundant leading `"*"` + date-spec combination as a bad unit file setting, so **every** generated
systemd timer with a wildcard day-of-week is broken on this host/systemd version. This is a real,
reproducible bug in the plugin's own cron→systemd translation — not an opencode v2 API
incompatibility — so per the task brief's guidance this is recorded as a FAIL with full diagnosis
rather than treated as BLOCKED.

`installJob()`'s fallback logic correctly caught the `installSystemdJob` failure (since `cron` was
available) and fell back to cron automatically, so the job was still installed and still ran for
real:

```bash
crontab -l
# */2 * * * * PATH=... /usr/bin/perl ".../supervisor.pl" ".../jobs/pong-check.json" >> ".../pong-check.log" 2>&1
```

After waiting for a tick:
```
=== Scheduled run 2026-10-12T20:32:01-0500 runId=1791855121.07122-104162903 ===
PONG
=== Finished 2026-10-12T20:32:04-0500 status=success exitCode=0 durationMs=3257 ===
```
JSONL: `{"status":"success","exitCode":0,...}`. Job JSON `invocation.v: 2`.

**Result: FAIL (systemd timer creation) / PASS (end-to-end scheduled run via automatic cron
fallback).** The timer was *not* listed in `systemctl --user list-timers` (it never started), so
the brief's literal "timer is listed" expectation fails. However the job still ran for real on
schedule, with the expected log marker, `PONG` output, `"status":"success"`, and `"v": 2` — just
via cron instead of systemd, due to the bug above. **This is the single most important concern
from this verification run** and should block merging Task 5/6 as "done" for Linux systemd users
until `cronToSystemdCalendars()` drops the leading `"*"`/weekday token whenever `dowValue === "*"`
(or otherwise emits `*-MM-DD HH:MM:00` instead of `* *-MM-DD HH:MM:00`).

## Step 6: Service mode

```bash
opencode run --server http://127.0.0.1:4199 --auto "Use update_job to set pong-check standalone to false."
opencode service stop
```
`opencode service status` → `stopped`. Waited for the next cron tick (job's `invocation.args` no
longer included `--standalone`, confirming `update_job` took effect):

```
=== Scheduled run 2026-10-12T20:34:01-0500 runId=1791855241.36986-428684486 ===
PONG
=== Finished 2026-10-12T20:34:04-0500 status=success exitCode=0 durationMs=2763 ===
```
`opencode service status` afterward → back to a live URL (`http://127.0.0.1:49374`), i.e. the
scheduled run itself restarted the background service.

**Result: PASS.** The scheduled run succeeded even with the background service stopped
beforehand, and the service was running again afterward — consistent with `run` starting the
service through `Service.ensure` as the v2 source describes.

## Step 7: Migration on a real v1 job

Hand-wrote `~/.config/opencode/scheduler/scopes/sched-v2-3f76f23048cb/jobs/v1-legacy-job.json`
with a v1-shaped invocation and no `v` field:
```json
"run": {"prompt": "hi", "model": "ollama/qwen2.5-coder:7b", "variant": "high"},
"invocation": {"command": "/home/arios/.opencode/bin/opencode", "args": ["run","--variant","high","--","hi"]}
```

Dry run:
```bash
opencode run --server http://127.0.0.1:4199 --format json --auto "Use migrate_jobs with dryRun true and show the raw result."
```
```
"output":"Dry run (pass confirm=true to apply):\nREBUILD sched-v2-3f76f23048cb/v1-legacy-job: saved command line uses v1 flags"
```

Applied:
```bash
opencode run --server http://127.0.0.1:4199 --format json --auto "Use migrate_jobs with confirm true and show the raw result."
```
```json
{"success":true,"output":"Applied 1 rebuild(s).\nREBUILD sched-v2-3f76f23048cb/v1-legacy-job: saved command line uses v1 flags","data":{"items":[{"slug":"pong-check","status":"current","reasons":[]},{"slug":"v1-legacy-job","status":"rebuild","reasons":["saved command line uses v1 flags"]}],"applied":1}}
```

Resulting job JSON:
```json
"invocation": {
  "command": "/home/arios/.opencode/bin/opencode",
  "args": ["run", "--model", "ollama/qwen2.5-coder:7b#high", "--", "hi"],
  "v": 2
}
```

**Result: PASS.** The dry run correctly flagged only the v1 job (`pong-check` was already
`"status":"current"`), and applying it rebuilt the invocation to `--model
ollama/qwen2.5-coder:7b#high` with `"v": 2`, exactly per the `variant` → `#high` suffix convention.
The hand-written test job file was deleted after this step (not part of the `pong-check`/
`sched-v2-*` cleanup scope, but created and removed entirely within it).

## Step 8: Clean up

```bash
opencode run --server http://127.0.0.1:4199 --auto "Use delete_job to delete pong-check."
systemctl --user list-timers | grep -c opencode-job-sched-v2 || true
```
Output: `The scheduled job "pong-check" has been deleted.` / timer count: `0`. Also confirmed
`crontab -l` is empty again and no stray `opencode-job-*sched-v2*` units remain under
`~/.config/systemd/user/`.

**Result: PASS.**

## Summary

| Step | Result |
|---|---|
| 1. Load via `plugins` (directory) | PASS |
| 2. Legacy `plugin` key | PASS |
| 3. Skill and command registered | PASS (only after a session runs in-process; see finding) |
| 4. Direct tools, correct workdir/scope | PASS |
| 5. Real scheduled run under systemd | **FAIL** for systemd specifically (bad `OnCalendar` generation); PASS for the job actually running, via automatic cron fallback |
| 6. Service mode | PASS |
| 7. Migration on a real v1 job | PASS |
| 8. Clean up | PASS |

8 of 9 explicit step expectations pass; Step 5's systemd-timer-creation sub-expectation fails due
to a reproducible bug in `cronToSystemdCalendars()` (`src/index.ts`, ~line 606): it emits
`"${dowValue} *-${month}-${day} ${hour}:${minute}:00"` even when `dowValue` is the wildcard `"*"`,
which systemd on this host rejects as a bad calendar specification for every such timer. Recommend
filing this as a follow-up bug fix before relying on systemd scheduling in production on this
platform; cron remains a working fallback in the meantime.

## ctx.mcp.transform with headers

Spike (Task 7, throwaway; not part of the scheduler plugin): proves the `ctx.mcp.transform` /
`editor.set` API registers a remote MCP server with a bearer `Authorization` header, which is
exactly how the Workflows, Sources DB and AMM plugins will register their MCP servers. Verified
against a real bearer-protected MCP server: the AMM repo's own `pnpm mcp-server`
(`ai-money-magic` repo, `src/server/mcp-server.ts`), not a mock.

Target server: `cd ai-money-magic && LOCAL_MCP_KEY=spike-test-key MCP_PORT=8787 pnpm mcp-server`
→ `ai-money-magic MCP server listening on http://localhost:8787/mcp`. (One pre-existing
environment issue, unrelated to this spike, had to be fixed first: the AMM repo's local
`node_modules` was missing an `esbuild` symlink that `package.json`/the lockfile already declared;
`pnpm install --frozen-lockfile` fixed it without touching the lockfile — confirmed via `git diff
pnpm-lock.yaml` showing no change.)

Spike plugin written at `/tmp/sched-v2/.opencode/plugins/mcp-spike/index.ts`:

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "mcp-spike",
  async setup(ctx) {
    await ctx.mcp.transform((editor) => {
      editor.set("amm-spike", {
        type: "remote",
        url: "http://127.0.0.1:8787/mcp",
        headers: { Authorization: "Bearer spike-test-key" },
      })
    })
  },
})
```

This matched the brief's guessed shape exactly — confirmed by reading the real types rather than
trusting the guess: `MCPEditor.set(name, config: Mcp.ServerConfig)` in
`/home/arios/Tech/ai-tools/opencode/packages/plugin/src/promise/mcp.ts:9`, and
`Mcp.ServerConfig`'s remote variant in `/home/arios/Tech/ai-tools/opencode/packages/schema/src/mcp.ts:54-56`:
```
type: Schema.Literal("remote"),
url: Schema.String,
headers: Schema.Record(Schema.String, Schema.String).pipe(optional),
```
No shape mismatch, no typecheck/load failure.

As in Task 6, a bare `opencode api` talks to the host's long-running background service rooted at
`/home/arios`, not `/tmp/sched-v2` — so this test used a dedicated `opencode serve --port 4199` run
from `/tmp/sched-v2`, with `OPENCODE_PASSWORD` from its startup banner, and `opencode api`/`opencode
run --server http://127.0.0.1:4199 ...` for every call, same as Task 6's resolution for this issue.

**Correct key:** after `opencode reload` and one `opencode run --server ... --auto "List the tools
available from the amm-spike MCP server."` session (mcp.list only populates after a session has
run, same finding as Task 6 Step 3), `opencode api mcp.list --server http://127.0.0.1:4199` showed:
```json
{"name":"amm-spike","status":{"status":"connected"},"integrationID":"mcp_bc16a90e3907ae0d"}
```
The run session's tool catalog (via the Code Mode `search`/`execute` tools; `tools.opencode.list_mcp_tools`
does not exist in this host version) listed 25 AMM tools under `amm-spike`, including
`collect_keyword_data`, confirming the connection surfaced real AMM tools, not just a stub
connection.

**Wrong key (proves the header is actually sent, not just accepted locally):** changed the plugin's
header to `Authorization: "Bearer wrong-key"`, `opencode reload`, and `mcp.list` immediately
flipped to:
```json
{"name":"amm-spike","status":{"status":"needs_auth","error":"MCP server \"http://127.0.0.1:8787/mcp\" requires a login before it can register a client"}}
```
This matches the AMM server's own bearer check (`checkBearerToken` in `src/server/auth.ts`, called
from `src/server/mcp-server.ts:305`), which returns 401 for a non-matching key. Reverting the header
back to `Bearer spike-test-key` and reloading flipped `amm-spike` back to `"status":"connected"`
immediately, confirming the state change tracks the header value, not a cache or a fluke.

**Result: PASS.** `ctx.mcp.transform` / `editor.set("name", { type: "remote", url, headers })` is a
working, confirmed mechanism for registering a remote MCP server with bearer auth, with the header
demonstrably read and enforced by a real downstream server — this is safe for the Workflows,
Sources DB and AMM plugins to use as designed, with no shape surprises against the brief's assumed
API.

Cleanup: the `ai-money-magic` pre-existing dirty `git status` (unrelated in-progress doc edits, not
touched by this spike) was unchanged before/after; `pnpm-lock.yaml` diff was empty; the AMM
`pnpm mcp-server` process and the standalone `opencode serve --port 4199` were both killed; the
spike plugin directory `/tmp/sched-v2/.opencode/plugins/mcp-spike/` was removed.
