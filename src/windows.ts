/**
 * Pure helpers for the Windows Task Scheduler (schtasks) backend.
 *
 * Everything here is side-effect free so it can be unit tested on Linux/macOS;
 * src/index.ts does the actual process spawning.
 */
import { win32 } from "path"

/** schtasks.exe rejects a /TR value longer than this. */
export const WINDOWS_TR_MAX = 261

export const WINDOWS_OPENCODE_NOT_FOUND =
  "Could not find opencode.exe (not in a PATH folder, not the current process, and not in " +
  "%USERPROFILE%\\.opencode\\bin or %LOCALAPPDATA%\\Programs\\opencode). Scheduled tasks need an absolute path: " +
  "set OPENCODE_SCHEDULER_OPENCODE_PATH to the full path of opencode.exe and try again."

export interface WindowsOpencodeProbe {
  /** OPENCODE_SCHEDULER_OPENCODE_PATH */
  override?: string
  /** OPENCODE_SCHEDULER_ALLOW_CMD_SHIM=1: accept a .cmd/.bat override (test probes only) */
  allowCmdShim?: boolean
  /** %PATH% (";"-separated) */
  pathEnv?: string
  /** process.execPath */
  execPath?: string
  /** %USERPROFILE% */
  userProfile?: string
  /** %LOCALAPPDATA% */
  localAppData?: string
  exists: (path: string) => boolean
}

/** Drive-absolute (C:\x) or UNC (\\server\share). path.win32.isAbsolute also accepts "\x" (current drive). */
export function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]/.test(value)
}

/**
 * Resolve an absolute opencode path for a Windows scheduled task.
 * Returns null when nothing is found (callers must fail clearly, not store a bare name:
 * Task Scheduler does not resolve a bare `opencode` the way an interactive shell does).
 * Throws when OPENCODE_SCHEDULER_OPENCODE_PATH is set but unusable.
 */
export function resolveWindowsOpencode(probe: WindowsOpencodeProbe): string | null {
  const override = probe.override?.trim()
  if (override) {
    if (!isWindowsAbsolutePath(override)) {
      throw new Error(`OPENCODE_SCHEDULER_OPENCODE_PATH must be an absolute path to opencode.exe (got "${override}").`)
    }
    if (!probe.exists(override)) {
      throw new Error(`OPENCODE_SCHEDULER_OPENCODE_PATH points to a file that does not exist: ${override}`)
    }
    if (/\.(cmd|bat)$/i.test(override) && !probe.allowCmdShim) {
      throw new Error(
        `OPENCODE_SCHEDULER_OPENCODE_PATH points to a .cmd/.bat file (${override}); cmd.exe would re-parse the prompt ` +
          "arguments (%VAR%, quotes, &). Point it at opencode.exe, or set OPENCODE_SCHEDULER_ALLOW_CMD_SHIM=1 for test probes.",
      )
    }
    return override
  }

  // Scan PATH ourselves instead of where.exe: where.exe searches the current directory first
  // (a planted opencode.exe in a project root would be baked into the task) and prints in the
  // OEM code page. Only absolute folders and only opencode.exe: an npm `opencode.cmd` shim
  // would run through cmd.exe, which re-parses the prompt argument.
  for (const raw of (probe.pathEnv ?? "").split(";")) {
    const dir = raw.trim().replace(/^"(.*)"$/, "$1").trim()
    if (!dir || !isWindowsAbsolutePath(dir)) continue
    const candidate = win32.join(dir, "opencode.exe")
    if (probe.exists(candidate)) return candidate
  }

  // Inside the OpenCode v2 service the plugin runs in opencode.exe itself.
  if (probe.execPath && isWindowsAbsolutePath(probe.execPath) && probe.exists(probe.execPath)) {
    const base = win32.basename(probe.execPath).toLowerCase()
    if (base === "opencode.exe" || base === "opencode") return probe.execPath
  }

  const fallbacks: string[] = []
  if (probe.userProfile) fallbacks.push(win32.join(probe.userProfile, ".opencode", "bin", "opencode.exe"))
  if (probe.localAppData) fallbacks.push(win32.join(probe.localAppData, "Programs", "opencode", "opencode.exe"))
  for (const candidate of fallbacks) {
    if (isWindowsAbsolutePath(candidate) && probe.exists(candidate)) return candidate
  }
  return null
}

