#Requires -Version 5.1
<#
.SYNOPSIS
  Install the one-click entry points for the local DeepSeek Harness application.

.DESCRIPTION
  Writes the console-free launcher scripts next to the application runtime and
  creates the Desktop and Start Menu shortcuts that point at them. Running the
  script again refreshes both the scripts and the shortcuts, so it is safe to
  repeat after moving or reinstalling the application.

.PARAMETER Root
  Application root directory. Defaults to the parent directory of this script.

.PARAMETER SkipDesktop
  Create only the Start Menu entries.

.PARAMETER SkipShortcuts
  Write the launcher scripts and the log file, but create no shortcuts. The
  packaging build uses this to prepare a staged tree, whose paths are not the
  ones the current user should get shortcuts for.
#>
[CmdletBinding()]
param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [switch]$SkipDesktop,
  [switch]$SkipShortcuts
)

$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path -LiteralPath $Root).Path
$BinDir = Join-Path $Root 'bin'
$AssetDir = Join-Path $Root 'assets'
$LogDir = Join-Path $Root 'logs'
$Icon = Join-Path $AssetDir 'dsh.ico'
$Launcher = Join-Path $BinDir 'dsh-app.mjs'

foreach ($required in @($Launcher, $Icon)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "install-shortcuts: missing $required" }
}
foreach ($directory in @($BinDir, $LogDir)) {
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
}

# Region: console-free launcher scripts

<#
  Resolve the Node.js runtime these scripts run on.

  A packaged install carries `runtime\node-runtime.json` and must use the pinned
  runtime it ships. Its dependencies are native-module builds for exactly that
  Node version, so borrowing whatever Node.js happens to be installed on the
  machine is what makes the same package open on one computer and fail on
  another. When the manifest is present the bundled runtime is therefore
  mandatory, and a missing one is reported instead of quietly substituted.

  A source install has no manifest and no bundled runtime, so it may fall back
  to an installed Node.js.
#>
$nodeResolution = @'
Dim pinnedRuntime
pinnedRuntime = fso.FileExists(root & "\runtime\node-runtime.json")
nodeExe = root & "\runtime\node\node.exe"
If Not pinnedRuntime Then
  Dim candidates, candidate
  candidates = Array( _
    shell.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe"), _
    shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%\nodejs\node.exe"), _
    shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\nodejs\node.exe"), _
    shell.ExpandEnvironmentStrings("%APPDATA%\npm\node.exe") )
  nodeExe = ""
  For Each candidate In candidates
    If nodeExe = "" Then
      If fso.FileExists(candidate) Then nodeExe = candidate
    End If
  Next
  If nodeExe = "" Then nodeExe = "node"
End If
'@

<#
  Stop with an explanation when a packaged install has lost its runtime.
  Without this the scripts would fall through to a foreign Node.js, which is
  precisely the environment difference the pin exists to remove.
#>
$runtimeGuard = @'
If pinnedRuntime And Not fso.FileExists(nodeExe) Then
  MsgBox "内置的 Node.js 运行时缺失（runtime\node\node.exe），安装不完整或已被改动。" & vbCrLf & vbCrLf & _
         "请重新运行安装程序修复后再启动。", 16, "DeepSeek Harness"
  WScript.Quit 1
End If
'@

<#
  FileSystemObject opens text as ANSI or UTF-16 only, with no UTF-8 mode, so it
  reads the launcher's UTF-8 reports as the system code page and turns every
  Chinese character into mojibake. ADODB.Stream is the only reading path in
  Windows Script Host that honours UTF-8.
#>
$readUtf8 = @'
Function ReadUtf8(path)
  Dim reader
  ReadUtf8 = ""
  If Not fso.FileExists(path) Then Exit Function
  Set reader = CreateObject("ADODB.Stream")
  reader.Type = 2
  reader.Charset = "utf-8"
  reader.Open
  reader.LoadFromFile path
  If Not reader.EOS Then ReadUtf8 = reader.ReadText
  reader.Close
End Function
'@

