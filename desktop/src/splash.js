"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

/** Метка «идёт установка»: по ней заставка понимает, что пора закрыться. */
const flagPath = (dir) => path.join(dir, "updating.flag");

/**
 * Заставка на время работы установщика.
 *
 * Самая неприятная минута обновления — после того, как программа закрылась:
 * установщик работает молча, окна нет, значка в трее нет, и человек решает,
 * что всё повисло, и лезет запускать программу заново. Показать что-либо из
 * самой программы в этот момент нельзя — её уже нет, и её файлы как раз
 * переписываются.
 *
 * Поэтому заставку показывает отдельная программа Windows — PowerShell с
 * обычным окном и бегущей полоской. Она живёт сама по себе и закрывается,
 * когда исчезает файл-метка: его удаляет новая версия при запуске. На случай,
 * если запуск не состоялся вовсе, у заставки есть свой срок в пять минут и клавиша Esc —
 * висеть на экране вечно она не должна.
 *
 * Не получилось — не беда: обновление идёт как шло, просто молча.
 */
function start(dir, version) {
  if (process.platform !== "win32") return;
  try {
    fs.writeFileSync(flagPath(dir), String(version || ""));
    const script = path.join(dir, "updating.ps1");
    // С меткой порядка байтов: без неё PowerShell 5 читает файл как ANSI и
    // показывает вместо русского текста мусор.
    fs.writeFileSync(script, "\ufeff" + SPLASH_PS1, "utf8");
    const child = spawn(
      "powershell.exe",
      // Ни -WindowStyle Hidden, ни windowsHide: Windows передаёт «спрятать»
      // первому окну, которое покажет программа, — и прятал заставку вместе
      // с консолью. Консоль скрывает сам скрипт, уже после запуска.
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, flagPath(dir)],
      { detached: true, stdio: "ignore", windowsHide: false }
    );
    child.unref();
  } catch {
    /* заставки не будет — обновление от этого не пострадает */
  }
}

/** Новая версия запустилась — заставку можно убирать. */
function stop(dir) {
  try {
    fs.unlinkSync(flagPath(dir));
  } catch {
    /* метки нет — значит, и заставки нет */
  }
}

/** Окно заставки: пока есть файл-метка, оно на экране. */
const SPLASH_PS1 = [
  "param([string]$Marker)",
  // Чёрное окно консоли за заставкой человеку ни к чему — прячем его сами.
  "$hide = '[DllImport(\"kernel32.dll\")] public static extern IntPtr GetConsoleWindow(); [DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int n);'",
  "Add-Type -MemberDefinition $hide -Name Win -Namespace Native | Out-Null",
  "[void][Native.Win]::ShowWindow([Native.Win]::GetConsoleWindow(), 0)",
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "$f = New-Object Windows.Forms.Form",
  "$f.FormBorderStyle = 'None'",
  "$f.StartPosition = 'CenterScreen'",
  "$f.Size = New-Object Drawing.Size(520, 190)",
  "$f.TopMost = $true",
  "$f.ShowInTaskbar = $true",
  "$f.Text = 'Обновление FineCRM'",
  "$f.BackColor = [Drawing.ColorTranslator]::FromHtml('#0F1117')",
  "$title = New-Object Windows.Forms.Label",
  "$title.Text = 'Устанавливается обновление FineCRM'",
  "$title.ForeColor = [Drawing.ColorTranslator]::FromHtml('#E7EAF2')",
  "$title.Font = New-Object Drawing.Font('Segoe UI', 13, [Drawing.FontStyle]::Bold)",
  "$title.SetBounds(30, 30, 460, 30)",
  "$f.Controls.Add($title)",
  "$bar = New-Object Windows.Forms.ProgressBar",
  "$bar.Style = 'Marquee'",
  "$bar.MarqueeAnimationSpeed = 30",
  "$bar.SetBounds(30, 74, 460, 10)",
  "$f.Controls.Add($bar)",
  "$hint = New-Object Windows.Forms.Label",
  "$hint.Text = 'Это занимает около минуты. Программа запустится сама — не выключайте компьютер.'",
  "$hint.ForeColor = [Drawing.ColorTranslator]::FromHtml('#9096A3')",
  "$hint.Font = New-Object Drawing.Font('Segoe UI', 9.5)",
  "$hint.SetBounds(30, 100, 460, 50)",
  "$f.Controls.Add($hint)",
  "$deadline = (Get-Date).AddMinutes(5)",
  "$timer = New-Object Windows.Forms.Timer",
  "$timer.Interval = 1000",
  "$timer.Add_Tick({ if (-not (Test-Path $Marker) -or (Get-Date) -gt $deadline) { $timer.Stop(); $f.Close() } })",
  "$timer.Start()",
  // Поверх всех окон и в фокусе: заставка должна попасться на глаза сразу.
  "$f.Add_Shown({ $f.Activate() })",
  // Если обновление всё-таки не пошло — окно можно убрать клавишей Esc,
  // не дожидаясь, пока выйдет его срок.
  "$f.KeyPreview = $true",
  "$f.Add_KeyDown({ if ($_.KeyCode -eq 'Escape') { $timer.Stop(); $f.Close() } })",
  "[void]$f.ShowDialog()",
].join("\r\n");

module.exports = { start, stop, flagPath, SPLASH_PS1 };
