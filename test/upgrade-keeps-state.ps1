#Requires -Version 5.1
<#
.SYNOPSIS
  Prove an in-application upgrade keeps the settings, the data directory and the
  preinstalled plugins.

.DESCRIPTION
  The application's own upgrade is a directory swap, not a reinstall: the new
  release is installed into `update\app`, the running `app\` is renamed to
  `app.previous`, and `update\app` takes its place. This reproduces exactly that
  sequence on a staged tree — no network, no release download — and then boots,
  checking what the swap must not have disturbed.

.PARAMETER Root
  The staged (or installed) application directory.

.PARAMETER Port
  Port for the probe server. Must not collide with a running instance.
#>
[CmdletBinding()]
param(
  [string]$Root = 'E:\tools\dsh-dist\staging',
  [int]$Port = 3250,
  [int]$Timeout = 180
)

$ErrorActionPreference = 'Stop'

$node = Join-Path $Root 'runtime\node\node.exe'
$launcher = Join-Path $Root 'bin\dsh-app.mjs'
foreach ($required in $node, $launcher) {
  if (-not (Test-Path -LiteralPath $required)) { throw "upgrade-keeps-state: missing $required" }
}
# A port something else already owns fails the first start with EACCES, which
# would be reported as a broken upgrade rather than a busy probe port.
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
  throw "upgrade-keeps-state: port $Port is already in use; pass -Port with a free one"
}
$app = Join-Path $Root 'app'
$previous = Join-Path $Root 'app.previous'
$staged = Join-Path $Root 'update\app'

$probeHome = Join-Path $env:TEMP ("dsh-upgrade-" + [guid]::NewGuid().ToString('n').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $probeHome | Out-Null
$env:DSH_HOME = $probeHome
$env:DSH_APP_PORT = "$Port"
$env:DSH_TELEMETRY_DISABLED = '1'

$failures = @()

# --- first start, so the profile and its plugins exist ---------------------
& $node $launcher start | Out-Null
if ($LASTEXITCODE -ne 0) { $failures += 'the first start failed' }
$pidFile = Join-Path $Root "run\dsh-$Port.pid"
if (Test-Path -LiteralPath $pidFile) { taskkill /PID (Get-Content -LiteralPath $pidFile -Raw).Trim() /T /F 2>&1 | Out-Null }

$profileManifest = Join-Path $probeHome 'profiles\web\package.json'
$before = Get-Content -LiteralPath $profileManifest -Raw | ConvertFrom-Json
$beforeBundles = @($before.dsh.profile.bundles)
# The shipped in-box bundles are layers, not dependencies; only the plugins this
# installer added carry a dependency entry.
$carried = @($beforeBundles | Where-Object { $_ -notlike '@deepseek-ai/*' })
$configBefore = Get-Content -LiteralPath (Join-Path $Root 'config.json') -Raw
Write-Host "before   : bundles=$($beforeBundles -join ', ')"

# --- the swap an upgrade performs ------------------------------------------
Write-Host '==> swapping app\ the way the application updater does'
Remove-Item -Recurse -Force $staged, $previous -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $staged) | Out-Null
Copy-Item $app $staged -Recurse -Force
Move-Item -LiteralPath $app -Destination $previous
Move-Item -LiteralPath $staged -Destination $app

# --- boot again ------------------------------------------------------------
Remove-Item -Force (Join-Path $Root 'logs\dsh-web.log') -ErrorAction SilentlyContinue
New-Item -ItemType File -Path (Join-Path $Root 'logs\dsh-web.log') -Force | Out-Null
& $node $launcher start | ForEach-Object { Write-Host "  $_" }
if ($LASTEXITCODE -ne 0) { $failures += 'the start after the swap failed' }

$after = Get-Content -LiteralPath $profileManifest -Raw | ConvertFrom-Json
$afterBundles = @($after.dsh.profile.bundles)
Write-Host "after    : bundles=$($afterBundles -join ', ')"

foreach ($name in $beforeBundles) {
  if ($afterBundles -notcontains $name) { $failures += "$name disappeared from the profile after the upgrade" }
}
foreach ($name in $carried) {
  if (-not $after.dependencies.$name) { $failures += "$name is no longer a profile dependency" }
}
$configAfter = Get-Content -LiteralPath (Join-Path $Root 'config.json') -Raw
if ($configBefore -ne $configAfter) { $failures += 'config.json changed across the upgrade' }

# The data directory must hold the same sessions, and the plugins must still be
# the ones the profile resolves.
if (-not (Test-Path -LiteralPath (Join-Path $probeHome 'profiles\web\node_modules\dsh-data-manager\package.json'))) {
  $failures += 'the data manager is no longer in the profile'
}
$log = Join-Path $Root 'logs\dsh-web.log'
$ready = Select-String -LiteralPath $log -Pattern "dsh web: http://127\.0\.0\.1:$Port/" -Quiet
if (-not $ready) { $failures += 'the server never reported readiness after the swap' }
if ($ready) {
  $token = (Select-String -LiteralPath $log -Pattern "token=([\w-]+)" | Select-Object -Last 1).Matches[0].Groups[1].Value
  $webSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  # The boot manifest is one JSON document in the page; reading it through
  # Invoke-WebRequest keeps it a single string, which curl's line array is not.
  $index = (Invoke-WebRequest -Uri "http://127.0.0.1:$Port/?token=$token" -UseBasicParsing -WebSession $webSession -TimeoutSec 20).Content
  foreach ($name in 'dshmarket', 'dsh-deepseek-quota-bar', 'dsh-data-manager') {
    if ($index -notmatch [regex]::Escape($name)) { $failures += "$name is absent from the boot manifest after the upgrade" }
  }
  $status = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/dsh-data/status" -UseBasicParsing -WebSession $webSession -TimeoutSec 20
  $reported = $status.Content | ConvertFrom-Json
  if ($reported.path -ne $probeHome) {
    $failures += "the data manager reports the wrong directory after the upgrade: $($reported.path)"
  }
}

if (Test-Path -LiteralPath $pidFile) { taskkill /PID (Get-Content -LiteralPath $pidFile -Raw).Trim() /T /F 2>&1 | Out-Null }

# --- put the tree back -----------------------------------------------------
Remove-Item -Recurse -Force $app -ErrorAction SilentlyContinue
Move-Item -LiteralPath $previous -Destination $app
Remove-Item -Recurse -Force $probeHome -ErrorAction SilentlyContinue

Write-Host ''
if ($failures.Count -gt 0) {
  Write-Host 'RESULT   : FAILED'
  $failures | ForEach-Object { Write-Host "  - $_" }
  exit 1
}
Write-Host 'RESULT   : OK'
exit 0
