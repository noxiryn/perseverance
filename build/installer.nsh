; Included automatically by electron-builder (nsis.include defaults to build/installer.nsh).
; If an auto-updater is ever added, drop the customInstall half (electron-updater needs the copy).
; Perseverance has no auto-updater (build.publish: null). electron-builder's stock
; installApplicationFiles still copies the Setup exe to
; %LOCALAPPDATA%\perseverance-updater\installer.exe for electron-updater, and the
; uninstaller never removes it. Drop it right after it is made (customInstall runs
; after installApplicationFiles) and on uninstall (also cleans up older installs).
; The copy is always per-user, so switch to the current-user context in all-users mode.
!macro customInstall
  ${if} $installMode == "all"
    SetShellVarContext current
  ${endif}
  Delete "$LOCALAPPDATA\perseverance-updater\installer.exe"
  RMDir "$LOCALAPPDATA\perseverance-updater"
  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}
!macroend

!macro customUnInstall
  ${if} $installMode == "all"
    SetShellVarContext current
  ${endif}
  RMDir /r "$LOCALAPPDATA\perseverance-updater"
  ${if} $installMode == "all"
    SetShellVarContext all
  ${endif}
!macroend
