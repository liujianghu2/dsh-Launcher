; Inno Setup script for the DeepSeek Harness local application.
;
; The package is self-contained: it carries the Harness runtime plus a Node.js
; runtime, so the target machine needs nothing preinstalled. SourceDir points at
; the distribution root, whose `staging` directory the build script populates
; before this script runs.

#define DistRoot SourcePath + ".."
#define AppVersion "0.1.5-rc.1"

[Setup]
AppId={{398B587A-084D-43F9-82C0-D8645A7D45AD}
AppName=DeepSeek Harness
AppVersion={#AppVersion}
AppVerName=DeepSeek Harness {#AppVersion}
AppPublisher=DeepSeek Harness
; The directory this application is already installed in, so a reinstall or an
; update lands where the user put it instead of asking again.
;
; Two independent memories, because they fail differently. `UsePreviousAppDir`
; reads the uninstall entry Windows keeps for the AppId — the same entry "Apps
; and features" uses — and {code:GetDefaultDirName} reads this installer's own
; marker, which survives the registry cleaners that delete uninstall entries and
; therefore leave Setup with nothing to remember. An explicit /DIR still wins
; over both, so scripted installs keep working.
DefaultDirName={code:GetDefaultDirName}
UsePreviousAppDir=yes
DefaultGroupName=DeepSeek Harness
DisableProgramGroupPage=yes
; A per-user installation: no administrator prompt, and the application can
; write its logs and pid file inside its own directory.
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
SetupIconFile={#DistRoot}\staging\assets\dsh.ico
UninstallDisplayIcon={app}\assets\dsh.ico
OutputDir={#DistRoot}\dist
OutputBaseFilename=DeepSeekHarness-Setup-{#AppVersion}-win-x64
AllowNoIcons=yes

[Languages]
Name: "chinese"; MessagesFile: "{#DistRoot}\installer\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checkedonce

[Files]
Source: "{#DistRoot}\staging\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\DeepSeek Harness"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\bin\start.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\assets\dsh.ico"; Comment: "启动 DeepSeek Harness"
Name: "{group}\停止 DeepSeek Harness"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\bin\stop.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\assets\dsh.ico"; Comment: "停止后台服务"
Name: "{group}\检查更新"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\bin\update.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\assets\dsh.ico"; Comment: "检查并安装新版本"
Name: "{group}\查看日志"; Filename: "{sys}\notepad.exe"; Parameters: """{app}\logs\dsh-web.log"""; WorkingDir: "{app}"; IconFilename: "{app}\assets\dsh.ico"; Comment: "查看运行日志"
Name: "{group}\命令行工具"; Filename: "{sys}\cmd.exe"; Parameters: "/k """"{app}\dsh.cmd"""""; WorkingDir: "{app}"; IconFilename: "{app}\assets\dsh.ico"; Comment: "打开命令行"
; The uninstall entry Windows keeps can be removed by registry cleaners, which
; leaves this application with no discoverable way out. A Start Menu item always
; reaches the same uninstaller the file system carries.
Name: "{group}\卸载 DeepSeek Harness"; Filename: "{uninstallexe}"; WorkingDir: "{app}"; IconFilename: "{app}\assets\dsh.ico"; Comment: "卸载 DeepSeek Harness"
Name: "{autodesktop}\DeepSeek Harness"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\bin\start.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\assets\dsh.ico"; Tasks: desktopicon

; No [Run] section on purpose. Its only entry launched the application from the
; finish page, which Setup renders as an opt-in checkbox; the installer therefore
; ends without starting anything, and the user starts the application from the
; shortcut it just created. Everything the entry did is still available there.

[Registry]
; This installer's own memory of where the application was installed. It is a key
; of ours rather than the uninstall entry, so the ordinary registry cleaners that
; sweep stale uninstall entries do not take the location with them. Removed on
; uninstall, which is what makes a fresh install after an uninstall ask again
; instead of resurrecting an empty directory.
Root: HKCU; Subkey: "Software\DeepSeek Harness"; ValueType: string; ValueName: "InstallDir"; \
    ValueData: "{app}"; Flags: uninsdeletekey

[UninstallDelete]
; State written while the application runs is not tracked by the installer.
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\run"
; The entries above are processed after the installer's own directory cleanup,
; so the now-empty installation directory needs a final explicit removal.
Type: dirifempty; Name: "{app}"

[Code]
{ The default directory shown on the "Select Destination Location" page.

  Setup calls this while building the wizard, so `UsePreviousAppDir` has already
  run and an explicit /DIR has already been applied — but a remembered directory
  is returned here only when it still holds this application, so a marker left
  over from an installation the user deleted by hand cannot send a new install
  into a stale path. }
function GetDefaultDirName(Param: String): String;
var
  Remembered: String;
begin
  if RegQueryStringValue(HKCU, 'Software\DeepSeek Harness', 'InstallDir', Remembered)
     and (Remembered <> '')
     and FileExists(AddBackslash(Remembered) + 'unins000.exe') then
    Result := Remembered
  else
    Result := ExpandConstant('{autopf}\DeepSeek Harness');
end;

{ The application writes its logs and process id next to itself, so a directory
  the user cannot write to would install successfully and then fail at the first
  launch. Reject such a directory while the choice can still be corrected. }
function NextButtonClick(CurPageID: Integer): Boolean;
var
  ProbeFile: String;
begin
  Result := True;
  if CurPageID = wpSelectDir then
  begin
    ForceDirectories(WizardDirValue);
    ProbeFile := AddBackslash(WizardDirValue) + 'write-probe.tmp';
    if SaveStringToFile(ProbeFile, 'probe', False) then
      DeleteFile(ProbeFile)
    else
    begin
      MsgBox('该目录不可写，程序无法在其中保存日志。' + #13#10 +
             '请换一个位置，例如“文档”或用户目录下的文件夹。', mbError, MB_OK);
      Result := False;
    end;
  end;
end;