$startScript = @"
' DeepSeek Harness - one-click start without a console window.
Option Explicit

Dim shell, fso, root, nodeExe, command, status, message, errorFile
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

$nodeResolution

$runtimeGuard

$readUtf8

' --splash shows the starting window: a shortcut launch has no other feedback.
command = """" & nodeExe & """ """ & root & "\bin\dsh-app.mjs"" start --splash"
status = shell.Run(command, 0, True)

If status <> 0 Then
  message = "DeepSeek Harness 启动失败。"
  errorFile = root & "\logs\launcher.error.txt"
  If fso.FileExists(errorFile) Then
    message = message & vbCrLf & vbCrLf & ReadUtf8(errorFile)
  End If
  message = message & vbCrLf & vbCrLf & "完整日志：" & root & "\logs\dsh-web.log"
  MsgBox message, 16, "DeepSeek Harness"
End If
"@

<#
  The server is launched from a script rather than directly from the launcher
  because of two Windows behaviours that pull in opposite directions:

  - A child must be created detached to outlive the launcher that started it.
  - `detached` also asks for the child's own console, and `windowsHide` cannot
    suppress it, so the server would own a visible console window that every
    process the agent spawns inherits. That is the black window users see.

  `WshShell.Run` with window style 0 resolves both: the server gets its own
  console, hidden, and it is independent of this script, which exits at once.
#>
$serverScript = @"
' DeepSeek Harness - boot the server with its own hidden console.
Option Explicit

Dim shell, fso, root, nodeExe, port, quote, entry, logFile, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
port = WScript.Arguments(0)

$nodeResolution

' The launcher reports a missing runtime; this script only has to refuse to
' start the server on the wrong one.
If pinnedRuntime And Not fso.FileExists(nodeExe) Then WScript.Quit 1

quote = """"
entry = root & "\app\node_modules\@deepseek-ai\dsh\lib\bin.js"
logFile = root & "\logs\dsh-web.log"
' cmd strips the first and last quote of /c, so the whole command is wrapped in
' a second pair; a single leading quote mis-parses the quoted program path.
command = "cmd.exe /c " & quote & quote & nodeExe & quote & " " & quote & entry & quote & " web --port " & port & " >> " & quote & logFile & quote & " 2>&1" & quote
shell.Run command, 0, False
"@

$stopScript = @"
' DeepSeek Harness - stop the background server and report the outcome.
Option Explicit

Dim shell, fso, root, nodeExe, command, status, message, errorFile, resultFile, reported
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

$nodeResolution

$runtimeGuard

$readUtf8

