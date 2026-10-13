import { describe, expect, test } from "bun:test"
import {
  WINDOWS_OPENCODE_NOT_FOUND,
  WINDOWS_TR_MAX,
  buildPowerShellEncodedArgs,
  buildWindowsSupervisorAction,
  buildWindowsTaskConfigureScript,
  resolveWindowsOpencode,
  splitWindowsTaskName,
  windowsTaskRunValue,
} from "../src/windows"
import { WINDOWS_SUPERVISOR_SCRIPT } from "../src/supervisor-windows"
import * as index from "../src/index"

const none = () => false

describe("resolveWindowsOpencode", () => {
  test("override wins, returned as-is (existing semantics)", () => {
    expect(
      resolveWindowsOpencode({ override: "  D:\\tools\\opencode.cmd ", whereOutput: "C:\\a\\opencode.exe\r\n", exists: none }),
    ).toBe("D:\\tools\\opencode.cmd")
  })

  test("where.exe: first .exe line, CRLF output", () => {
    const whereOutput = "C:\\Users\\Jo Smith\\AppData\\Roaming\\npm\\opencode.cmd\r\nC:\\Program Files\\opencode\\opencode.exe\r\nC:\\other\\opencode.exe\r\n"
    expect(resolveWindowsOpencode({ whereOutput, exists: none })).toBe("C:\\Program Files\\opencode\\opencode.exe")
  })

  test("where.exe output with only non-.exe shims falls through to execPath", () => {
    expect(
      resolveWindowsOpencode({
        whereOutput: "C:\\npm\\opencode.cmd\r\n",
        execPath: "C:\\Users\\winvm\\Downloads\\opencode.exe",
        exists: none,
      }),
    ).toBe("C:\\Users\\winvm\\Downloads\\opencode.exe")
  })

  test("execPath used only when its basename is opencode(.exe)", () => {
    expect(resolveWindowsOpencode({ whereOutput: null, execPath: "C:\\x\\OpenCode.EXE", exists: none })).toBe("C:\\x\\OpenCode.EXE")
    expect(resolveWindowsOpencode({ whereOutput: null, execPath: "C:\\x\\opencode", exists: none })).toBe("C:\\x\\opencode")
    expect(resolveWindowsOpencode({ whereOutput: null, execPath: "C:\\bun\\bun.exe", exists: none })).toBeNull()
  })

  test("fallbacks: %USERPROFILE%\\.opencode\\bin then %LOCALAPPDATA%\\Programs\\opencode", () => {
    const userBin = "C:\\Users\\winvm\\.opencode\\bin\\opencode.exe"
    const localBin = "C:\\Users\\winvm\\AppData\\Local\\Programs\\opencode\\opencode.exe"
    const base = {
      whereOutput: "",
      execPath: "C:\\bun\\bun.exe",
      userProfile: "C:\\Users\\winvm",
      localAppData: "C:\\Users\\winvm\\AppData\\Local",
    }
    expect(resolveWindowsOpencode({ ...base, exists: (p) => p === userBin || p === localBin })).toBe(userBin)
    expect(resolveWindowsOpencode({ ...base, exists: (p) => p === localBin })).toBe(localBin)
    expect(resolveWindowsOpencode({ ...base, exists: none })).toBeNull()
  })

  test("not-found message names OPENCODE_SCHEDULER_OPENCODE_PATH", () => {
    expect(WINDOWS_OPENCODE_NOT_FOUND).toContain("OPENCODE_SCHEDULER_OPENCODE_PATH")
  })
})

