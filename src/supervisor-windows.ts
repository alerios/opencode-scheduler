/**
 * Windows counterpart of supervisor.pl, written to ~/.config/opencode/scheduler/supervisor.ps1.
 *
 * Task Scheduler runs:
 *   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File supervisor.ps1 <job.json>
 *
 * It mirrors supervisor.pl: same log path and `===` markers, same run-record JSONL fields,
 * same lastRun* job JSON updates, a lock file against overlapping runs, and timeoutSeconds
 * (kills the process tree; recorded like the Perl supervisor: status=failed, error=timeout,
 * exitCode=124). Targets Windows PowerShell 5.1.
 *
 * Kept as a String.raw template: it must contain no backtick and no dollar-brace sequence,
 * and must stay pure ASCII (PowerShell 5.1 reads a BOM-less .ps1 in the ANSI code page).
 */
export const WINDOWS_SUPERVISOR_SCRIPT = String.raw`# opencode-scheduler supervisor (Windows) v1
# Usage: powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File supervisor.ps1 <job.json>
param([string]$JobPath)

$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 may serialize arrays as {"value":[...],"Count":n} while this type data is loaded.
try { if (Get-TypeData -TypeName System.Array) { Remove-TypeData -TypeName System.Array } } catch {}

$LF = [string][char]10
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$Inv = [System.Globalization.CultureInfo]::InvariantCulture
$log = $null
$lockPath = $null

function Get-IsoNow {
  # Same shape as supervisor.pl's strftime("%Y-%m-%dT%H:%M:%S%z").
  $s = [DateTime]::Now.ToString("yyyy-MM-dd'T'HH:mm:sszzz", $Inv)
  return ($s -replace ':(\d\d)$', '$1')
}

function Read-JsonFile([string]$Path) {
  return ([System.IO.File]::ReadAllText($Path) | ConvertFrom-Json)
}

function Write-JsonAtomic([string]$Path, $Data) {
  $tmp = $Path + '.tmp.' + $PID
  [System.IO.File]::WriteAllText($tmp, (ConvertTo-Json -InputObject $Data -Depth 50), $Utf8)
  if ([System.IO.File]::Exists($Path)) {
    try { [System.IO.File]::Replace($tmp, $Path, [NullString]::Value) }
    catch { [System.IO.File]::Copy($tmp, $Path, $true); [System.IO.File]::Delete($tmp) }
  } else {
    [System.IO.File]::Move($tmp, $Path)
  }
}

function Add-JsonlLine([string]$Path, $Data) {
  [System.IO.File]::AppendAllText($Path, (ConvertTo-Json -InputObject $Data -Depth 10 -Compress) + $LF, $Utf8)
}

function Set-Prop($Obj, [string]$Name, $Value) {
  $Obj | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
}

function Remove-Prop($Obj, [string]$Name) {
  [void]$Obj.PSObject.Properties.Remove($Name)
}

function Write-Log([string]$Text) {
  if ($log) { $log.Write($Text) }
}

function Test-PidAlive($ProcessId) {
  if (-not $ProcessId) { return $false }
  return [bool](Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

# Quote one argument for CreateProcess / CommandLineToArgvW (MSVCRT rules).
function ConvertTo-WinArg([string]$Value) {
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('"')
  $bs = 0
  foreach ($ch in $Value.ToCharArray()) {
    if ($ch -eq [char]'\') { $bs++; continue }
    if ($ch -eq [char]'"') { [void]$sb.Append([char]'\', 2 * $bs + 1) }
    elseif ($bs -gt 0) { [void]$sb.Append([char]'\', $bs) }
    $bs = 0
    [void]$sb.Append($ch)
  }
  if ($bs -gt 0) { [void]$sb.Append([char]'\', 2 * $bs) }
  [void]$sb.Append('"')
  return $sb.ToString()
}

trap {
  Write-Log ($LF + '=== Supervisor error ' + (Get-IsoNow) + ': ' + $_.Exception.Message + ' ===' + $LF)
  if ($lockPath) { Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue }
  if ($log) { $log.Dispose() }
  exit 1
}

if (-not $JobPath) { [Console]::Error.WriteLine('usage: supervisor.ps1 <job.json>'); exit 2 }

$job = Read-JsonFile $JobPath
$scopeId = [string]$job.scopeId
$slug = [string]$job.slug
if (-not $scopeId -or -not $slug) { [Console]::Error.WriteLine('job missing scopeId/slug'); exit 2 }

# Same root as the plugin: Node's os.homedir() is %USERPROFILE% on Windows.
$homeDir = $env:USERPROFILE
if (-not $homeDir) { $homeDir = [Environment]::GetFolderPath('UserProfile') }

$configRoot = Join-Path $homeDir '.config\opencode'
$schedulerRoot = Join-Path $configRoot "scheduler\scopes\$scopeId"
$locksDir = Join-Path $schedulerRoot 'locks'
$runsDir = Join-Path $schedulerRoot 'runs'
$logsDir = Join-Path $configRoot "logs\scheduler\$scopeId"
foreach ($dir in @($locksDir, $runsDir, $logsDir)) { [void][System.IO.Directory]::CreateDirectory($dir) }

$logPath = Join-Path $logsDir "$slug.log"
$logStream = New-Object System.IO.FileStream($logPath, [System.IO.FileMode]::Append, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
$log = New-Object System.IO.StreamWriter($logStream, $Utf8)
$log.AutoFlush = $true

$candidateLock = Join-Path $locksDir "$slug.json"
if (Test-Path -LiteralPath $candidateLock) {
  $lockPid = 0
  try { $lock = Read-JsonFile $candidateLock; if ($lock.pid) { $lockPid = [int]$lock.pid } } catch {}
  if (Test-PidAlive $lockPid) {
    Write-Log ($LF + "=== Scheduled run skipped (already running pid=$lockPid) " + (Get-IsoNow) + ' ===' + $LF)
    $log.Dispose()
    exit 0
  }
  Remove-Item -LiteralPath $candidateLock -Force -ErrorAction SilentlyContinue
}

$random = New-Object System.Random
$runId = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() / 1000.0).ToString($Inv) + '-' + $random.Next(0, 1000000000).ToString('000000000', $Inv)
$startedAt = Get-IsoNow
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()

$lockPath = $candidateLock
Write-JsonAtomic $lockPath ([ordered]@{ pid = $PID; runId = $runId; startedAt = $startedAt })

# Update job metadata: running
Set-Prop $job 'lastRunAt' $startedAt
Set-Prop $job 'lastRunSource' 'scheduled'
Set-Prop $job 'lastRunStatus' 'running'
Remove-Prop $job 'lastRunExitCode'
Remove-Prop $job 'lastRunError'
Set-Prop $job 'updatedAt' $startedAt
Write-JsonAtomic $JobPath $job

# Force non-interactive scheduled runs (parity with supervisor.pl; OpenCode v2 ignores it).
$perm = [ordered]@{}
if ($env:OPENCODE_PERMISSION) {
  try {
    $existing = $env:OPENCODE_PERMISSION | ConvertFrom-Json
    foreach ($p in $existing.PSObject.Properties) { $perm[$p.Name] = $p.Value }
  } catch {}
}
$perm['question'] = 'deny'

Write-Log ($LF + "=== Scheduled run $startedAt runId=$runId ===" + $LF)

$inv = $job.invocation
if (-not $inv -or -not $inv.command -or -not ($inv.args -is [array])) {
  Write-Log ($LF + '=== Supervisor error ' + (Get-IsoNow) + ': job missing invocation.command/args ===' + $LF)
  $now = Get-IsoNow
  Set-Prop $job 'lastRunStatus' 'failed'
  Set-Prop $job 'lastRunError' 'job missing invocation'
  Set-Prop $job 'updatedAt' $now
  Write-JsonAtomic $JobPath $job
  Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
  $log.Dispose()
  exit 1
}

$workdir = [string]$job.workdir
if (-not $workdir) { $workdir = $homeDir }

$timeout = $null
if ($null -ne $job.timeoutSeconds -and ([string]$job.timeoutSeconds) -match '^\d+$') { $timeout = [int64]$job.timeoutSeconds }

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = [string]$inv.command
$psi.Arguments = (@($inv.args | ForEach-Object { ConvertTo-WinArg ([string]$_) }) -join ' ')
$psi.WorkingDirectory = $workdir
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.StandardOutputEncoding = $Utf8
$psi.StandardErrorEncoding = $Utf8
$psi.EnvironmentVariables['PWD'] = $workdir
$psi.EnvironmentVariables['OPENCODE_PERMISSION'] = (ConvertTo-Json -InputObject $perm -Compress)
$psi.EnvironmentVariables['OPENCODE_SCHEDULER_RUN_ID'] = $runId

$timedOut = $false
$startError = $null
$childPid = $null
$exitCode = 1
$proc = $null
try {
  Set-Location -LiteralPath $workdir
  $env:PWD = $workdir
  $proc = [System.Diagnostics.Process]::Start($psi)
  $childPid = $proc.Id
} catch {
  $startError = $_.Exception.Message
  Write-Log ($LF + '=== Supervisor error ' + (Get-IsoNow) + ': ' + $startError + ' ===' + $LF)
}

if ($proc) {
  # Like systemd's stdin=/dev/null: the run must never wait for input.
  $proc.StandardInput.Close()
  $outReader = $proc.StandardOutput
  $errReader = $proc.StandardError
  $outTask = $outReader.ReadLineAsync()
  $errTask = $errReader.ReadLineAsync()
  $deadline = $null
  if ($timeout -gt 0) { $deadline = [DateTime]::UtcNow.AddSeconds($timeout) }
  $killedAt = $null
  while ($outTask -or $errTask) {
    $pending = @()
    if ($outTask) { $pending += $outTask }
    if ($errTask) { $pending += $errTask }
    [void][System.Threading.Tasks.Task]::WaitAny([System.Threading.Tasks.Task[]]$pending, 250)
    if ($outTask -and $outTask.IsCompleted) {
      $line = $null
      try { $line = $outTask.Result } catch {}
      if ($null -eq $line) { $outTask = $null } else { Write-Log ($line + $LF); $outTask = $outReader.ReadLineAsync() }
    }
    if ($errTask -and $errTask.IsCompleted) {
      $line = $null
      try { $line = $errTask.Result } catch {}
      if ($null -eq $line) { $errTask = $null } else { Write-Log ($line + $LF); $errTask = $errReader.ReadLineAsync() }
    }
    if ($deadline -and -not $timedOut -and [DateTime]::UtcNow -gt $deadline) {
      $timedOut = $true
      $killedAt = [DateTime]::UtcNow
      Write-Log ($LF + "=== Timeout after $timeout seconds " + (Get-IsoNow) + '; killing process tree ===' + $LF)
      try {
        $kill = New-Object System.Diagnostics.ProcessStartInfo
        $kill.FileName = 'taskkill.exe'
        $kill.Arguments = '/PID ' + $childPid + ' /T /F'
        $kill.UseShellExecute = $false
        $kill.CreateNoWindow = $true
        $killer = [System.Diagnostics.Process]::Start($kill)
        [void]$killer.WaitForExit(15000)
      } catch {}
      try { if (-not $proc.HasExited) { $proc.Kill() } } catch {}
    }
    # A grandchild that survived the kill could keep the pipes open: stop reading after a grace period.
    if ($killedAt -and ([DateTime]::UtcNow - $killedAt).TotalSeconds -gt 10) { break }
  }
  [void]$proc.WaitForExit(10000)
  if ($proc.HasExited) { $exitCode = $proc.ExitCode }
}

$finishedAt = Get-IsoNow
$durationMs = [int64][Math]::Floor($stopwatch.Elapsed.TotalMilliseconds)
if ($timedOut) {
  $exitCode = 124
}

$finalStatus = 'failed'
$finalError = $null
if ($timedOut) {
  $finalError = 'timeout'
} elseif ($startError) {
  $exitCode = 127
  $finalError = 'start failed: ' + $startError
} elseif ($exitCode -eq 0) {
  $finalStatus = 'success'
} else {
  $finalError = "exit code $exitCode"
}

Set-Prop $job 'lastRunStatus' $finalStatus
Set-Prop $job 'lastRunExitCode' $exitCode
if ($null -ne $finalError) { Set-Prop $job 'lastRunError' $finalError }
Set-Prop $job 'updatedAt' $finishedAt
Write-JsonAtomic $JobPath $job

Add-JsonlLine (Join-Path $runsDir "$slug.jsonl") ([ordered]@{
  durationMs = $durationMs
  error = $finalError
  exitCode = $exitCode
  finishedAt = $finishedAt
  logPath = $logPath
  pid = $childPid
  runId = $runId
  scopeId = $scopeId
  slug = $slug
  startedAt = $startedAt
  status = $finalStatus
})

Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
$lockPath = $null
Write-Log ($LF + "=== Finished $finishedAt status=$finalStatus exitCode=$exitCode durationMs=$durationMs ===" + $LF)
$log.Dispose()
exit $exitCode
`
