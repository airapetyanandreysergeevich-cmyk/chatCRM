"use strict";

/**
 * Проверка перед сборкой установщика.
 *
 * Сборка идёт несколько минут и молча кладёт в установщик то, что нашла.
 * Забытая сборка интерфейса или недокачанные бинарники обнаружились бы уже на
 * чужом компьютере — там, где чинить дороже всего. Поэтому смотрим заранее и
 * говорим прямо, чего не хватает и что набрать.
 *
 *   node test/before-dist.js
 */

const fs = require("fs");
const path = require("path");

const here = path.join(__dirname, "..");
const repo = path.join(here, "..");

const needed = [
  {
    file: path.join(here, "vendor", "pgsql", "bin", "initdb.exe"),
    what: "Бинарники PostgreSQL для Windows",
    fix: "Распакуйте архив с сайта EnterpriseDB так, чтобы получилось desktop\\vendor\\pgsql\\bin",
  },
  {
    file: path.join(here, "build", "vc_redist.x64.exe"),
    what: "Библиотеки Visual C++",
    fix:
      "Скачайте https://aka.ms/vs/17/release/vc_redist.x64.exe в desktop\\build\\. " +
      "Без них initdb.exe не запускается на чистом компьютере вовсе — Windows отвечает кодом 3221225781.",
  },
  {
    file: path.join(here, "build", "icon.png"),
    what: "Иконка программы",
    fix: "Положите PNG 256×256 в desktop\\build\\icon.png",
  },
  {
    file: path.join(repo, "backend", "dist", "index.js"),
    what: "Собранный сервер",
    fix: "cd backend && npm install && npm run build",
  },
  {
    file: path.join(repo, "backend", "dist", "cli", "create-workshop.js"),
    what: "Скрипт создания мастерской",
    fix: "cd backend && npm run build (файл появился недавно — пересоберите)",
  },
  {
    file: path.join(repo, "backend", "node_modules", "prisma", "build", "index.js"),
    what: "Командная строка Prisma",
    fix: "cd backend && npm install",
  },
  {
    file: path.join(repo, "frontend", "dist", "index.html"),
    what: "Собранный интерфейс",
    fix: "cd frontend && npm install && npm run build",
  },
];

let missing = 0;
for (const item of needed) {
  if (fs.existsSync(item.file)) {
    console.log(`ok     ${item.what}`);
  } else {
    console.log(`НЕТ    ${item.what}`);
    console.log(`       ${item.fix}`);
    missing++;
  }
}

// Отдельно: клиент Prisma должен быть собран по текущей схеме, иначе сервер
// на чужом компьютере упадёт на первом же запросе к базе.
const client = path.join(repo, "backend", "node_modules", ".prisma", "client", "index.d.ts");
if (fs.existsSync(client)) {
  console.log("ok     Клиент Prisma собран");
} else {
  console.log("НЕТ    Клиент Prisma не собран");
  console.log("       cd backend && npx prisma generate");
  missing++;
}

// Имя, под которым программа живёт в системе.
//
// Electron берёт папку настроек из productName, а если его нет на верхнем
// уровне package.json — из name. Мы этого не заметили, и настройки легли в
// finecrm-desktop, пока деинсталлятор и все наши команды чистили FineCRM.
// Указатель на папку данных пережил и удаление, и переустановку: программа
// молча уходила в прежнюю папку, не спросив ни о чём. Стоило это вечера.
{
  const pkg = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8"));
  const inBuild = pkg.build && pkg.build.productName;
  if (pkg.productName && pkg.productName === inBuild) {
    console.log(`ok     Имя программы одно и то же везде (${pkg.productName})`);
  } else {
    console.log("НЕТ    Имя программы расходится");
    console.log(
      `       productName на верхнем уровне: ${pkg.productName ?? "нет"}, в build: ${inBuild ?? "нет"}. ` +
        "Они должны совпадать: из верхнего Electron берёт папку настроек, из build — имя установщика."
    );
    missing++;
  }
}

// Свежесть сборок.
//
// Установщик кладёт в себя backend/dist и frontend/dist такими, какими нашёл,
// и раньше проверка смотрела только, что они есть. Однажды сервер в
// установщике оказался четырёхдневной давности: сборку интерфейса обновили,
// а сервера — нет. Новый интерфейс спрашивал у старого сервера то, чего тот
// не умел, и выглядело это так, будто обновления просто не применились.
//
// Поэтому сверяем время: сборка не может быть старше самого нового файла
// своих исходников. npm run dist пересобирает обе сама; эта проверка — на
// случай, если установщик собирают в обход неё.
function newest(dir) {
  let latest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const t = entry.isDirectory() ? newest(full) : fs.statSync(full).mtimeMs;
    if (t > latest) latest = t;
  }
  return latest;
}

const fresh = [
  { what: "Сервер", built: path.join(repo, "backend", "dist", "index.js"), src: path.join(repo, "backend", "src"), fix: "cd backend && npm run build" },
  { what: "Интерфейс", built: path.join(repo, "frontend", "dist", "index.html"), src: path.join(repo, "frontend", "src"), fix: "cd frontend && npm run build" },
];
for (const f of fresh) {
  if (!fs.existsSync(f.built) || !fs.existsSync(f.src)) continue;
  const builtAt = fs.statSync(f.built).mtimeMs;
  const changedAt = newest(f.src);
  if (builtAt >= changedAt) {
    console.log(`ok     ${f.what}: сборка свежее исходников`);
  } else {
    const days = ((changedAt - builtAt) / 86_400_000).toFixed(1);
    console.log(`НЕТ    ${f.what}: сборка старше исходников на ${days} дн.`);
    console.log(`       ${f.fix}`);
    missing++;
  }
}

if (missing) {
  console.log(`\nСборка остановлена: не хватает ${missing}.`);
  process.exit(1);
}
console.log("\nВсё на месте, можно собирать.");
