import { unsupportedV2Fields, type JobRunSpec } from "./run-args"

export type MigrationStatus = "current" | "rebuild" | "manual"

export interface MigrationItem {
  slug: string
  scopeId?: string
  status: MigrationStatus
  reasons: string[]
}

type MigratableJob = {
  slug: string
  scopeId?: string
  invocation?: { v?: number }
  run?: JobRunSpec
  prompt?: string
}

export function stripDroppableV1Fields(run: JobRunSpec): JobRunSpec {
  const { port: _port, share: _share, ...rest } = run
  return rest
}

export function classifyJob(job: MigratableJob): MigrationItem {
  const base = { slug: job.slug, scopeId: job.scopeId }
  if (job.invocation?.v === 2) return { ...base, status: "current", reasons: [] }

  const run: JobRunSpec = job.run ?? { prompt: job.prompt }
  const reasons = ["saved command line uses v1 flags"]
  if (run.port !== undefined) reasons.push("port will be removed (not supported by OpenCode v2)")
  if (run.share) reasons.push("share will be removed (not supported by OpenCode v2)")

  const blocking = unsupportedV2Fields(stripDroppableV1Fields(run))
  if (blocking.length) return { ...base, status: "manual", reasons: [...reasons, ...blocking] }
  return { ...base, status: "rebuild", reasons }
}
