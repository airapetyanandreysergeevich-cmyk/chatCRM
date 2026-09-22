"use strict";

/**
 * Выложить собранную версию на сервер обновлений.
 *
 *   npm run publish-release
 *
 * Берёт из desktop/dist три файла текущей версии — установщик, его .blockmap
 * и latest.yml — и кладёт в ~/repairshop/deploy/downloads/desktop на сервере.
 * Оттуда их раздаёт nginx по https://finecrm.ru/download/desktop/, и
 * установленные программы находят новую версию при следующей проверке.
 *
 * Порядок важен: сначала установщик и карта блоков, latest.yml — последним.
 * Программа, прочитавшая latest.yml, сразу идёт за установщиком; окажись
 * latest.yml на сервере раньше, она пошла бы за файлом, который ещё
 * загружается, и получила бы ошибку контрольной суммы.
 *
 * Старые .blockmap не удаляем никогда: по карте блоков установленной версии
 * программа понимает, какие куски нового установщика ей уже не нужны. Без
 * неё обновление всё равно пройдёт, но скачает все 400 МБ.
 *
 * Куда выкладывать, можно поменять переменной FINECRM_PUBLISH_TARGET, например
 *   set FINECRM_PUBLISH_TARGET=root@147.45.249.114:repairshop/deploy/downloads
 */

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const here = path.join(__dirname, "..");
const dist = path.join(here, "dist");
const version = require(path.join(here, "package.json")).version;
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

const exe = `FineCRM-${version}-setup.exe`;
const files = [exe, `${exe}.blockmap`, "latest.yml"].map((f) => path.join(dist, f));
for (const f of files) {
  if (!fs.existsSync(f)) fail(`нет ${path.relative(here, f)}. Соберите версию ${version}: npm run release`);
}

// Сверяем latest.yml с установщиком: выложить от одной сборки yml, а от
// другой exe — значит сломать обновление у всех разом.
const yml = fs.readFileSync(files[2], "utf8");
const ymlVersion = (/^version:\s*(.+)$/m.exec(yml) || [])[1];
const ymlSha = (/^sha512:\s*(.+)$/m.exec(yml) || [])[1];
if (ymlVersion?.trim() !== version) fail(`в latest.yml версия ${ymlVersion}, а в package.json ${version}`);
const sha = crypto.createHash("sha512").update(fs.readFileSync(files[0])).digest("base64");
if (ymlSha?.trim() !== sha) fail("контрольная сумма в latest.yml не совпадает с установщиком — пересоберите");

const size = (fs.statSync(files[0]).size / 1048576).toFixed(0);
console.log(`Выкладываю версию ${version} (${size} МБ) в ${host}:${remoteDir}/desktop`);

run("ssh", [host, `mkdir -p ${remoteDir}/desktop`]);
run("scp", [files[0], files[1], `${host}:${remoteDir}/desktop/`]);
// Ссылка «Скачать для Windows» на сайте ведёт на FineCRM-setup.exe —
// копируем на сервере, чтобы не гнать 400 МБ по сети второй раз.
run("ssh", [host, `cp ${remoteDir}/desktop/${exe} ${remoteDir}/FineCRM-setup.exe`]);
run("scp", [files[2], `${host}:${remoteDir}/desktop/latest.yml`]);

console.log(`\nГотово. Версия ${version} опубликована: программы увидят её при следующей проверке (при запуске или в течение шести часов).`);
