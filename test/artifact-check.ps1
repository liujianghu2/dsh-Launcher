#Requires -Version 5.1
# End-to-end check of the built artifact: recompile staging, install it into a
# throwaway directory, run the acceptance script against that installation, and
# show the startup stream the shortcut window tails. Used while iterating on the
# package; not part of the shipped tree.
[CmdletBinding()]
param(
  [string]$DistRoot = 'E:\tools\dsh-dist',
  [int]$Port = 3260
)
$ErrorActionPreference = 'Stop'

$staging = Join-Path $DistRoot 'staging'
Copy-Item (Join-Path $DistRoot 'package-files\*') $staging -Recurse -Force
$dataManager = Join-Path $staging 'plugins\node_modules\dsh-data-manager'
Remove-Item -Recurse -Force $dataManager -ErrorAction SilentlyContinue
Copy-Item (Join-Path $DistRoot 'package-files\plugins\dsh-data-manager') $dataManager -Recurse -Force
& pwsh -NoProfile -File (Join-Path $staging 'tools\install-shortcuts.ps1') -Root $staging -SkipShortcuts | Out-Null

Write-Host '=== recompiling ==='
& pwsh -NoProfile -File (Join-Path $DistRoot 'build-package.ps1') -SkipStage 2>&1 |
  Select-String -Pattern 'Successful compile|安装包|大小|SHA256|rror' | Select-Object -Last 4

$setup = Join-Path $DistRoot 'dist\DeepSeekHarness-Setup-0.1.5-rc.1-win-x64.exe'
$install = Join-Path $env:TEMP 'dsh-artifact-check'
Remove-Item -Recurse -Force $install -ErrorAction SilentlyContinue
Write-Host '=== installing the artifact ==='
$installer = Start-Process $setup -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=`"$install`"") -PassThru -Wait
Write-Host "install exit=$($installer.ExitCode)"
Write-Host "trace shipped   : $((Test-Path "$install\bin\boot-trace.mjs") -and (Test-Path "$install\bin\boot-trace-hooks.mjs"))"
Write-Host "server uses it  : $((Select-String -LiteralPath "$install\bin\run-server.vbs" -Pattern '--import' -Quiet))"

Write-Host '=== acceptance on the installed tree ==='
& pwsh -NoProfile -File (Join-Path $DistRoot 'test\preinstalled-plugins.ps1') -Root $install -Port $Port
$acceptance = $LASTEXITCODE
Write-Host "acceptance exit=$acceptance"

$stream = Join-Path $install 'run\boot-progress.log'
if (Test-Path -LiteralPath $stream) {
  $lines = Get-Content -LiteralPath $stream
  Write-Host "=== startup stream ($($lines.Count) lines) ==="
  $lines | Select-Object -First 7 | ForEach-Object { Write-Host "  $_" }
  Write-Host '  ...'
  $lines | Select-Object -Last 3 | ForEach-Object { Write-Host "  $_" }
}

Write-Host '=== uninstall ==='
if (Test-Path -LiteralPath (Join-Path $install 'unins000.exe')) {
  $uninstaller = Start-Process (Join-Path $install 'unins000.exe') -ArgumentList @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') -PassThru -Wait
  Write-Host "uninstall exit=$($uninstaller.ExitCode)"
}
Remove-Item -Recurse -Force $install -ErrorAction SilentlyContinue
Write-Host "cleaned: $(-not (Test-Path $install))"
exit $acceptance
