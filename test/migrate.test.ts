import { describe, expect, test } from "bun:test"
import { classifyJob, stripDroppableV1Fields } from "../src/migrate"

describe("classifyJob", () => {
  test("v2 snapshot is current", () => {
    expect(classifyJob({ slug: "a", invocation: { v: 2 }, run: { prompt: "p" } }).status).toBe("current")
  })

  test("v1 snapshot with a plain prompt is rebuilt", () => {
    const item = classifyJob({ slug: "a", invocation: {}, run: { prompt: "p", model: "m", variant: "high" } })
    expect(item).toEqual({ slug: "a", scopeId: undefined, status: "rebuild", reasons: ["saved command line uses v1 flags"] })
  })

  test("port and share are dropped automatically, with reasons", () => {
    const item = classifyJob({ slug: "a", run: { prompt: "p", port: 4096, share: true } })
    expect(item.status).toBe("rebuild")
    expect(item.reasons).toEqual([
      "saved command line uses v1 flags",
      "port will be removed (not supported by OpenCode v2)",
      "share will be removed (not supported by OpenCode v2)",
    ])
  })

  test("command jobs and variant-without-model need a manual edit", () => {
    expect(classifyJob({ slug: "c", run: { command: "review", arguments: "x" } }).status).toBe("manual")
    expect(classifyJob({ slug: "v", run: { prompt: "p", variant: "high" } }).status).toBe("manual")
  })

  test("legacy jobs with only a top-level prompt are rebuilt", () => {
    expect(classifyJob({ slug: "l", prompt: "p" }).status).toBe("rebuild")
  })
})

describe("stripDroppableV1Fields", () => {
  test("removes port and share, keeps the rest", () => {
    expect(stripDroppableV1Fields({ prompt: "p", port: 1, share: true, model: "m" })).toEqual({ prompt: "p", model: "m" })
  })
})
