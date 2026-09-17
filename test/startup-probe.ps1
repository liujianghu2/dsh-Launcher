#Requires -Version 5.1
<#
.SYNOPSIS
  Measure a DeepSeek Harness cold start from a packaged installation.

.DESCRIPTION
  Launches the bundled Node.js runtime against the installation's web entry
  point with an isolated DSH_HOME, waits until the HTTP port answers, and
  reports the elapsed time. The isolation is the point: a fresh home directory
  reproduces what another computer sees on the very first launch, where the
  profile module fallback has to be created from nothing.

.PARAMETER Root
  The installation directory (the one holding bin\, app\ and runtime\).

.PARAMETER Port
  TCP port for the probe server. Must not collide with a running instance.

.PARAMETER Home
  The DSH_HOME to use. Defaults to a fresh temporary directory that the probe
  removes afterwards. Pass -Keep to inspect it.

.PARAMETER Mode
  fresh  - an empty DSH_HOME (a new computer's first launch).
  stale  - a DSH_HOME whose shared module fallback points at a directory that
           no longer exists (the installation was moved or reinstalled).

.PARAMETER Timeout
  Seconds to wait for the port before declaring failure.
#>
[CmdletBinding()]
param(
  [string]$Root = 'D:\Application\DeepSeek Harness',
  [int]$Port = 3123,
  [string]$HomeDir,
  [ValidateSet('fresh', 'stale')][string]$Mode = 'fresh',
  [int]$Timeout = 180,
  [switch]$Keep
)

$ErrorActionPreference = 'Stop'

$node = Join-Path $Root 'runtime\node\node.exe'
$entry = Join-Path $Root 'app\node_modules\@deepseek-ai\dsh\lib\bin.js'
foreach ($required in $node, $entry) {
  if (-not (Test-Path -LiteralPath $required)) { throw "startup-probe: missing $required" }
}

$tempHome = $false
if (-not $HomeDir) {
  $HomeDir = Join-Path $env:TEMP ("dsh-probe-" + [guid]::NewGuid().ToString('n').Substring(0, 8))
  $tempHome = $true
}
New-Item -ItemType Directory -Force -Path $HomeDir | Out-Null

if ($Mode -eq 'stale') {
  # A fallback generation left behind by an installation that is gone. Every
  # entry must be replaced, not merely supplemented.
  $modules = Join-Path $HomeDir 'profiles\node_modules\@deepseek-ai'
  New-Item -ItemType Directory -Force -Path $modules | Out-Null
  $ghost = Join-Path $env:TEMP 'dsh-probe-gone-installation'
  cmd /c mklink /J (Join-Path $modules 'cordis') $ghost | Out-Null
}

$log = Join-Path $HomeDir 'probe.log'
$env:DSH_HOME = $HomeDir
$env:DSH_TELEMETRY_DISABLED = '1'

Write-Host "probe    : mode=$Mode root=$Root port=$Port home=$HomeDir"
$watch = [System.Diagnostics.Stopwatch]::StartNew()
# Start-Process joins the list with spaces without quoting, so the entry path
# needs its own quotes to survive an installation directory containing a space.
$process = Start-Process -FilePath $node `
  -ArgumentList @("`"$entry`"", 'web', '--port', "$Port", '--no-open') `
  -RedirectStandardOutput $log -RedirectStandardError "$log.err" `
  -PassThru -NoNewWindow

# Readiness is the server's own "dsh web: http://…" line rather than an HTTP
# probe: an unauthenticated request is answered with a redirect or a 4xx, and
# Windows PowerShell turns those into exceptions. The line is printed once the
# listener is up, which is the moment the launcher's own probe succeeds.
$ready = $false
$deadline = (Get-Date).AddSeconds($Timeout)
while ((Get-Date) -lt $deadline) {
  if ($process.HasExited) { break }
  if ((Test-Path -LiteralPath $log) -and
      (Select-String -LiteralPath $log -Pattern "dsh web: http://127\.0\.0\.1:$Port/" -Quiet)) {
    $ready = $true
    break
  }
  Start-Sleep -Milliseconds 100
}
$watch.Stop()

if (-not $process.HasExited) {
  taskkill /PID $process.Id /T /F 2>&1 | Out-Null
}

if ($ready) {
  Write-Host ("RESULT   : READY in {0:N1}s" -f $watch.Elapsed.TotalSeconds)
} else {
  Write-Host ("RESULT   : FAILED after {0:N1}s (exit={1})" -f $watch.Elapsed.TotalSeconds, $process.ExitCode)
  Write-Host '--- probe.log ---'
  Get-Content $log -Tail 60 -ErrorAction SilentlyContinue
  Write-Host '--- probe.log.err ---'
  Get-Content "$log.err" -Tail 60 -ErrorAction SilentlyContinue
}

if ($tempHome -and -not $Keep) { Remove-Item -Recurse -Force $HomeDir -ErrorAction SilentlyContinue }
exit $(if ($ready) { 0 } else { 1 })
