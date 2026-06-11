; NSIS включения для RestOS v2 installer'а.
;
; Регистрируется через electron-builder.nsis.include в package.json.
; Запускается с правами админа (NSIS installer Windows автоматически
; повышает права при per-machine=true; при per-machine=false запускается
; от текущего юзера — netsh всё равно работает).

!macro customInstall
  ; Windows Firewall — разрешить входящие TCP-подключения на 3002 от LAN.
  ; Иначе бэк слушает 0.0.0.0:3002, но Windows блокирует чужие IP
  ; (телефоны официантов, ноутбуки через браузер из офиса).
  ;
  ; /F = silent overwrite если правило уже было (например, после обновления).
  ; netsh advfirewall — встроенный Windows инструмент, не требует доп. зависимостей.
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="RestOS v2 HTTP"'
  nsExec::ExecToLog 'netsh advfirewall firewall add rule name="RestOS v2 HTTP" dir=in action=allow protocol=TCP localport=3002 profile=any'
  DetailPrint "Windows Firewall: правило для порта 3002 добавлено"
!macroend

!macro customUnInstall
  ; При удалении v2 — убираем за собой firewall-правило.
  nsExec::ExecToLog 'netsh advfirewall firewall delete rule name="RestOS v2 HTTP"'
  DetailPrint "Windows Firewall: правило для порта 3002 удалено"
!macroend