describe("buildWindowsSupervisorAction", () => {
  test("exact command line, paths with spaces quoted", () => {
    const action = buildWindowsSupervisorAction(
      "C:\\Users\\Jo Smith\\.config\\opencode\\scheduler\\supervisor.ps1",
      "C:\\Users\\Jo Smith\\.config\\opencode\\scheduler\\scopes\\proj-abc\\jobs\\daily.json",
    )
    expect(action.execute).toBe("powershell.exe")
    expect(action.arguments).toBe(
      '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\\Users\\Jo Smith\\.config\\opencode\\scheduler\\supervisor.ps1" "C:\\Users\\Jo Smith\\.config\\opencode\\scheduler\\scopes\\proj-abc\\jobs\\daily.json"',
    )
    expect(action.commandLine).toBe(`powershell.exe ${action.arguments}`)
  })

  test("rejects a path containing a double quote", () => {
    expect(() => buildWindowsSupervisorAction('C:\\a"b\\supervisor.ps1', "C:\\j.json")).toThrow(/quote/)
  })

  test("/TR value: full command line when it fits, placeholder when over the limit", () => {
    const short = buildWindowsSupervisorAction("C:\\s.ps1", "C:\\j.json")
    expect(windowsTaskRunValue(short)).toBe(short.commandLine)
    const long = buildWindowsSupervisorAction("C:\\s.ps1", `C:\\${"x".repeat(300)}.json`)
    expect(long.commandLine.length).toBeGreaterThan(WINDOWS_TR_MAX)
    expect(windowsTaskRunValue(long)).toBe("powershell.exe")
    expect(WINDOWS_TR_MAX).toBe(261)
  })
})

