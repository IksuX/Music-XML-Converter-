; Inno Setup 6 — instalator Nuty → MusicXML
; iscc /DAppVersion=0.4.1 installer\NutyMusicXML.iss
#ifndef AppVersion
  #define AppVersion "0.5.2"
#endif

[Setup]
AppId={{6C1E2B57-4A0C-4E5B-9D3F-1F6E0B7A9C21}
AppName=Nuty → MusicXML
AppVersion={#AppVersion}
AppVerName=Nuty → MusicXML {#AppVersion}
AppPublisher=Marcin Iskrzycki
DefaultDirName={autopf}\NutyMusicXML
DefaultGroupName=Nuty MusicXML
UninstallDisplayIcon={app}\NutyMusicXML.exe
OutputDir=..\dist
OutputBaseFilename=NutyMusicXML-Setup-{#AppVersion}
SetupIconFile=AppIcon.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ChangesAssociations=yes
CloseApplications=yes
RestartApplications=no
DisableProgramGroupPage=yes

[Languages]
Name: "pl"; MessagesFile: "compiler:Languages\Polish.isl"

[Tasks]
Name: "desktopicon"; Description: "Skrót na pulpicie"; GroupDescription: "Skróty:"
Name: "assoc"; Description: "Otwieraj pliki .musicxml i .mxl w odtwarzaczu Nuty → MusicXML"; GroupDescription: "Pliki:"; Flags: unchecked

[Files]
Source: "..\dist\NutyMusicXML\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Nuty → MusicXML"; Filename: "{app}\NutyMusicXML.exe"
Name: "{autodesktop}\Nuty → MusicXML"; Filename: "{app}\NutyMusicXML.exe"; Tasks: desktopicon

[Registry]
Root: HKA; Subkey: "Software\Classes\NutyMusicXML.score"; ValueType: string; ValueData: "MusicXML"; Flags: uninsdeletekey; Tasks: assoc
Root: HKA; Subkey: "Software\Classes\NutyMusicXML.score\DefaultIcon"; ValueType: string; ValueData: "{app}\NutyMusicXML.exe,0"; Tasks: assoc
Root: HKA; Subkey: "Software\Classes\NutyMusicXML.score\shell\open\command"; ValueType: string; ValueData: """{app}\NutyMusicXML.exe"" ""%1"""; Tasks: assoc
Root: HKA; Subkey: "Software\Classes\.musicxml\OpenWithProgids"; ValueType: string; ValueName: "NutyMusicXML.score"; ValueData: ""; Flags: uninsdeletevalue; Tasks: assoc
Root: HKA; Subkey: "Software\Classes\.mxl\OpenWithProgids"; ValueType: string; ValueName: "NutyMusicXML.score"; ValueData: ""; Flags: uninsdeletevalue; Tasks: assoc
; "Otwórz za pomocą" for PDF and images
Root: HKA; Subkey: "Software\Classes\Applications\NutyMusicXML.exe\shell\open\command"; ValueType: string; ValueData: """{app}\NutyMusicXML.exe"" ""%1"""; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\Applications\NutyMusicXML.exe\SupportedTypes"; ValueType: string; ValueName: ".pdf"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\NutyMusicXML.exe\SupportedTypes"; ValueType: string; ValueName: ".jpg"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\NutyMusicXML.exe\SupportedTypes"; ValueType: string; ValueName: ".png"; ValueData: ""
Root: HKA; Subkey: "Software\Classes\Applications\NutyMusicXML.exe\SupportedTypes"; ValueType: string; ValueName: ".musicxml"; ValueData: ""

[Run]
Filename: "{app}\NutyMusicXML.exe"; Description: "Uruchom Nuty → MusicXML"; Flags: nowait postinstall skipifsilent
; po automatycznej aktualizacji (instalator uruchomiony z aplikacji z /SILENT) — uruchom ponownie
Filename: "{app}\NutyMusicXML.exe"; Flags: nowait; Check: WizardSilent

[Code]
// WebView2 is built into Windows 11 and current Windows 10. When it is missing, show where to get it.
function WebView2Installed: Boolean;
var v: String;
begin
  Result :=
    RegQueryStringValue(HKLM, 'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v) or
    RegQueryStringValue(HKCU, 'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v) or
    RegQueryStringValue(HKLM, 'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}', 'pv', v);
  Result := Result and (v <> '') and (v <> '0.0.0.0');
end;

procedure CurStepChanged(CurStep: TSetupStep);
var code: Integer;
begin
  if (CurStep = ssPostInstall) and not WizardSilent and not WebView2Installed then
    if MsgBox('Aplikacja potrzebuje składnika Microsoft Edge WebView2 Runtime, którego nie znaleziono.' + #13#10 +
              'Otworzyć stronę pobierania?', mbConfirmation, MB_YESNO) = IDYES then
      ShellExec('open', 'https://go.microsoft.com/fwlink/p/?LinkId=2124703', '', '', SW_SHOWNORMAL, ewNoWait, code);
end;
