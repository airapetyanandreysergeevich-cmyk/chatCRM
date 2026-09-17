"use strict";

/**
 * Проверка поиска того, что едет вместе с программой.
 *
 * Здесь уже была настоящая ошибка, и стоит она отдельной проверки:
 * `process.resourcesPath` существует всегда, когда работает Electron, и при
 * запуске командой `electron .` указывает внутрь самого Electron. Программа
 * честно шла искать initdb.exe в его ресурсах и падала с ENOENT.
 *
 *   node test/paths.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

let fails = 0;
const check = (ok, msg) => {
  console.log((ok ? "ok    " : "БЕДА  ") + msg);
  if (!ok) fails++;
};

/** Запускаем поиск в отдельном процессе: пути вычисляются при загрузке модуля. */
function ask(what, env) {
  const { execFileSync } = require("child_process");
  const code = `
    const p = require(${JSON.stringify(path.join(__dirname, "..", "src", "paths.js"))});
    try { process.stdout.write(p.${what}()); }
    catch (e) { process.stdout.write("ОШИБКА: " + e.message); }
  `;
  return execFileSync(process.execPath, ["-e", code], {
    env: { ...process.env, FINECRM_PG_BIN: "", FINECRM_BACKEND: "", FINECRM_FRONTEND: "", ...env },
    encoding: "utf8",
  });
}

const room = fs.mkdtempSync(path.join(os.tmpdir(), "finecrm-paths-"));
const fakeResources = path.join(room, "electron", "dist", "resources");
fs.mkdirSync(path.join(fakeResources, "pgsql", "bin"), { recursive: true });

// 1. Ресурсы Electron не должны перебивать папку разработки
const vendor = path.join(__dirname, "..", "vendor", "pgsql", "bin");
const hasVendor = fs.existsSync(vendor);
const pg = ask("postgresBinDir", {});
if (hasVendor) {
  check(pg === path.resolve(vendor), `в разработке берём свои бинарники (${pg})`);
} else {
  check(
    pg.startsWith("ОШИБКА") && pg.includes("vendor"),
    `без бинарников — понятная ошибка с подсказкой, а не ENOENT (${pg})`
  );
}

// 2. Переменная окружения сильнее всего: на ней держатся проверки на Linux
const forced = ask("postgresBinDir", { FINECRM_PG_BIN: "/подставленный/путь" });
check(forced === "/подставленный/путь", "переменная окружения перебивает поиск");

// 3. Сервер ищем по dist/index.js, а не по наличию папки backend
const be = ask("backendDir", {});
const repoBackendBuilt = fs.existsSync(path.join(__dirname, "..", "..", "backend", "dist", "index.js"));
if (repoBackendBuilt) {
  check(!be.startsWith("ОШИБКА"), `собранный сервер найден (${be})`);
} else {
  check(
    be.startsWith("ОШИБКА") && be.includes("npm run build"),
    `несобранный сервер объяснён словами, что делать (${be})`
  );
}

// 4. Интерфейс — так же
const fe = ask("frontendDir", {});
check(
  !fe.startsWith("ОШИБКА") || fe.includes("npm run build"),
  `интерфейс: либо найден, либо объяснено, как собрать (${fe})`
);