describe("task configure script", () => {
  test("splitWindowsTaskName", () => {
    expect(splitWindowsTaskName("\\OpenCode\\opencode-job-a-b-2")).toEqual({ path: "\\OpenCode\\", name: "opencode-job-a-b-2" })
  })

  test("sets battery/StartWhenAvailable and the action on every task, quotes escaped", () => {
    const action = buildWindowsSupervisorAction("C:\\Users\\O'Neil\\s.ps1", "C:\\Users\\O'Neil\\j.json")
    const script = buildWindowsTaskConfigureScript(["\\OpenCode\\opencode-job-p-x-1", "\\OpenCode\\opencode-job-p-x-2"], action)
    expect(script).toContain("$ErrorActionPreference = 'Stop'")
    expect(script).toContain(
      `$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\\Users\\O''Neil\\s.ps1" "C:\\Users\\O''Neil\\j.json"'`,
    )
    expect(script).toContain("foreach ($name in @('opencode-job-p-x-1', 'opencode-job-p-x-2')) {")
    expect(script).toContain("$task = Get-ScheduledTask -TaskPath '\\OpenCode\\' -TaskName $name")
    expect(script).toContain("$settings.DisallowStartIfOnBatteries = $false")
    expect(script).toContain("$settings.StopIfGoingOnBatteries = $false")
    expect(script).toContain("$settings.StartWhenAvailable = $true")
    expect(script).toContain("Set-ScheduledTask -TaskPath '\\OpenCode\\' -TaskName $name -Action $action -Settings $settings | Out-Null")
  })

  test("rejects tasks in different folders", () => {
    const action = buildWindowsSupervisorAction("C:\\s.ps1", "C:\\j.json")
    expect(() => buildWindowsTaskConfigureScript(["\\OpenCode\\a", "\\Other\\b"], action)).toThrow()
  })

  test("encoded command is base64 UTF-16LE of the script", () => {
    const args = buildPowerShellEncodedArgs("Write-Output 'hi'")
    expect(args.slice(0, 5)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"])
    expect(Buffer.from(args[5], "base64").toString("utf16le")).toBe("Write-Output 'hi'")
  })
})

describe("cronToWindowsTaskDefinitions", () => {
  const job = {
    scopeId: "proj-c7f8a2b6138a",
    slug: "win-pong",
    name: "win pong",
    schedule: "*/2 * * * *",
    createdAt: "2026-10-12T00:00:00.000Z",
    prompt: 'Reply with "PONG" & exit',
  }

  test("/TR is the supervisor action, not the prompt", () => {
    const tr = 'powershell.exe -NoProfile -File "C:\\s.ps1" "C:\\j.json"'
    const defs = index.__testing.windowsTaskDefinitions(job, tr)
    expect(defs).toEqual([
      {
        name: "\\OpenCode\\opencode-job-proj-c7f8a2b6138a-win-pong",
        args: ["/Create", "/F", "/TN", "\\OpenCode\\opencode-job-proj-c7f8a2b6138a-win-pong", "/TR", tr, "/SC", "MINUTE", "/MO", "2", "/ST", "00:00"],
      },
    ])
    expect(JSON.stringify(defs)).not.toContain("PONG")
  })

  test("multi-trigger jobs get one task each, all with the same /TR", () => {
    const defs = index.__testing.windowsTaskDefinitions({ ...job, schedule: "0 8,18 * * *" }, "TR")
    expect(defs.map((d) => d.name)).toEqual([
      "\\OpenCode\\opencode-job-proj-c7f8a2b6138a-win-pong-1",
      "\\OpenCode\\opencode-job-proj-c7f8a2b6138a-win-pong-2",
    ])
    for (const d of defs) expect(d.args[d.args.indexOf("/TR") + 1]).toBe("TR")
  })
})

describe("supervisor.ps1 template", () => {
  test("pure ASCII (PowerShell 5.1 reads BOM-less .ps1 as ANSI)", () => {
    expect(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(WINDOWS_SUPERVISOR_SCRIPT)).toBe(true)
  })

  test("param block first, mirrors supervisor.pl markers and fields", () => {
    const body = WINDOWS_SUPERVISOR_SCRIPT.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"))
    expect(body[0]).toBe("param([string]$JobPath)")
    for (const needle of [
      "=== Scheduled run $startedAt runId=$runId ===",
      "=== Scheduled run skipped (already running pid=$lockPid)",
      "=== Finished $finishedAt status=$finalStatus exitCode=$exitCode durationMs=$durationMs ===",
      "=== Timeout after $timeout seconds",
      "logs\\scheduler\\$scopeId",
      "scheduler\\scopes\\$scopeId",
      "'lastRunAt'",
      "'lastRunSource' 'scheduled'",
      "'lastRunStatus' 'running'",
      "'lastRunExitCode'",
      "'lastRunError'",
      "'updatedAt'",
      "$psi.EnvironmentVariables['PWD'] = $workdir",
      "$psi.WorkingDirectory = $workdir",
      "OPENCODE_SCHEDULER_RUN_ID",
      "taskkill.exe",
      "$exitCode = 124",
      "$finalError = 'timeout'",
    ]) {
      expect(WINDOWS_SUPERVISOR_SCRIPT).toContain(needle)
    }
    // Run-record keys, same set as supervisor.pl.
    for (const key of ["durationMs", "error", "exitCode", "finishedAt", "logPath", "pid", "runId", "scopeId", "slug", "startedAt", "status"]) {
      expect(WINDOWS_SUPERVISOR_SCRIPT).toMatch(new RegExp(`\\b${key} = `))
    }
  })

  test("avoids PowerShell pitfalls: no automatic-variable assignment, no '$var:' in strings", () => {
    for (const reserved of ["$home", "$pid", "$args", "$error", "$input", "$matches", "$host"]) {
      expect(WINDOWS_SUPERVISOR_SCRIPT.toLowerCase()).not.toMatch(new RegExp(`\\${reserved} *=[^=]`))
    }
    expect(WINDOWS_SUPERVISOR_SCRIPT).not.toMatch(/"[^"\n]*\$[A-Za-z_]+:[^"\n]*"/)
    const opens = (WINDOWS_SUPERVISOR_SCRIPT.match(/[{(]/g) ?? []).length
    const closes = (WINDOWS_SUPERVISOR_SCRIPT.match(/[})]/g) ?? []).length
    expect(opens).toBe(closes)
  })
})
