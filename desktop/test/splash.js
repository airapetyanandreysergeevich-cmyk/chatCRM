"use strict";

/**
 * Проверка заставки, которая висит на экране, пока работает установщик.
 *
 * На Linux проверяется только то, что скрипт собирается целиком и не трогает
 * чужую систему. Настоящая проверка — на Windows: окно должно появиться,
 * показать бегущую полоску и закрыться само, когда исчезнет файл-метка.
 *
 *   node test/splash.js        обычная проверка
 *   node test/splash.js --show на Windows: показать окно на 8 секунд
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const splash = require("../src/splash");

let bad = 0;
const check = (ok, what) => {
  console.log((ok ? "ok   " : "БЕДА ") + " " + what);
  if (!ok) bad++;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finecrm-splash-"));

check(splash.SPLASH_PS1.includes("param([string]$Marker)"), "скрипт принимает путь к метке");
check(splash.SPLASH_PS1.includes("Test-Path $Marker"), "закрывается, когда метка исчезла");
check(splash.SPLASH_PS1.includes("AddMinutes(5)"), "и в любом случае не висит дольше пяти минут");
check(!/(?<!\r)\n/.test(splash.SPLASH_PS1), "строки скрипта склеены переводом строки Windows");
check(splash.flagPath(dir) === path.join(dir, "updating.flag"), "метка лежит рядом с настройками");

// Снять метку можно и когда её нет: новая версия запускается и после
// обычного запуска, не только после обновления.
splash.stop(dir);
check(true, "снятие несуществующей метки не роняет запуск");

if (process.platform === "win32") {
  splash.start(dir, "0.0.0-проверка");
  check(fs.existsSync(splash.flagPath(dir)), "метка поставлена");
  check(fs.existsSync(path.join(dir, "updating.ps1")), "скрипт записан");
  const withBom = fs.readFileSync(path.join(dir, "updating.ps1"));
  check(withBom[0] === 0xef && withBom[1] === 0xbb && withBom[2] === 0xbf, "скрипт записан с меткой порядка байтов");
  const wait = process.argv.includes("--show") ? 8000 : 2500;
  console.log(`окно должно быть на экране; закроется через ${wait / 1000} с`);
  setTimeout(() => {
    splash.stop(dir);
    check(!fs.existsSync(splash.flagPath(dir)), "метка снята — окно должно закрыться само");
    done();
  }, wait);
} else {
  splash.start(dir, "0.0.0");
  check(!fs.existsSync(splash.flagPath(dir)), "не на Windows заставка не запускается вовсе");
  done();
}

function done() {
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(bad ? `\nпровалов: ${bad}` : "\nвсе проверки прошли");
  process.exitCode = bad ? 1 : 0;
}