// 5. Указатель на папку данных.
//
// Рядом с ним лежит тот же путь простой строкой — его читает деинсталлятор,
// чтобы спросить, удалять ли данные мастерской. Разбирать JSON в NSIS нечем,
// а не спросить — значит однажды стереть чужую базу молча. Лишний перевод
// строки в конце превратил бы путь в несуществующий, поэтому его здесь нет.
{
  const location = require("../src/location");
  const profile = path.join(room, "профиль");
  const dataDir = path.join(room, "данные мастерской");

  location.writeLocation(profile, { mode: "main", dataDir });
  const plain = path.join(profile, "datadir.txt");
  check(fs.existsSync(plain), "путь к данным оставлен отдельной строкой для деинсталлятора");
  check(fs.readFileSync(plain, "utf8") === dataDir, "путь записан ровно, без перевода строки");
  check(location.readLocation(profile).dataDir === dataDir, "указатель читается обратно");

  // У клиента своей папки данных нет вовсе — и удалять деинсталлятору нечего.
  location.writeLocation(profile, { mode: "client", connectTo: "http://192.168.1.40:7373" });
  check(!fs.existsSync(plain), "у клиента лишний путь не остаётся");

  location.writeLocation(profile, { mode: "main", dataDir });
  location.forgetLocation(profile);
  check(!fs.existsSync(plain) && !location.readLocation(profile), "сброс убирает оба файла");

  // Облачные папки отсекаем до создания базы, а не после: кластер это тысячи
  // мелких файлов, синхронизация растягивает его создание до бесконечности,
  // а живую базу может испортить.
  const cloudy = [
    "C:\\Users\\Иван\\OneDrive\\Документы\\FineCRM",
    "C:\\Users\\Иван\\Dropbox\\FineCRM",
    "C:\\Users\\Иван\\Google Drive\\FineCRM",
    "C:\\Users\\Иван\\YandexDisk\\FineCRM",
  ];
  const caught = cloudy.filter((p) => location.checkDataDir(p).ok === false);
  check(caught.length === cloudy.length, `облачные папки не принимаются (${caught.length} из ${cloudy.length})`);
  check(
    /OneDrive/.test(location.checkDataDir(cloudy[0]).reason),
    "и сказано, какое именно облако мешает"
  );

  // Предлагать папку, в которой программа откажется работать, нельзя: человек
  // выбирает её один раз и обычно не глядя. Windows перенаправляет «Документы»
  // в OneDrive, ничего об этом не сказав, — значит, предложение должно
  // проверяться тем же правилом, что и выбор.
  check(
    location.cloudSync("C:\\Users\\Иван\\OneDrive\\Документы\\FineCRM") === "OneDrive",
    "перенаправленные в облако «Документы» распознаются до создания чего-либо"
  );
  check(location.cloudSync(path.join(room, "FineCRM")) === null, "обычный путь облаком не считается");

  // Что программа предлагает по умолчанию. Человек выбирает папку один раз и
  // обычно не глядя, поэтому предложение обязано быть рабочим.
  {
    const диск = path.join(room, "диск");
    const дом = path.join(диск, "Users", "Иван");
    fs.mkdirSync(дом, { recursive: true });

    // Корень доступен — предлагаем короткий путь на нём.
    const наДиске = location.suggestDataDir({ home: дом, documents: path.join(дом, "Документы") });
    check(наДиске === path.join(path.parse(дом).root, "FineCRMdata"), `по умолчанию — корень диска (${наДиске})`);

    // В корень не дают писать, «Документы» обычные — идём в них.
    const никуда = () => false;
    const вДокументы = location.suggestDataDir(
      { home: дом, documents: path.join(дом, "Документы") },
      никуда
    );
    check(вДокументы === path.join(дом, "Документы", "FineCRM"), `запасной — «Документы» (${вДокументы})`);

    // В корень не дают, а «Документы» перенаправлены в облако — тогда профиль.
    // Уводить человека в облако нельзя ни при каких запасных вариантах: база
    // там не создастся вовсе.
    const вОблаке = path.join(дом, "OneDrive", "Документы");
    const запасной = location.suggestDataDir({ home: дом, documents: вОблаке }, никуда);
    check(запасной === path.join(дом, "FineCRM"), `из облака уходим в профиль (${запасной})`);
    check(!location.cloudSync(запасной), "ни один запасной вариант не облачный");
  }

  // А обычная папка, в имени которой случайно встретилось слово, — принимается.
  const ok = location.checkDataDir(path.join(room, "Мои документы", "FineCRM"));
  check(ok.ok, `обычная папка проходит (${ok.reason ?? "без замечаний"})`);
}

fs.rmSync(room, { recursive: true, force: true });
console.log(fails === 0 ? "\nвсе проверки прошли" : `\nпровалов: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