command = """" & nodeExe & """ """ & root & "\bin\dsh-app.mjs"" stop"
status = shell.Run(command, 0, True)

resultFile = root & "\logs\launcher.result.txt"
reported = Trim(ReadUtf8(resultFile))
If reported <> "" Then message = reported Else message = "DeepSeek Harness 已停止。"

If status <> 0 Then
  errorFile = root & "\logs\launcher.error.txt"
  If fso.FileExists(errorFile) Then message = ReadUtf8(errorFile)
  MsgBox message, 16, "DeepSeek Harness"
Else
  MsgBox message, 64, "DeepSeek Harness"
End If
"@

$updateScript = @"
' DeepSeek Harness - report the installed and available versions, upgrading on request.
Option Explicit

Dim shell, fso, root, nodeExe, command, status, message, resultFile, reported
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))

$nodeResolution

$runtimeGuard

$readUtf8

command = """" & nodeExe & """ """ & root & "\bin\dsh-app.mjs"" update"
status = shell.Run(command, 0, True)

' The launcher records the version report, the outcome, and any failure in one
' file, so this dialog always states the current version and what happened.
resultFile = root & "\logs\launcher.result.txt"
reported = Trim(ReadUtf8(resultFile))
If reported <> "" Then
  message = reported
Else
  message = "检查更新没有返回结果，请查看日志：" & root & "\logs\dsh-web.log"
End If

If status <> 0 Then
  MsgBox message, 16, "DeepSeek Harness"
Else
  MsgBox message, 64, "DeepSeek Harness"
End If
"@

# Windows Script Host reads ANSI script files unless a byte-order mark selects
# Unicode, so the Chinese dialogs require the UTF-16LE encoding written here.
$unicode = [System.Text.UnicodeEncoding]::new($false, $true)
[System.IO.File]::WriteAllText((Join-Path $BinDir 'start.vbs'), $startScript, $unicode)
[System.IO.File]::WriteAllText((Join-Path $BinDir 'stop.vbs'), $stopScript, $unicode)
[System.IO.File]::WriteAllText((Join-Path $BinDir 'update.vbs'), $updateScript, $unicode)
[System.IO.File]::WriteAllText((Join-Path $BinDir 'run-server.vbs'), $serverScript, $unicode)

$logFile = Join-Path $LogDir 'dsh-web.log'
if (-not (Test-Path -LiteralPath $logFile)) { New-Item -ItemType File -Path $logFile | Out-Null }

# Region: shortcuts

if ($SkipShortcuts) {
  Write-Host "已写入启动脚本（未创建快捷方式）：$Root"
  return
}

$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$commandPrompt = Join-Path $env:SystemRoot 'System32\cmd.exe'
$consoleScript = Join-Path $Root 'dsh.cmd'
$shell = New-Object -ComObject WScript.Shell

<#
  Build one shortcut: launcher scripts run through wscript so no console
  window ever appears, and every entry carries the application icon.
#>
function New-AppShortcut {
  param(
    [Parameter(Mandatory)][string]$Path,
    [Parameter(Mandatory)][string]$Target,
    [string]$Arguments = '',
    [Parameter(Mandatory)][string]$Description
  )
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = $Target
  $shortcut.Arguments = $Arguments
  $shortcut.WorkingDirectory = $Root
  $shortcut.IconLocation = "$Icon,0"
  $shortcut.Description = $Description
  $shortcut.Save()
}

$startVbs = Join-Path $BinDir 'start.vbs'
$stopVbs = Join-Path $BinDir 'stop.vbs'
$updateVbs = Join-Path $BinDir 'update.vbs'
$startArguments = "`"$startVbs`""
$stopArguments = "`"$stopVbs`""
$updateArguments = "`"$updateVbs`""

$startMenuFolder = Join-Path ([Environment]::GetFolderPath('Programs')) 'DeepSeek Harness'
New-AppShortcut -Path (Join-Path $startMenuFolder 'DeepSeek Harness.lnk') -Target $wscript `
  -Arguments $startArguments -Description 'DeepSeek Harness 本地应用'
New-AppShortcut -Path (Join-Path $startMenuFolder '停止 DeepSeek Harness.lnk') -Target $wscript `
  -Arguments $stopArguments -Description '停止 DeepSeek Harness 后台服务'
New-AppShortcut -Path (Join-Path $startMenuFolder '检查更新.lnk') -Target $wscript `
  -Arguments $updateArguments -Description '检查并安装 DeepSeek Harness 新版本'
New-AppShortcut -Path (Join-Path $startMenuFolder '查看日志.lnk') -Target (Join-Path $env:SystemRoot 'System32\notepad.exe') `
  -Arguments "`"$logFile`"" -Description '查看 DeepSeek Harness 运行日志'
New-AppShortcut -Path (Join-Path $startMenuFolder '命令行工具.lnk') -Target $commandPrompt `
  -Arguments "/k `"`"$consoleScript`"`"" -Description 'DeepSeek Harness 命令行'

if (-not $SkipDesktop) {
  $desktop = [Environment]::GetFolderPath('Desktop')
  New-AppShortcut -Path (Join-Path $desktop 'DeepSeek Harness.lnk') -Target $wscript `
    -Arguments $startArguments -Description 'DeepSeek Harness 本地应用'
}

Write-Host "已安装快捷方式："
Write-Host "  开始菜单  $startMenuFolder"
if (-not $SkipDesktop) { Write-Host "  桌面      $([Environment]::GetFolderPath('Desktop'))\DeepSeek Harness.lnk" }
