/**
 * Minimal stand-in for the v1 `tool()` helper from @opencode-ai/plugin.
 * v1 used zod shapes; the v2 host accepts plain JSON Schema for tool input,
 * so this builder keeps the existing tool definitions nearly unchanged.
 */
export type JsonSchema = { [key: string]: unknown }

export class Field {
  constructor(
    readonly schema: JsonSchema,
    readonly isOptional = false,
  ) {}

  optional(): Field {
    return new Field(this.schema, true)
  }

  describe(description: string): Field {
    return new Field({ ...this.schema, description }, this.isOptional)
  }
}

const schema = {
  string: () => new Field({ type: "string" }),
  number: () => new Field({ type: "number" }),
  boolean: () => new Field({ type: "boolean" }),
}

export interface ToolSpec {
  description: string
  args: Record<string, Field>
  execute: (args: any) => Promise<string>
}

export function tool(spec: ToolSpec): ToolSpec {
  return spec
}
tool.schema = schema

export function toInputSchema(args: Record<string, Field>): JsonSchema {
  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  for (const [key, field] of Object.entries(args)) {
    properties[key] = field.schema
    if (!field.isOptional) required.push(key)
  }
  return { type: "object", properties, required, additionalProperties: false }
}
