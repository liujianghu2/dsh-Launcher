#Requires -Version 5.1
<#
.SYNOPSIS
  Build the distributable DeepSeek Harness installer.

.DESCRIPTION
  Assembles a self-contained staging tree (Harness runtime, bundled Node.js
  runtime, launcher scripts, icon) and compiles it into a single
  DeepSeekHarness-Setup-<version>-win-x64.exe with Inno Setup.

  The Harness runtime is copied from a working local installation rather than
  reinstalled, so the packaged dependency tree is exactly the one that has been
  verified to run.

.PARAMETER SourceRoot
  An installed DeepSeekHarness application directory to package.

.PARAMETER NodeZip
  Official Node.js win-x64 archive to bundle. Its SHA-256 is verified against
  the release SHASUMS256.txt before use.

.PARAMETER SkipStage
  Reuse the existing staging tree and only recompile the installer.
#>
[CmdletBinding()]
param(
  [string]$SourceRoot = (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeekHarness'),
  [string]$NodeZip = (Join-Path $env:TEMP 'node-v24.21.0-win-x64.zip'),
  [switch]$SkipStage
)

$ErrorActionPreference = 'Stop'
$DistRoot = $PSScriptRoot
$Staging = Join-Path $DistRoot 'staging'
$InstallerDir = Join-Path $DistRoot 'installer'
$DistDir = Join-Path $DistRoot 'dist'
$CacheDir = Join-Path $DistRoot 'cache'
$Iscc = Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'

<#
  Run robocopy and treat its documented success codes as success.
  robocopy reports "files copied" as exit code 1, which PowerShell would
  otherwise surface as a failure.
#>
function Invoke-Robocopy {
  param([Parameter(Mandatory)][string[]]$Arguments)
  & robocopy @Arguments | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed with exit code $LASTEXITCODE" }
  $global:LASTEXITCODE = 0
}

<#
  Extract a zip archive while stripping its single top-level directory, which is
  how the official Node.js archives are laid out.
#>
function Expand-NodeArchive {
  param([Parameter(Mandatory)][string]$Archive, [Parameter(Mandatory)][string]$Destination)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    foreach ($entry in $zip.Entries) {
      $relative = ($entry.FullName -split '/', 2)[-1]
      if ([string]::IsNullOrEmpty($relative)) { continue }
      $target = Join-Path $Destination ($relative -replace '/', '\')
      if ($entry.FullName.EndsWith('/')) {
        New-Item -ItemType Directory -Force -Path $target | Out-Null
        continue
      }
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
    }
  } finally {
    $zip.Dispose()
  }
}

if (-not (Test-Path -LiteralPath $Iscc)) { throw "build-package: Inno Setup compiler not found at $Iscc" }

if (-not $SkipStage) {
  if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot 'bin\dsh-app.mjs'))) {
    throw "build-package: $SourceRoot is not an installed application directory"
  }
  if (-not (Test-Path -LiteralPath $NodeZip)) { throw "build-package: Node archive not found at $NodeZip" }

  Write-Host '==> Verifying the Node.js archive against the published checksums'
  $nodeName = Split-Path -Leaf $NodeZip
  $checksumFile = Join-Path $CacheDir 'SHASUMS256.txt'
  if (-not (Test-Path -LiteralPath $checksumFile)) {
    New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
    $releases = ([regex]::Match($nodeName, '^node-(v[\d.]+)-')).Groups[1].Value
    & curl.exe -sS -L --max-time 120 "https://nodejs.org/dist/$releases/SHASUMS256.txt" -o $checksumFile
    if ($LASTEXITCODE -ne 0) { throw 'build-package: could not download the Node.js checksum list' }
  }
  $expected = (Select-String -Path $checksumFile -Pattern ([regex]::Escape($nodeName)) | Select-Object -First 1).Line
  if (-not $expected) { throw "build-package: $nodeName is absent from the checksum list" }
  $actual = (Get-FileHash -LiteralPath $NodeZip -Algorithm SHA256).Hash.ToLower()
  if ($expected -notlike "$actual*") { throw "build-package: SHA-256 mismatch for $nodeName" }
  Write-Host "    $actual OK"

  Write-Host '==> Staging the application'
  Remove-Item -Recurse -Force $Staging -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $Staging | Out-Null

  # The dependency tree holds tens of thousands of files; multithreaded
  # robocopy keeps the staging step in seconds instead of minutes.
  Invoke-Robocopy @((Join-Path $SourceRoot 'app'), (Join-Path $Staging 'app'),
    '/E', '/MT:16', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:2', '/W:1')
  foreach ($name in @('bin', 'assets')) {
    Invoke-Robocopy @((Join-Path $SourceRoot $name), (Join-Path $Staging $name),
      '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:2', '/W:1')
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $Staging 'tools') | Out-Null
  Copy-Item (Join-Path $SourceRoot 'tools\install-shortcuts.ps1') (Join-Path $Staging 'tools') -Force
  Copy-Item (Join-Path $SourceRoot 'assets\dsh.ico') (Join-Path $Staging 'assets') -Force

  # Regenerate the launcher scripts inside the staged tree instead of inheriting
  # whatever the source installation last wrote: the generated scripts must
  # contain the bundled-runtime lookup, and the source tree is only the place
  # the verified dsh-app.mjs comes from.
  Write-Host '==> Generating the packaged launcher scripts'
  & pwsh -NoProfile -File (Join-Path $Staging 'tools\install-shortcuts.ps1') -Root $Staging -SkipShortcuts
  if ($LASTEXITCODE -ne 0) { throw 'build-package: generating the packaged launcher scripts failed' }

  Write-Host '==> Staging the bundled Node.js runtime'
  Expand-NodeArchive -Archive $NodeZip -Destination (Join-Path $Staging 'runtime\node')

  Write-Host '==> Staging the launcher files'
  Copy-Item (Join-Path $DistRoot 'package-files\*') $Staging -Force
  New-Item -ItemType Directory -Force -Path (Join-Path $Staging 'run') | Out-Null

  $bundledVersion = (& (Join-Path $Staging 'runtime\node\node.exe') --version)
  Write-Host "    bundled Node.js $bundledVersion"

  $packagedStart = Get-Content -LiteralPath (Join-Path $Staging 'bin\start.vbs') -Raw
  if ($packagedStart -notmatch 'runtime\\node\\node.exe') {
    throw 'build-package: the packaged start.vbs has no bundled-runtime lookup'
  }
}

