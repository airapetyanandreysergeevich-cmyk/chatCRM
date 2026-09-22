; Правило брандмауэра и уборка за собой при удалении.
;
; Без правила клиенты в локальной сети просто не увидят Основу, и выглядеть это
; будет как «программа сломалась»: окно на самом компьютере работает, а на
; соседнем — пустота. Добавляем при установке, когда права администратора уже
; получены: спрашивать их потом, из работающей программы, значит показывать
; человеку непонятный запрос посреди рабочего дня.
;
; Правило открывает один порт и только для сетей, помеченных как частные или
; доменные. В общедоступной сети Windows его не применит — и правильно сделает:
; в кафе и гостинице Основа не должна быть видна соседям. Если сеть мастерской
; помечена общедоступной (а Windows метит так почти всё новое), программа сама
; заметит это и предложит исправить — см. src/network.js.

; Куда ставить по умолчанию.
;
; Не в Program Files, а в корень системного диска. Причина не в красоте:
; программа возит с собой встроенный PostgreSQL, а тот запускается под
; урезанными правами и работает с папкой ресурсов постоянно. Program Files
; с его наследуемыми правами и виртуализацией — самое неудобное место для
; такого соседства, и именно оттуда пришла первая же поломка на чужом
; компьютере. Путь всё равно остаётся на виду, и человек может его изменить.
;
; electron-builder читает начальную папку из этой записи реестра, поэтому
; подменяем её до того, как установщик нарисует своё окно.
;
; Только если записи ещё нет. Обновление ставится туда же, где стоит
; программа, и берёт этот путь из той же записи: перезапиши мы её всегда,
; программа, установленная в D:\FineCRM, после обновления оказалась бы
; второй копией в C:\FineCRM — со своим ярлыком и без прежних настроек.
!macro finecrmDefaultLocation ROOT
  ClearErrors
  ReadRegStr $0 ${ROOT} "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCmp $0 "" 0 +2
  WriteRegExpandStr ${ROOT} "${INSTALL_REGISTRY_KEY}" InstallLocation "$%SystemDrive%\FineCRM"
!macroend

!macro preInit
  SetRegView 64
  !insertmacro finecrmDefaultLocation HKLM
  !insertmacro finecrmDefaultLocation HKCU
  SetRegView 32
  !insertmacro finecrmDefaultLocation HKLM
  !insertmacro finecrmDefaultLocation HKCU
!macroend

!macro customInstall
  ; Библиотеки Visual C++.
  ;
  ; Без них initdb.exe не запускается вовсе — Windows отвечает кодом
  ; 3221225781 («нет библиотеки») ещё до первой строки вывода. На машине
  ; разработчика они есть всегда, их ставят студии и десяток других программ;
  ; на чистом компьютере мастерской — почти никогда. Это ровно тот случай,
  ; когда «у меня работает» ничего не значит.
  ;
  ; Ставим молча и не смотрим на код возврата: 1638 означает «уже стоит
  ; версия новее», и это не повод останавливать установку.
  DetailPrint "Проверяю библиотеки Visual C++…"
  ExecWait '"$INSTDIR\resources\vc_redist.x64.exe" /install /quiet /norestart'

  nsExec::Exec 'netsh advfirewall firewall delete rule name="FineCRM"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="FineCRM" dir=in action=allow protocol=TCP localport=7373 profile=domain,private description="Доступ сотрудников мастерской к Основе FineCRM"'
!macroend

; Удаление.
;
; Программа оставляет после себя не только папку в Program Files: в профиле
; пользователя лежит указатель на папку данных и кэш окна. Именно они мешали
; поставить программу заново «с чистого листа» — и именно их приходилось
; вычищать руками, отыскивая команды. Теперь это делает деинсталлятор.
;
; Данные мастерской — база, фотографии, резервные копии — не трогаются молча
; никогда. Про них спрашиваем отдельно, и по умолчанию ответ «нет».
!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="FineCRM"'

  ; Обновление версии запускает старый деинсталлятор молча. Это не удаление,
  ; а замена: ни спрашивать, ни стирать настройки тогда нельзя — иначе каждое
  ; обновление заново спрашивало бы папку с базой.
  IfSilent finecrm_uninstall_done

  ; Настройки пишет программа, работающая под обычным пользователем. Даже
  ; когда деинсталлятор поднят с правами администратора, искать их надо в
  ; профиле текущего человека, а не в общесистемной папке.
  SetShellVarContext current

  ; Где лежат данные мастерской, программа оставляет одной строкой рядом с
  ; указателем — именно для этого случая: разбирать JSON в NSIS нечем.
  StrCpy $R1 ""
  ClearErrors
  FileOpen $R0 "$APPDATA\FineCRM\datadir.txt" r
  IfErrors 0 finecrm_uninstall_read
  ; Старое имя папки настроек. Пока в package.json не было productName на
  ; верхнем уровне, Electron брал имя из name и клал настройки в
  ; finecrm-desktop. Установки той поры надо уметь дочищать, иначе указатель
  ; на папку данных переживёт удаление и уведёт следующую установку в
  ; прежнее место — молча, не спросив.
  ClearErrors
  FileOpen $R0 "$APPDATA\finecrm-desktop\datadir.txt" r
  IfErrors finecrm_uninstall_hidden

finecrm_uninstall_read:
  FileRead $R0 $R1
  FileClose $R0

  ; Хвостовой перевод строки превратил бы путь в несуществующий.
  StrCpy $R2 $R1 1 -1
  StrCmp $R2 "$\n" 0 +2
  StrCpy $R1 $R1 -1
  StrCpy $R2 $R1 1 -1
  StrCmp $R2 "$\r" 0 +2
  StrCpy $R1 $R1 -1

finecrm_uninstall_hidden:
  ; Указатель на папку данных и кэш окна. Ничего из того, что создавал
  ; человек, здесь нет — только это и мешает начать установку заново.
  RMDir /r "$APPDATA\FineCRM"
  RMDir /r "$LOCALAPPDATA\FineCRM"
  RMDir /r "$APPDATA\finecrm-desktop"
  RMDir /r "$LOCALAPPDATA\finecrm-desktop"
  ; Папка обновлений называется с приставкой — её легко не заметить и оставить.
  RMDir /r "$LOCALAPPDATA\FineCRM-updater"
  RMDir /r "$LOCALAPPDATA\finecrm-desktop-updater"

  StrCmp $R1 "" finecrm_uninstall_done
  IfFileExists "$R1\*.*" 0 finecrm_uninstall_done
  MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 \
    "Удалить также данные мастерской?$\n$\n$R1$\n$\nБаза заказов, фотографии и резервные копии будут стёрты без возможности восстановить. Если сомневаетесь — ответьте «Нет»: папку всегда можно удалить потом." \
    IDNO finecrm_uninstall_done
  RMDir /r "$R1"

finecrm_uninstall_done:
!macroend
