#Requires -Version 5.1
<#
.SYNOPSIS
  Prove the packaged preinstalled plugins are enabled on a first launch.

.DESCRIPTION
  Boots a staged installation with an isolated DSH_HOME and checks the facts
  that make a carried plugin work without a network install: the launcher placed
  it in the profile, named it in the profile manifest as a bundle, and the
  server came up with both halves of each plugin mounted.

  The isolation matters. A fresh DSH_HOME is what another computer sees, and it
  is the only state in which the launcher has to create the profile itself.

.PARAMETER Root
  The staged (or installed) application directory.

.PARAMETER Port
  Port for the probe server. Must not collide with a running instance.
#>
[CmdletBinding()]
param(
  [string]$Root = 'E:\tools\dsh-dist\staging',
  [int]$Port = 3151,
  [int]$Timeout = 180
)

$ErrorActionPreference = 'Stop'

$node = Join-Path $Root 'runtime\node\node.exe'
$launcher = Join-Path $Root 'bin\dsh-app.mjs'
$manifest = Join-Path $Root 'plugins\preinstalled.json'
foreach ($required in $node, $launcher, $manifest) {
  if (-not (Test-Path -LiteralPath $required)) { throw "preinstalled-plugins: missing $required" }
}
$names = (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json).bundles
if (-not $names -or $names.Count -eq 0) { throw 'preinstalled-plugins: preinstalled.json declares no bundles' }

$probeHome = Join-Path $env:TEMP ("dsh-preinstalled-" + [guid]::NewGuid().ToString('n').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $probeHome | Out-Null
$env:DSH_HOME = $probeHome
$env:DSH_APP_PORT = "$Port"
$env:DSH_TELEMETRY_DISABLED = '1'

$failures = @()
$result = & $node $launcher start 2>&1
$result | ForEach-Object { Write-Host "launcher: $_" }
if ($LASTEXITCODE -ne 0) { $failures += "launcher exited $LASTEXITCODE" }

$profileDir = Join-Path $probeHome 'profiles\web'
$profileManifest = Join-Path $profileDir 'package.json'
if (-not (Test-Path -LiteralPath $profileManifest)) {
  $failures += "the launcher did not create $profileManifest"
} else {
  $profile = Get-Content -LiteralPath $profileManifest -Raw | ConvertFrom-Json
  $bundles = @($profile.dsh.profile.bundles)
  Write-Host "bundles  : $($bundles -join ', ')"
  foreach ($name in $names) {
    if ($bundles -notcontains $name) { $failures += "$name is not a profile bundle" }
    if (-not $profile.dependencies.$name) { $failures += "$name is not a profile dependency" }
    $installed = Join-Path $profileDir "node_modules\$name\package.json"
    if (-not (Test-Path -LiteralPath $installed)) {
      $failures += "$name was not placed in the profile"
    } else {
      $version = (Get-Content -LiteralPath $installed -Raw | ConvertFrom-Json).version
      Write-Host "placed   : $name $version (dependency $($profile.dependencies.$name))"
    }
  }
}

$log = Join-Path $Root 'logs\dsh-web.log'
$marker = "dsh web: http://127.0.0.1:$Port/"
$deadline = (Get-Date).AddSeconds($Timeout)
$ready = $false
while ((Get-Date) -lt $deadline) {
  if ((Test-Path -LiteralPath $log) -and (Select-String -LiteralPath $log -Pattern ([regex]::Escape($marker)) -Quiet)) {
    $ready = $true
    break
  }
  Start-Sleep -Milliseconds 200
}
if (-not $ready) { $failures += "the server never reported readiness on port $Port" }

if ($ready) {
  # The boot HTML carries the client module table, so finding an entry id there
  # proves the client half of the plugin was composed and served, not merely that
  # its host half imported. The token is the one the server printed for the
  # browser handoff; the session keeps the cookie it sets for the later request.
  $token = (Select-String -LiteralPath $log -Pattern "dsh web: http://127\.0\.0\.1:$Port/\?token=([\w-]+)" |
    Select-Object -Last 1).Matches[0].Groups[1].Value
  $webSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  try {
    $index = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/?token=$token" -UseBasicParsing -WebSession $webSession -TimeoutSec 20
    foreach ($name in $names) {
      if ($index.Content -match [regex]::Escape($name)) { Write-Host "client   : $name present in the boot manifest" }
      else { $failures += "$name is absent from the boot manifest" }
    }
  } catch {
    $failures += "could not read the boot manifest: $($_.Exception.Message)"
  }
  # The market serves its own status route. Its first answer probes the machine's
  # tooling, which takes seconds, and it reports whether the market sees itself
  # as an installed plugin — the fact that makes its self-update available.
  try {
    $status = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/dsh-market/status" -UseBasicParsing -WebSession $webSession -TimeoutSec 60
    $payload = $status.Content | ConvertFrom-Json
    Write-Host "route    : /dsh-market/status -> $($status.StatusCode) version=$($payload.version) selfManaged=$($payload.selfManaged)"
    if (-not $payload.selfManaged) { $failures += 'the market does not see itself as an installed plugin' }
  } catch {
    $failures += "the market status route did not answer: $($_.Exception.Message)"
  }
}

# The launcher records the serving process id for exactly this.
$pidFile = Join-Path $Root "run\dsh-$Port.pid"
if (Test-Path -LiteralPath $pidFile) {
  $serverPid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
  taskkill /PID $serverPid /T /F 2>&1 | Out-Null
  Write-Host "stopped  : process $serverPid"
}

Write-Host ''
if ($failures.Count -gt 0) {
  Write-Host 'RESULT   : FAILED'
  $failures | ForEach-Object { Write-Host "  - $_" }
  Write-Host '--- server log tail ---'
  Get-Content -LiteralPath $log -Tail 40 -ErrorAction SilentlyContinue
  exit 1
}
Write-Host 'RESULT   : OK'
Remove-Item -Recurse -Force $probeHome -ErrorAction SilentlyContinue
exit 0
