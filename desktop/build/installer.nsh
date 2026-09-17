; Правило брандмауэра для режима Основы.
;
; Без него клиенты в локальной сети просто не увидят Основу, и выглядеть это
; будет как «программа сломалась»: окно на самом компьютере работает, а на
; соседнем — пустота. Добавляем при установке, когда права администратора уже
; получены: спрашивать их потом, из работающей программы, значит показывать
; человеку непонятный запрос посреди рабочего дня.
;
; Правило открывает один порт и только для частных сетей. В общедоступной сети
; (кафе, гостиница) Windows его не применит — и правильно сделает.

!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="FineCRM"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="FineCRM" dir=in action=allow protocol=TCP localport=7373 profile=private description="Доступ сотрудников мастерской к Основе FineCRM"'
!macroend

!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="FineCRM"'
!macroend
