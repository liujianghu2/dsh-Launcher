#Requires -Version 5.1
<#
.SYNOPSIS
  Build the distributable DeepSeek Harness installer.

.DESCRIPTION
  Assembles a self-contained staging tree (Harness runtime, bundled Node.js
  runtime, launcher scripts, preinstalled plugins, icon) and compiles it into a
  single DeepSeekHarness-Setup-<version>-win-x64.exe with Inno Setup.

  The Harness runtime is copied from a working local installation rather than
  reinstalled, so the packaged dependency tree is exactly the one that has been
  verified to run. Everything else — the launcher, the generated VBS entry
  points, the deployment files and the preinstalled plugins — comes from this
  repository, so a build never inherits a stale copy from that installation.

.PARAMETER SourceRoot
  An installed DeepSeekHarness application directory to take `app\` and
  `assets\` from.

.PARAMETER NodeZip
  Official Node.js win-x64 archive to bundle. Its SHA-256 is verified against
  the release SHASUMS256.txt before use.

.PARAMETER SkipStage
  Reuse the existing staging tree and only recompile the installer.
#>
[CmdletBinding()]
param(
  [string]$SourceRoot = (Join-Path $env:LOCALAPPDATA 'Programs\DeepSeekHarness'),
  [string]$NodeZip,
  [switch]$SkipStage
)

$ErrorActionPreference = 'Stop'
$DistRoot = $PSScriptRoot
$Staging = Join-Path $DistRoot 'staging'
$InstallerDir = Join-Path $DistRoot 'installer'
$DistDir = Join-Path $DistRoot 'dist'
$CacheDir = Join-Path $DistRoot 'cache'
$Iscc = Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'
$PinFile = Join-Path $DistRoot 'node-runtime.json'

<#
  Read the pinned Node.js runtime.

  The version lives in exactly one file so the archive that gets bundled, the
  manifest shipped beside it, and the version every entry point checks against
  cannot drift apart — a mismatch there is what makes a copy behave differently
  on another computer.
#>
function Read-RuntimePin {
  param([Parameter(Mandatory)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { throw "build-package: missing runtime pin at $Path" }
  $pin = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  foreach ($field in 'version', 'platform', 'archiveSha256') {
    if (-not $pin.$field) { throw "build-package: runtime pin is missing '$field'" }
  }
  return $pin
}

$pin = Read-RuntimePin -Path $PinFile
if (-not $NodeZip) { $NodeZip = Join-Path $env:TEMP "node-v$($pin.version)-$($pin.platform).zip" }

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
  if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot 'app'))) {
    throw "build-package: $SourceRoot is not an installed application directory"
  }
  if (-not (Test-Path -LiteralPath $NodeZip)) { throw "build-package: Node archive not found at $NodeZip" }

  Write-Host "==> Verifying Node.js v$($pin.version) ($($pin.platform))"
  $nodeName = Split-Path -Leaf $NodeZip
  if ($nodeName -ne "node-v$($pin.version)-$($pin.platform).zip") {
    throw "build-package: $nodeName does not match the pinned version $($pin.version)"
  }
  $actual = (Get-FileHash -LiteralPath $NodeZip -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $pin.archiveSha256.ToLower()) {
    throw "build-package: SHA-256 mismatch for $nodeName (expected $($pin.archiveSha256), got $actual)"
  }
  Write-Host "    $actual OK"

  Write-Host '==> Staging the application'
  Remove-Item -Recurse -Force $Staging -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $Staging | Out-Null

  # The dependency tree holds tens of thousands of files; multithreaded
  # robocopy keeps the staging step in seconds instead of minutes.
  Invoke-Robocopy @((Join-Path $SourceRoot 'app'), (Join-Path $Staging 'app'),
    '/E', '/MT:16', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:2', '/W:1')
  Invoke-Robocopy @((Join-Path $SourceRoot 'assets'), (Join-Path $Staging 'assets'),
    '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:2', '/W:1')

  # Launcher code and launcher-generated scripts come from this repository, not
  # from the source installation: they are packaging behaviour (runtime pinning,
  # update, the preinstalled plugins), and taking them from a local install would
  # silently discard every change made here.
  Write-Host '==> Staging the launcher files'
  Copy-Item (Join-Path $DistRoot 'package-files\*') $Staging -Recurse -Force
  New-Item -ItemType Directory -Force -Path (Join-Path $Staging 'run') | Out-Null

  # Regenerate the launcher scripts inside the staged tree instead of inheriting
  # whatever the source installation last wrote, so the generated scripts always
  # carry this build's bundled-runtime lookup and overlay argument.
  Write-Host '==> Generating the packaged launcher scripts'
  & pwsh -NoProfile -File (Join-Path $Staging 'tools\install-shortcuts.ps1') -Root $Staging -SkipShortcuts
  if ($LASTEXITCODE -ne 0) { throw 'build-package: generating the packaged launcher scripts failed' }

  Write-Host '==> Staging the bundled Node.js runtime'
  Expand-NodeArchive -Archive $NodeZip -Destination (Join-Path $Staging 'runtime\node')

  $bundledVersion = (& (Join-Path $Staging 'runtime\node\node.exe') --version).Trim()
  if ($bundledVersion -ne "v$($pin.version)") {
    throw "build-package: bundled runtime reports $bundledVersion, expected v$($pin.version)"
  }
  Write-Host "    bundled Node.js $bundledVersion"

  # The manifest is what makes the runtime mandatory at run time: every entry
  # point treats its presence as "this is a packaged install, never borrow the
  # machine's Node.js". It is written after the version is proven above.
  $manifest = [ordered]@{
    version      = $pin.version
    platform     = $pin.platform
    archiveSha256 = $pin.archiveSha256
    pinnedBy     = 'dsh-dist/build-package.ps1'
  }
  $manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Staging 'runtime\node-runtime.json') -Encoding UTF8
  Write-Host "    wrote runtime\node-runtime.json (pinned $($pin.version))"

  # The preinstalled plugins are installed here, not fetched on the target
  # machine: the point of carrying them is that a recipient gets them without a
  # network install, and the bundled runtime's own npm keeps the resolution the
  # one this package was verified against.
  #
  # Nested, so each plugin keeps its own dependency tree inside its directory:
  # the launcher copies one plugin directory into a profile, and a hoisted tree
  # would leave those dependencies behind. Peers are omitted because the
  # plugins must share the installation's single copy of them — the launcher
  # places each plugin where Node's parent walk reaches app\node_modules.
  Write-Host '==> Installing the preinstalled plugins'
  $pluginManifest = Get-Content -LiteralPath (Join-Path $Staging 'plugins\package.json') -Raw | ConvertFrom-Json
  $bundledNpm = Join-Path $Staging 'runtime\node\node_modules\npm\bin\npm-cli.js'
  if (-not (Test-Path -LiteralPath $bundledNpm)) { throw "build-package: bundled npm not found at $bundledNpm" }
  $pluginPrefix = Join-Path $Staging 'plugins'
  Remove-Item -Recurse -Force (Join-Path $pluginPrefix 'node_modules') -ErrorAction SilentlyContinue
  Remove-Item -Force (Join-Path $pluginPrefix 'package-lock.json') -ErrorAction SilentlyContinue
  & (Join-Path $Staging 'runtime\node\node.exe') $bundledNpm install `
    --prefix $pluginPrefix `
    --install-strategy=nested --omit=peer --omit=dev --no-audit --no-fund --prefer-online --loglevel=error
  if ($LASTEXITCODE -ne 0) { throw "build-package: installing the preinstalled plugins failed ($LASTEXITCODE)" }

  # Plugins authored in this repository ship as source, not from a registry, and
  # are placed beside the installed ones so the launcher handles both the same
  # way. This runs after npm install so npm cannot prune them as extraneous. The
  # destination is the package's declared name, not its folder: a package whose
  # folder is spelled differently would otherwise be staged under a name the
  # profile cannot resolve.
  Write-Host '==> Staging the locally authored plugins'
  foreach ($local in Get-ChildItem (Join-Path $DistRoot 'package-files\plugins') -Directory) {
    if ($local.Name -eq 'node_modules') { continue }
    $localManifestPath = Join-Path $local.FullName 'package.json'
    if (-not (Test-Path -LiteralPath $localManifestPath)) {
      throw "build-package: locally authored plugin $($local.Name) has no package.json"
    }
    $localName = (Get-Content -LiteralPath $localManifestPath -Raw | ConvertFrom-Json).name
    if (-not $localName) { throw "build-package: locally authored plugin $($local.Name) declares no name" }
    $destination = Join-Path $Staging "plugins\node_modules\$localName"
    Remove-Item -Recurse -Force $destination -ErrorAction SilentlyContinue
    Copy-Item $local.FullName $destination -Recurse -Force
    Write-Host "    $localName（本仓库源码）"
  }

  $preinstalled = (Get-Content -LiteralPath (Join-Path $Staging 'plugins\preinstalled.json') -Raw | ConvertFrom-Json).bundles
  foreach ($plugin in $preinstalled) {
    $pluginDir = Join-Path $Staging "plugins\node_modules\$plugin"
    if (-not (Test-Path -LiteralPath (Join-Path $pluginDir 'package.json'))) {
      throw "build-package: preinstalled plugin $plugin was not installed"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $pluginDir 'cordis.patch.yml'))) {
      throw "build-package: preinstalled plugin $plugin carries no cordis.patch.yml bundle patch"
    }
    # A peer the plugin needs at run time must resolve from the profile's parent
    # walk, so anything the installer pins has to be a dependency of the plugin
    # itself — not something the build left for the target machine's registry.
    # A locally authored plugin has no dependency entry; its source is the pin.
    $version = (Get-Content -LiteralPath (Join-Path $pluginDir 'package.json') -Raw | ConvertFrom-Json).version
    $wanted = $pluginManifest.dependencies.$plugin
    if ($wanted -and $version -ne $wanted) {
      throw "build-package: preinstalled plugin $plugin resolved to $version, expected the pinned $wanted"
    }
    Write-Host "    $plugin $version$(if ($wanted) { '' } else { '（本仓库源码）' })"
  }

  $packagedStart = Get-Content -LiteralPath (Join-Path $Staging 'bin\start.vbs') -Raw
  if ($packagedStart -notmatch 'runtime\\node\\node.exe') {
    throw 'build-package: the packaged start.vbs has no bundled-runtime lookup'
  }
  if ($packagedStart -notmatch 'node-runtime\.json') {
    throw 'build-package: the packaged start.vbs does not treat the pinned runtime as mandatory'
  }
  if (-not (Test-Path -LiteralPath (Join-Path $Staging 'runtime\node-runtime.json'))) {
    throw 'build-package: the staged tree is missing runtime\node-runtime.json'
  }
  if (-not (Test-Path -LiteralPath (Join-Path $Staging 'bin\dsh-app.mjs'))) {
    throw 'build-package: the staged tree is missing bin\dsh-app.mjs'
  }
  $launcher = Get-Content -LiteralPath (Join-Path $Staging 'bin\dsh-app.mjs') -Raw
  if ($launcher -notmatch 'ensurePreinstalledPlugins') {
    throw 'build-package: the packaged launcher does not enable the preinstalled plugins'
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
