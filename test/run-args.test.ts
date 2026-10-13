import { describe, expect, test } from "bun:test"
import { buildRunArgs, unsupportedV2Fields } from "../src/run-args"

describe("buildRunArgs (opencode v2)", () => {
  test("prompt only", () => {
    expect(buildRunArgs({ prompt: "check the site" })).toEqual(["run", "--", "check the site"])
  })

  test("maps every supported field in a stable order", () => {
    expect(
      buildRunArgs({
        prompt: "p",
        attachUrl: "http://127.0.0.1:4096",
        agent: "build",
        model: "anthropic/claude-sonnet-5-5",
        variant: "high",
        runFormat: "json",
        title: "t",
        continue: true,
        session: "ses_1",
        files: ["a.md", "b.md"],
        autoApprove: true,
      }),
    ).toEqual([
      "run",
      "--server", "http://127.0.0.1:4096",
      "--agent", "build",
      "--model", "anthropic/claude-sonnet-5-5#high",
      "--format", "json",
      "--title", "t",
      "--continue",
      "--session", "ses_1",
      "--file", "a.md",
      "--file", "b.md",
      "--auto",
      "--", "p",
    ])
  })

  test("standalone maps to --standalone and is ignored when a server URL is set", () => {
    expect(buildRunArgs({ prompt: "p", standalone: true })).toEqual(["run", "--standalone", "--", "p"])
    expect(buildRunArgs({ prompt: "p", standalone: true, attachUrl: "http://h:1" })).toEqual([
      "run", "--server", "http://h:1", "--", "p",
    ])
  })
})

describe("unsupportedV2Fields", () => {
  test("accepts a plain prompt job", () => {
    expect(unsupportedV2Fields({ prompt: "p", model: "m", variant: "v" })).toEqual([])
  })

  test("names each v1-only option and what to do instead", () => {
    const issues = unsupportedV2Fields({ prompt: "p", port: 4096, share: true, variant: "high" })
    expect(issues).toEqual([
      "port: OpenCode v2 has no --port; remove it (use attachUrl to target a running server)",
      "share: OpenCode v2 has no --share; remove it",
      "variant: OpenCode v2 needs a model for a variant (model#variant); set model too",
    ])
  })

  test("command is not available in v2 non-interactive runs", () => {
    expect(unsupportedV2Fields({ command: "review", arguments: "x" })).toEqual([
      "command: OpenCode v2 `run` has no --command; put the instruction in prompt instead",
    ])
  })
})
