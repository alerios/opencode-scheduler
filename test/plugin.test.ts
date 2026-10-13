import { beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const project = mkdtempSync(join(tmpdir(), "sched-plugin-project-"))

type Captured = { tools: any[]; skills: any[]; commands: any[]; prompts: any[] }
const captured: Captured = { tools: [], skills: [], commands: [], prompts: [] }
const registration = { dispose: async () => {} }

function fakeContext() {
  return {
    location: { directory: project },
    tool: { transform: async (cb: any) => (cb({ add: (t: any) => captured.tools.push(t) }), registration) },
    skill: { transform: async (cb: any) => (cb({ add: (s: any) => captured.skills.push(s) }), registration) },
    command: { transform: async (cb: any) => (cb({ add: (c: any) => captured.commands.push(c) }), registration) },
    session: { prompt: async (input: any) => void captured.prompts.push(input) },
  } as any
}

let plugin: any
beforeAll(async () => {
  // Fail fast, before importing the plugin (which computes config paths from
  // homedir() at module load), if the HOME-isolation preload didn't take
  // effect — otherwise src/index.ts's module-level homedir() calls would
  // resolve to the real ~/.config/opencode and write into it.
  // Bun caches os.homedir() after its first call, so another test file may already
  // have fixed it to the preload's temp HOME; require that, not a per-file HOME.
  const { homedir } = await import("os")
  if (!homedir().startsWith(tmpdir()) || !homedir().includes("sched-")) {
    throw new Error(
      `HOME isolation preload did not take effect: homedir() is "${homedir()}". ` +
        `Refusing to import the plugin to avoid writing into the real home directory.`,
    )
  }
  plugin = (await import("../src/plugin")).default
  await plugin.setup(fakeContext())
})

describe("v2 plugin entry", () => {
  test("test HOME is isolated (never touch the real ~/.config/opencode)", async () => {
    const { homedir } = await import("os")
    expect(homedir().startsWith(tmpdir())).toBe(true)
    expect(homedir()).toContain("sched-")
  })

  test("default export is a v2 definition", () => {
    expect(plugin.id).toBe("opencode-scheduler")
    expect(typeof plugin.setup).toBe("function")
  })

  test("registers all 12 tools as direct tools with JSON Schema input", () => {
    expect(captured.tools.map((t) => t.name).sort()).toEqual(
      [
        "cleanup_global", "delete_job", "get_job", "get_skill", "get_version", "install_skill",
        "job_logs", "list_jobs", "migrate_jobs", "run_job", "schedule_job", "update_job",
      ].sort(),
    )
    for (const t of captured.tools) {
      expect(t.options).toEqual({ codemode: false })
      expect(t.input.type).toBe("object")
      expect(t.input.additionalProperties).toBe(false)
    }
  })

  test("list_jobs runs and returns { content } scoped to the plugin location", async () => {
    const listJobs = captured.tools.find((t) => t.name === "list_jobs")
    const result = await listJobs.execute({ format: "json" }, {})
    expect(typeof result.content).toBe("string")
    expect(JSON.parse(result.content).success).toBe(true)
  })

  test("registers the best-practices skill and the /jobs command", async () => {
    expect(captured.skills.map((s) => String(s.id))).toEqual(["scheduled-job-best-practices"])
    expect(captured.skills[0].content).toContain("scheduled")
    // Review Focus 4: unattended runs reject permission requests unless autoApprove (--auto).
    expect(captured.skills[0].content).toContain("autoApprove")
    expect(captured.skills[0].content).toContain("--auto")
    expect(captured.skills[0].content).toContain("standalone")
    expect(captured.commands.map((c) => c.name)).toEqual(["jobs"])
    await captured.commands[0].execute({ sessionID: "ses_1", prompt: { text: "" }, delivery: "queue" })
    expect(captured.prompts[0].sessionID).toBe("ses_1")
    expect(captured.prompts[0].text).toContain("list_jobs")
  })
})
