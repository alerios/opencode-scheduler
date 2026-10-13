export type OpencodeRunFormat = "default" | "json"

export interface JobRunSpec {
  prompt?: string
  command?: string
  arguments?: string

  files?: string[]
  agent?: string
  model?: string
  variant?: string
  title?: string
  share?: boolean
  continue?: boolean
  session?: string
  runFormat?: OpencodeRunFormat

  attachUrl?: string
  port?: number

  /** v2: pass --auto so unattended runs may use tools that ask for permission. */
  autoApprove?: boolean
  /** v2: pass --standalone (private server) instead of the managed background service. */
  standalone?: boolean
}

export function unsupportedV2Fields(run: JobRunSpec): string[] {
  const issues: string[] = []
  if (run.command) {
    issues.push("command: OpenCode v2 `run` has no --command; put the instruction in prompt instead")
  }
  if (run.port !== undefined) {
    issues.push("port: OpenCode v2 has no --port; remove it (use attachUrl to target a running server)")
  }
  if (run.share) {
    issues.push("share: OpenCode v2 has no --share; remove it")
  }
  if (run.variant && !run.model) {
    issues.push("variant: OpenCode v2 needs a model for a variant (model#variant); set model too")
  }
  return issues
}

export function buildRunArgs(run: JobRunSpec): string[] {
  const args = ["run"]
  if (run.attachUrl) args.push("--server", run.attachUrl)
  else if (run.standalone) args.push("--standalone")
  if (run.agent) args.push("--agent", run.agent)
  if (run.model) args.push("--model", run.variant ? `${run.model}#${run.variant}` : run.model)
  if (run.runFormat) args.push("--format", run.runFormat)
  if (run.title) args.push("--title", run.title)
  if (run.continue) args.push("--continue")
  if (run.session) args.push("--session", run.session)
  for (const file of run.files ?? []) args.push("--file", file)
  if (run.autoApprove) args.push("--auto")
  args.push("--", run.prompt ?? "")
  return args
}
