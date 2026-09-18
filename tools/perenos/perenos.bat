@echo off
rem Двойной щелчок по этому файлу запускает перенос.
rem
rem Node.js в мастерской обычно нет, зато есть установленная FineCRM: внутри
rem неё лежит тот же самый Node, и переменная ELECTRON_RUN_AS_NODE заставляет
rem программу отработать как он. Так утилита запускается там, где ничего,
rem кроме нашей же программы, не установлено.
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel%==0 (
  node perenos.js
  goto konec
)

set FINECRM=%SystemDrive%\FineCRM\FineCRM.exe
if exist "%FINECRM%" (
  set ELECTRON_RUN_AS_NODE=1
  "%FINECRM%" perenos.js
  goto konec
)

echo.
echo Не нашёл, чем запустить: ни Node.js, ни установленной FineCRM.
echo Поставьте FineCRM или Node.js с nodejs.org и запустите снова.

:konec
echo.
pause
