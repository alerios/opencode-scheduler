import { Plugin, Skill } from "@opencode/plugin"
import { buildTools, builtinSkillsForRegistration, setDefaultWorkdir } from "./index"
import { toInputSchema } from "./v2-tool"

export default Plugin.define({
  id: "opencode-scheduler",
  async setup(ctx) {
    setDefaultWorkdir(String(ctx.location.directory))

    const tools = buildTools()
    await ctx.tool.transform((editor) => {
      for (const [name, spec] of Object.entries(tools)) {
        editor.add({
          name,
          description: spec.description,
          input: toInputSchema(spec.args),
          options: { codemode: false },
          async execute(input) {
            return { content: await spec.execute((input ?? {}) as Record<string, unknown>) }
          },
        })
      }
    })

    await ctx.skill.transform((editor) => {
      for (const skill of builtinSkillsForRegistration()) {
        editor.add({
          id: Skill.ID.make(skill.id),
          name: Skill.Name.make(skill.name),
          description: skill.description,
          path: `/builtin/opencode-scheduler/${skill.id}/SKILL.md` as Skill.Info["path"],
          content: skill.content,
        })
      }
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "jobs",
        description: "Show the scheduled jobs for this workspace",
        async execute(input) {
          await ctx.session.prompt({
            sessionID: input.sessionID,
            text: "Use the list_jobs tool to show my scheduled jobs for this workspace, then summarize schedule, last run and status for each.",
            delivery: input.delivery,
          })
        },
      })
    })
  },
})
