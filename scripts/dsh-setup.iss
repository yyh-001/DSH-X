#define MyAppName "DSH-X"
#ifndef MyAppVersion
#define MyAppVersion "0.1.12"
#endif
#define MyAppPublisher "yyh"
#define MyAppExeName "DSH.exe"
#ifndef MyAppIcon
#define MyAppIcon "dsh.ico"
#endif

[Setup]
AppId={{8F3C2A91-6B47-4E1D-9C5A-2D8E0F4B7A16}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
; 版本资源写全：未签名安装包尤其需要，信誉/启发式会读这些字段
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription={#MyAppName} 安装程序
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#MyAppVersion}
VersionInfoVersion={#MyAppVersion}
VersionInfoCopyright=Copyright (C) 2026 {#MyAppPublisher}
DefaultDirName={localappdata}\Programs\DSH
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=..\release
OutputBaseFilename=DSH-Setup
SetupIconFile=..\assets\dsh.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma2/max
SolidCompression=yes
; 跟随 Windows 显示语言，不复用旧安装语言，否则切换系统语言后仍会沿用旧值。
ShowLanguageDialog=no
LanguageDetectionMethod=uilanguage
UsePreviousLanguage=no
WizardStyle=modern
; 使用已有头像，安装器与启动器保持同一个角色；不额外引入皮肤 DLL。
WizardImageFile=..\assets\icon.png
WizardSmallImageFile=..\assets\icon.png
WizardImageBackColor=$FFF8F2
DisableWelcomePage=no
DisableDirPage=no
DisableReadyPage=no
WizardSizePercent=110
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
UsePreviousAppDir=yes
; force 而不是 yes：正常情况下启动器在安装程序检查之前就退出了，这一页不会出现；
; 万一还没退干净，force 直接结束它，而不是等它优雅关闭（那个等待会让这一页卡住）。
CloseApplications=force
RestartApplications=no
AllowNoIcons=yes

[Tasks]
; 不带 checkedonce 就是默认勾选；带上它反而变成「首次装默认不勾」，正是之前的行为
Name: "desktopicon"; Description: "{cm:desktopicon}"; GroupDescription: "{cm:additionaltasks}"

[Files]
Source: "..\release\DSH\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\assets\{#MyAppIcon}"; Tasks: desktopicon
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\assets\{#MyAppIcon}"
Name: "{group}\{cm:uninstall}"; Filename: "{uninstallexe}"

[Languages]
; 未提供翻译的系统语言回退英文；中文消息继承 Default.isl 后覆盖。
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "chinesesimplified"; MessagesFile: "compiler:Default.isl,ChineseSimplified.isl"

[CustomMessages]
chinesesimplified.desktopicon=创建桌面快捷方式
english.desktopicon=Create a desktop shortcut
chinesesimplified.additionaltasks=附加任务:
english.additionaltasks=Additional tasks:
chinesesimplified.launchapp=安装完成后启动
english.launchapp=Launch DSH-X when done
chinesesimplified.deleteinstaller=删除安装包
english.deleteinstaller=Delete the installer
chinesesimplified.uninstall=卸载 {#MyAppName}
english.uninstall=Uninstall {#MyAppName}

[Run]
; 下面两条只在向导模式里执行——带 postinstall 的条目要靠完成页触发，静默安装没有完成页，
; 所以它们一条都不会跑（实测：装完了、安装包还在、新版也没起来）。静默那条路由文件末尾的
; [Code] 负责，这里保留 skipifsilent 是为了让两条路互不重叠。
Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Description: "{cm:launchapp}"; Flags: nowait postinstall skipifsilent shellexec runasoriginaluser
; 「删除安装包」默认勾选，不想删的在完成页取消。
; 之所以拿 ping 拖三秒：此刻 setup.exe 自己还在运行，直接 del 会被拒绝；cmd 独立于安装
; 程序存活，等它退出之后再删就干净了。
Filename: "{cmd}"; Parameters: "/c ping -n 3 127.0.0.1 > nul & del /f /q ""{srcexe}"""; Description: "{cm:deleteinstaller}"; Flags: runhidden nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\node_modules"

[Code]
#include "installer-engine.iss"

// 静默安装（启动器就是用 /silent 拉起安装程序的）不显示任何向导页面，带 postinstall 的
// [Run] 条目因此一条都不会执行：新版没人拉起、安装包也留在临时目录里。所以这两件事在这里
// 补上，只在静默模式下做（向导模式交给完成页那两条）。
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  Lang: String;
begin
  // 让启动器知道安装时装的是什么语言（界面双语，见 server.js / public/index.html）
  if (CurStep = ssPostInstall) then begin
    if ActiveLanguage = 'english' then
      Lang := 'en'
    else
      Lang := 'zh';
    SaveStringToFile(ExpandConstant('{app}\lang.txt'), Lang, False);
    WriteBridgeDirectory;
  end;

  // 网页外壳负责完成页的启动与清理，避免内层引擎重复执行。
  if ExpandConstant('{param:WEBUI|0}') = '1' then Exit;

  if (CurStep <> ssDone) or (not WizardSilent) then
    Exit;
  // 先拉起新版
  ShellExec('', ExpandConstant('{app}\{#MyAppExeName}'), '', ExpandConstant('{app}'),
    SW_SHOWNORMAL, ewNoWait, ResultCode);
  // 再删安装包：此刻 setup.exe 自己还在运行，直接删会被拒绝，所以让 cmd 拖三秒再删
  Exec(ExpandConstant('{cmd}'),
    '/c ping -n 3 127.0.0.1 > nul & del /f /q "' + ExpandConstant('{srcexe}') + '"',
    '', SW_HIDE, ewNoWait, ResultCode);
end;
