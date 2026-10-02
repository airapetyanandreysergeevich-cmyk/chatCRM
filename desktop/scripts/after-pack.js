"use strict";

/**
 * После упаковки программы для Mac — подпись «своей» подписью (ad-hoc).
 *
 * Платной подписи Apple у нас нет (см. README, раздел про Mac). Совсем без
 * подписи программа на Mac с процессором Apple не запускается вовсе, а macOS
 * называет её «повреждённой». С подписью ad-hoc она запускается после
 * подтверждения в «Конфиденциальность и безопасность → Всё равно открыть».
 *
 * electron-builder с `identity: null` подписывать не берётся — делаем сами,
 * до упаковки в .dmg. Бинарники PostgreSQL внутри уже подписаны при сборке
 * (scripts/build-pg-mac.sh); --deep подписывает вложенные части Electron.
 * На Windows этот шаг ничего не делает.
 */

const { execFileSync } = require("child_process");
const path = require("path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • подпись ad-hoc: ${app}`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
};