Write-Host '==> Fetching the Simplified Chinese installer translation'
$chineseIsl = Join-Path $InstallerDir 'ChineseSimplified.isl'
if (-not (Test-Path -LiteralPath $chineseIsl)) {
  & curl.exe -sS -L --max-time 120 `
    'https://raw.githubusercontent.com/jrsoftware/issrc/refs/heads/main/Files/Languages/ChineseSimplified.isl' `
    -o $chineseIsl
  if ($LASTEXITCODE -ne 0) { throw 'build-package: could not download ChineseSimplified.isl' }
}

Write-Host '==> Compiling the installer'
New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
& $Iscc (Join-Path $InstallerDir 'DeepSeekHarness.iss')
if ($LASTEXITCODE -ne 0) { throw "build-package: ISCC failed with exit code $LASTEXITCODE" }

$artifact = Get-ChildItem -Path $DistDir -Filter '*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $artifact) { throw 'build-package: no installer artifact was produced' }
$stagingMb = [math]::Round((Get-ChildItem $Staging -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host ''
Write-Host "安装包: $($artifact.FullName)"
Write-Host "大小  : $([math]::Round($artifact.Length / 1MB, 1)) MB (未压缩内容 $stagingMb MB)"
Write-Host "SHA256: $((Get-FileHash $artifact.FullName -Algorithm SHA256).Hash.ToLower())"
