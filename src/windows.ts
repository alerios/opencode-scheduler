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
  "Could not find opencode.exe (not on PATH via where.exe, not the current process, and not in " +
  "%USERPROFILE%\\.opencode\\bin or %LOCALAPPDATA%\\Programs\\opencode). Scheduled tasks need an absolute path: " +
  "set OPENCODE_SCHEDULER_OPENCODE_PATH to the full path of opencode.exe and try again."

export interface WindowsOpencodeProbe {
  /** OPENCODE_SCHEDULER_OPENCODE_PATH */
  override?: string
  /** stdout of `where.exe opencode`, or null/undefined when it failed */
  whereOutput?: string | null
  /** process.execPath */
  execPath?: string
  /** %USERPROFILE% */
  userProfile?: string
  /** %LOCALAPPDATA% */
  localAppData?: string
  exists: (path: string) => boolean
}

/**
 * Resolve an absolute opencode path for a Windows scheduled task.
 * Returns null when nothing is found (callers must fail clearly, not store a bare name:
 * Task Scheduler does not resolve a bare `opencode` the way an interactive shell does).
 */
export function resolveWindowsOpencode(probe: WindowsOpencodeProbe): string | null {
  const override = probe.override?.trim()
  if (override) return override

  // where.exe lists PATHEXT matches in PATH order. Take the first real .exe: an npm
  // `opencode.cmd` shim would run through cmd.exe, which re-parses the prompt argument.
  const whereLines = (probe.whereOutput ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const whereExe = whereLines.find((line) => /\.exe$/i.test(line))
  if (whereExe) return whereExe

  // Inside the OpenCode v2 service the plugin runs in opencode.exe itself.
  if (probe.execPath) {
    const base = win32.basename(probe.execPath).toLowerCase()
    if (base === "opencode.exe" || base === "opencode") return probe.execPath
  }

  const fallbacks: string[] = []
  if (probe.userProfile) fallbacks.push(win32.join(probe.userProfile, ".opencode", "bin", "opencode.exe"))
  if (probe.localAppData) fallbacks.push(win32.join(probe.localAppData, "Programs", "opencode", "opencode.exe"))
  for (const candidate of fallbacks) {
    if (probe.exists(candidate)) return candidate
  }
  return null
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
  return `'${value.replace(/'/g, "''")}'`
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
