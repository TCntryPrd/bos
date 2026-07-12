; BOS — Custom NSIS Installer Script
; Adds firewall exception for voice streaming WebSocket connections

!macro customInstall
  ; Add Windows Firewall exception for BOS
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="BOS" dir=in action=allow program="$INSTDIR\BOS.exe" enable=yes profile=private'
!macroend

!macro customUnInstall
  ; Remove firewall rule on uninstall
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="BOS"'
!macroend
