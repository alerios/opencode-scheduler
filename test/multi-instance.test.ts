import { beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "fs"
import { homedir, tmpdir } from "os"
import { join } from "path"

// The v2 host runs several project instances in one process with the plugin module
// cached: each setup() must keep its own workspace scope (no module-level "last wins").

const projectA = mkdtempSync(join(tmpdir(), "sched-multi-a-"))
const projectB = mkdtempSync(join(tmpdir(), "sched-multi-b-"))

function fakeContext(directory: string, tools: any[]) {
  const registration = { dispose: async () => {} }
  return {
    location: { directory },
    tool: { transform: async (cb: any) => (cb({ add: (t: any) => tools.push(t) }), registration) },
    skill: { transform: async (cb: any) => (cb({ add: () => {} }), registration) },
    command: { transform: async (cb: any) => (cb({ add: () => {} }), registration) },
    session: { prompt: async () => {} },
  } as any
}

function writeJob(scopesDir: string, scopeId: string, slug: string, workdir: string) {
  const dir = join(scopesDir, scopeId, "jobs")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${slug}.json`),
    JSON.stringify({
      scopeId,
      slug,
      name: slug,
      schedule: "0 9 * * *",
      workdir,
      run: { prompt: "p" },
      createdAt: "2026-01-01T00:00:00.000Z",
      invocation: { command: "opencode", args: ["run", "--", "p"], v: 2 },
    }),
  )
}

const toolsA: any[] = []
const toolsB: any[] = []

beforeAll(async () => {
  if (!homedir().includes("sched-")) throw new Error(`HOME not isolated: ${homedir()}`)
  const index = await import("../src/index")
  const { scopesDir } = index.__testing.paths()
  if (!scopesDir.includes("sched-")) throw new Error(`scheduler dir not isolated: ${scopesDir}`)
  writeJob(scopesDir, index.__testing.deriveScopeId(projectA), "job-a", projectA)
  writeJob(scopesDir, index.__testing.deriveScopeId(projectB), "job-b", projectB)

  const plugin = (await import("../src/plugin")).default
  await plugin.setup(fakeContext(projectA, toolsA))
  await plugin.setup(fakeContext(projectB, toolsB))
})

async function listSlugs(tools: any[]): Promise<string[]> {
  const listJobs = tools.find((t) => t.name === "list_jobs")
  const out = JSON.parse((await listJobs.execute({ format: "json" }, {})).content)
  return out.data.jobs.map((j: any) => j.slug)
}

describe("per-instance workspace scope", () => {
  test("each plugin instance lists only its own project's jobs", async () => {
    expect(await listSlugs(toolsA)).toEqual(["job-a"])
    expect(await listSlugs(toolsB)).toEqual(["job-b"])
  })

  test("get_job resolves names in the instance's own scope", async () => {
    const getA = toolsA.find((t) => t.name === "get_job")
    const outA = JSON.parse((await getA.execute({ name: "job-a", format: "json" }, {})).content)
    expect(outA.success).toBe(true)
    const outMissing = JSON.parse((await getA.execute({ name: "job-b", format: "json" }, {})).content)
    expect(outMissing.success).toBe(false)
  })
})
