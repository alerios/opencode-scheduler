import { describe, expect, test } from "bun:test"
import { tool, toInputSchema } from "../src/v2-tool"

describe("v2 tool schema builder", () => {
  test("builds JSON Schema with required and optional fields", () => {
    const args = {
      name: tool.schema.string().describe("Job name"),
      lines: tool.schema.number().optional().describe("Tail lines"),
      confirm: tool.schema.boolean().optional(),
    }
    expect(toInputSchema(args)).toEqual({
      type: "object",
      properties: {
        name: { type: "string", description: "Job name" },
        lines: { type: "number", description: "Tail lines" },
        confirm: { type: "boolean" },
      },
      required: ["name"],
      additionalProperties: false,
    })
  })

  test("describe before optional keeps both", () => {
    const field = tool.schema.string().describe("x").optional()
    expect(field.isOptional).toBe(true)
    expect(field.schema).toEqual({ type: "string", description: "x" })
  })

  test("tool() returns the spec unchanged", () => {
    const spec = { description: "d", args: {}, execute: async () => "ok" }
    expect(tool(spec)).toBe(spec)
  })
})
