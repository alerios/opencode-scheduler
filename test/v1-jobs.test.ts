import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs"
import { homedir, tmpdir } from "os"
import { join } from "path"

// Saved v1 jobs (port, share, command, variant-without-model) must stay visible to
// list_jobs / get_job / migrate_jobs even though they can no longer be BUILT for v2.

const project = mkdtempSync(join(tmpdir(), "sched-v1jobs-project-"))
let index: typeof import("../src/index")
let tools: Record<string, any>
let scopeId: string
let paths: { scopesDir: string; legacyJobsDir: string; supervisorPath: string }

const v1Runs: Record<string, Record<string, unknown>> = {
  "v1-plain": { prompt: "say hi" },
  "v1-port": { prompt: "say hi", port: 4096 },
  "v1-share": { prompt: "say hi", share: true },
  "v1-command": { command: "review", arguments: "x" },
  "v1-variant": { prompt: "say hi", variant: "high" },
}

const expected: Record<string, string> = {
  "v1-plain": "rebuild",
  "v1-port": "rebuild",
  "v1-share": "rebuild",
  "v1-command": "manual",
  "v1-variant": "manual",
}

function readJob(slug: string): any {
  return JSON.parse(readFileSync(join(paths.scopesDir, scopeId, "jobs", `${slug}.json`), "utf-8"))
}

// Keep unit tests hermetic: findOpencode() would otherwise shell out to `command -v opencode`.
const savedOpencodePath = process.env.OPENCODE_SCHEDULER_OPENCODE_PATH
afterAll(() => {
  if (savedOpencodePath === undefined) delete process.env.OPENCODE_SCHEDULER_OPENCODE_PATH
  else process.env.OPENCODE_SCHEDULER_OPENCODE_PATH = savedOpencodePath
})

beforeAll(async () => {
  process.env.OPENCODE_SCHEDULER_OPENCODE_PATH = "/usr/local/bin/opencode-test-stub"
  if (!homedir().includes("sched-")) throw new Error(`HOME not isolated: ${homedir()}`)
  index = await import("../src/index")
  paths = index.__testing.paths()
  if (!paths.scopesDir.includes("sched-")) throw new Error(`scheduler dir not isolated: ${paths.scopesDir}`)
  scopeId = index.__testing.deriveScopeId(project)
  const jobsDir = join(paths.scopesDir, scopeId, "jobs")
  mkdirSync(jobsDir, { recursive: true })
  for (const [slug, run] of Object.entries(v1Runs)) {
    writeFileSync(
      join(jobsDir, `${slug}.json`),
      JSON.stringify({
        scopeId,
        slug,
        name: slug,
        schedule: "0 9 * * *",
        workdir: project,
        run,
        createdAt: "2026-01-01T00:00:00.000Z",
        invocation: { command: "/usr/bin/opencode", args: ["run", "--port", "4096", "say hi"] },
      }),
    )
  }
  tools = index.buildTools(project)
})

describe("saved v1 jobs stay loadable", () => {
  test("list_jobs (allScopes) shows all five v1 shapes as needing migration", async () => {
    const out = JSON.parse(await tools.list_jobs.execute({ allScopes: true, format: "json" }))
    const mine = out.data.jobs.filter((j: any) => j.scopeId === scopeId)
    const slugs = mine.map((j: any) => j.slug).sort()
    expect(slugs).toEqual(Object.keys(v1Runs).sort())
    for (const j of mine) expect(j.needsMigration).toBe(true)
  })

  test("get_job finds each of them", async () => {
    for (const slug of Object.keys(v1Runs)) {
      const out = JSON.parse(await tools.get_job.execute({ name: slug, format: "json" }))
      expect(out.success).toBe(true)
      expect(out.data.job.slug).toBe(slug)
    }
  })

  test("dry-run migrate_jobs classifies each one", async () => {
    const out = JSON.parse(await tools.migrate_jobs.execute({ format: "json" }))
    const bySlug = Object.fromEntries(out.data.items.filter((i: any) => i.scopeId === scopeId).map((i: any) => [i.slug, i.status]))
    expect(bySlug).toEqual(expected)
    // dry run changes nothing
    expect(readJob("v1-port").invocation.v).toBeUndefined()
  })

  test("update_job still refuses to BUILD a v1-only field", async () => {
    const out = JSON.parse(await tools.update_job.execute({ name: "v1-plain", port: 4096, format: "json" }))
    expect(out.success).toBe(false)
    expect(out.output).toContain("port")
  })

  test("migrate_jobs confirm=true rebuilds port/share jobs, refreshes supervisor.pl, leaves manual ones", async () => {
    writeFileSync(paths.supervisorPath, "# stale v1 supervisor\n")
    const out = JSON.parse(await tools.migrate_jobs.execute({ confirm: true, format: "json" }))
    expect(out.data.applied).toBeGreaterThanOrEqual(3)
    for (const slug of ["v1-plain", "v1-port", "v1-share"]) {
      const job = readJob(slug)
      expect(job.invocation.v).toBe(2)
      expect(job.run.port).toBeUndefined()
      expect(job.run.share).toBeUndefined()
    }
    expect(readJob("v1-command").invocation.v).toBeUndefined()
    expect(readJob("v1-variant").invocation.v).toBeUndefined()
    expect(readFileSync(paths.supervisorPath, "utf-8")).not.toContain("stale v1 supervisor")
  })

  test("migrate_jobs reports an ERROR for a broken job and keeps going", async () => {
    const jobsDir = join(paths.scopesDir, scopeId, "jobs")
    // neither run nor prompt: classify says rebuild, getJobRun throws
    writeFileSync(
      join(jobsDir, "aa-broken.json"),
      JSON.stringify({ scopeId, slug: "aa-broken", name: "aa-broken", schedule: "0 9 * * *", workdir: project }),
    )
    writeFileSync(
      join(jobsDir, "zz-good.json"),
      JSON.stringify({ scopeId, slug: "zz-good", name: "zz-good", schedule: "0 9 * * *", workdir: project, run: { prompt: "p" } }),
    )
    const out = JSON.parse(await tools.migrate_jobs.execute({ confirm: true, format: "json" }))
    expect(out.success).toBe(true)
    expect(out.output).toContain("ERROR")
    expect(readJob("zz-good").invocation.v).toBe(2)
  })
})
