import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { spawnSync } from "child_process"
import { SUPERVISOR_SCRIPT } from "../src/supervisor"

describe("supervisor (perl)", () => {
  test("runs the invocation in workdir with PWD set, records success", () => {
    const home = mkdtempSync(join(tmpdir(), "sched-home-"))
    const workdir = mkdtempSync(join(tmpdir(), "sched-work-"))
    const scopeId = "test-scope"
    const slug = "pwd-check"

    const fake = join(home, "fake-opencode.sh")
    writeFileSync(fake, '#!/bin/sh\necho "PWD=$PWD"\necho "ARGS=$*"\n')
    chmodSync(fake, 0o755)

    const jobsDir = join(home, ".config/opencode/scheduler/scopes", scopeId, "jobs")
    mkdirSync(jobsDir, { recursive: true })
    const jobPath = join(jobsDir, `${slug}.json`)
    writeFileSync(
      jobPath,
      JSON.stringify({
        scopeId, slug, name: slug, schedule: "* * * * *", workdir,
        createdAt: new Date().toISOString(),
        invocation: { command: fake, args: ["run", "--", "hello"], v: 2 },
      }),
    )
    const supervisor = join(home, "supervisor.pl")
    writeFileSync(supervisor, SUPERVISOR_SCRIPT)

    const result = spawnSync("/usr/bin/perl", [supervisor, jobPath], {
      env: { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin", PWD: "/" },
    })
    expect(result.status).toBe(0)

    const log = readFileSync(join(home, ".config/opencode/logs/scheduler", scopeId, `${slug}.log`), "utf8")
    expect(log).toContain(`PWD=${workdir}`)
    expect(log).toContain("ARGS=run -- hello")

    const job = JSON.parse(readFileSync(jobPath, "utf8"))
    expect(job.lastRunStatus).toBe("success")
    expect(job.invocation.v).toBe(2)
  })
})