/** System tools by absolute path, so a planted schtasks.exe/powershell.exe in the cwd or PATH is never run. */
export function windowsSystemBinaries(systemRoot: string | undefined): { schtasks: string; powershell: string } {
  const root = systemRoot && isWindowsAbsolutePath(systemRoot) ? systemRoot : "C:\\Windows"
  return {
    schtasks: win32.join(root, "System32", "schtasks.exe"),
    powershell: win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  }
}

/** Short error text for a failed execFileSync: stderr, never the command line (which may hold a base64 script). */
export function summarizeExecError(error: unknown): string {
  const record = (error ?? {}) as { stderr?: unknown; status?: unknown; message?: unknown }
  const stderr = record.stderr == null ? "" : String(record.stderr).trim()
  if (stderr) return stderr.length > 1000 ? `${stderr.slice(0, 997)}...` : stderr
  if (typeof record.status === "number") return `exit code ${record.status}`
  const message = typeof record.message === "string" ? record.message : String(error)
  return message.split(/\r?\n/)[0].slice(0, 300)
}

export interface WindowsSupervisorAction {
  execute: string
  arguments: string
  /** execute + arguments, as schtasks /TR expects it */
  commandLine: string
}

/**
 * The scheduled task action: run supervisor.ps1 on the job JSON. The prompt stays in the
 * job JSON, so only two paths go on the command line.
 */
export function buildWindowsSupervisorAction(supervisorPath: string, jobPath: string): WindowsSupervisorAction {
  for (const path of [supervisorPath, jobPath]) {
    if (path.includes('"')) throw new Error(`Windows task paths cannot contain a double quote: ${path}`)
  }
  const execute = "powershell.exe"
  const args = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${supervisorPath}" "${jobPath}"`
  return { execute, arguments: args, commandLine: `${execute} ${args}` }
}

/**
 * Value for schtasks /TR. When the full command line exceeds the 261-char limit (long user
 * name or slug), create the task with a placeholder; the configure step (Set-ScheduledTask,
 * which has no such limit) then sets the real action, and installation fails if it cannot.
 */
export function windowsTaskRunValue(action: WindowsSupervisorAction): string {
  return action.commandLine.length <= WINDOWS_TR_MAX ? action.commandLine : action.execute
}

export function splitWindowsTaskName(fullName: string): { path: string; name: string } {
  const index = fullName.lastIndexOf("\\")
  return { path: fullName.slice(0, index + 1) || "\\", name: fullName.slice(index + 1) }
}

function psQuote(value: string): string {
  // PowerShell also treats the typographic quotes U+2018..U+201B as single quotes.
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`
}

/**
 * PowerShell script run right after `schtasks /Create`: sets the supervisor action and the
 * battery/robustness settings schtasks.exe cannot set (the defaults silently skip runs on laptops).
 */
export function buildWindowsTaskConfigureScript(taskNames: string[], action: WindowsSupervisorAction): string {
  const parts = taskNames.map(splitWindowsTaskName)
  const folder = parts[0]?.path ?? "\\"
  if (parts.some((part) => part.path !== folder)) {
    throw new Error("All tasks of a job must live in the same Task Scheduler folder")
  }
  return [
    "$ErrorActionPreference = 'Stop'",
    `$action = New-ScheduledTaskAction -Execute ${psQuote(action.execute)} -Argument ${psQuote(action.arguments)}`,
    `foreach ($name in @(${parts.map((part) => psQuote(part.name)).join(", ")})) {`,
    `  $task = Get-ScheduledTask -TaskPath ${psQuote(folder)} -TaskName $name`,
    "  $settings = $task.Settings",
    "  $settings.DisallowStartIfOnBatteries = $false",
    "  $settings.StopIfGoingOnBatteries = $false",
    "  $settings.StartWhenAvailable = $true",
    // supervisor.ps1 enforces timeoutSeconds; the default PT72H limit would kill only powershell.exe and orphan opencode.
    "  $settings.ExecutionTimeLimit = 'PT0S'",
    `  Set-ScheduledTask -TaskPath ${psQuote(folder)} -TaskName $name -Action $action -Settings $settings | Out-Null`,
    "}",
  ].join("\n")
}

/** powershell.exe arguments that run `script` via -EncodedCommand (no command-line quoting issues). */
export function buildPowerShellEncodedArgs(script: string): string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ]
}
