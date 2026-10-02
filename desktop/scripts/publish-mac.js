"use strict";

/**
 * Выложить программу для Mac на сервер загрузок.
 *
 *   npm run publish-mac                 — файлы из desktop\dist-mac
 *   npm run publish-mac -- D:\Загрузки   — или из указанной папки
 *
 * Программу для Mac собирает GitHub (.github/workflows/mac.yml): там два
 * файла, для Mac на Apple Silicon и на Intel. Скачайте оба архива со страницы
 * сборки, распакуйте .dmg в desktop\dist-mac и запустите эту команду.
 *
 * Что кладём (в ~/repairshop/deploy/downloads на сервере):
 *   desktop/FineCRM-<версия>-mac-arm64.dmg, …-x64.dmg   — для истории версий;
 *   FineCRM-mac-arm64.dmg, FineCRM-mac-x64.dmg          — постоянные ссылки
 *                                                         для кнопки на сайте;
 *   desktop/mac.json — последним: по нему программа на Mac узнаёт о новой
 *   версии (updater.js → macFeed). Окажись он на сервере раньше .dmg,
 *   «Скачать» привело бы к файлу, который ещё загружается.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const here = path.join(__dirname, "..");
const version = require(path.join(here, "package.json")).version;
const from = path.resolve(process.argv[2] || path.join(here, "dist-mac"));
const target = process.env.FINECRM_PUBLISH_TARGET || "root@147.45.249.114:repairshop/deploy/downloads";
const [host, remoteDir] = target.split(/:(.+)/);

function fail(msg) {
  console.error(`\nНе выложено: ${msg}`);
  process.exit(1);
}

function run(cmd, args) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: false });
  if (r.error) fail(`${cmd} не запустился (${r.error.message}). В Windows 10/11 он входит в «Клиент OpenSSH».`);
  if (r.status !== 0) fail(`${cmd} завершился с кодом ${r.status}`);
}

if (!fs.existsSync(from)) fail(`нет папки ${from}. Распакуйте туда .dmg из сборки GitHub`);

const files = {};
for (const arch of ["arm64", "x64"]) {
  const name = `FineCRM-${version}-mac-${arch}.dmg`;
  if (fs.existsSync(path.join(from, name))) files[arch] = name;
}
if (!Object.keys(files).length) {
  const seen = fs.readdirSync(from).filter((f) => f.endsWith(".dmg"));
  fail(
    `в ${from} нет FineCRM-${version}-mac-*.dmg` +
      (seen.length ? ` (есть: ${seen.join(", ")} — сборка другой версии? Запустите её на GitHub заново)` : "")
  );
}
if (!files.arm64 || !files.x64) {
  console.warn(`Внимание: выкладываю только ${Object.keys(files).join(" и ")} — второй сборки в папке нет.`);
}

// Что нового — из того же файла, что и для Windows.
const notesFile = path.join(here, "release-notes.md");
const notes = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, "utf8").trim() : "";
const feed = path.join(os.tmpdir(), `finecrm-mac-${version}.json`);
fs.writeFileSync(feed, JSON.stringify({ version, notes, files }, null, 2), "utf8");

console.log(`Выкладываю версию ${version} для Mac в ${host}:${remoteDir}`);
run("ssh", [host, `mkdir -p ${remoteDir}/desktop`]);
run("scp", [...Object.values(files).map((f) => path.join(from, f)), `${host}:${remoteDir}/desktop/`]);
// Постоянные ссылки для кнопки «Mac» на странице входа — копией на сервере,
// чтобы не гнать файлы по сети второй раз.
const copies = Object.entries(files)
  .map(([arch, f]) => `cp ${remoteDir}/desktop/${f} ${remoteDir}/FineCRM-mac-${arch}.dmg`)
  .join(" && ");
run("ssh", [host, copies]);
run("scp", [feed, `${host}:${remoteDir}/desktop/mac.json`]);
fs.rmSync(feed, { force: true });

console.log(`\nГотово. Версия ${version} для Mac опубликована: кнопка «Mac» на странице входа и «Скачать» в программе.`);
