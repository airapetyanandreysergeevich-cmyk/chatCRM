"use strict";

const fs = require("fs");
const path = require("path");

/**
 * Указатель на папку данных.
 *
 * Возникает вопрос курицы и яйца: настройки лежат в папке данных, а где эта
 * папка — надо откуда-то узнать. Поэтому рядом с программой (в профиле
 * пользователя, куда Windows всегда даёт писать) лежит крошечный файл с одним
 * путём. Потерять его не страшно: программа спросит папку заново, и мастерская
 * укажет на ту же — данные в ней целы.
 */

function pointerFile(userDataDir) {
  return path.join(userDataDir, "location.json");
}

function readLocation(userDataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(pointerFile(userDataDir), "utf8"));
    if (typeof raw.dataDir === "string" && raw.dataDir) return raw;
    // У клиента своей базы нет — только адрес Основы или облака. Раньше такой
    // указатель считался пустым, и программа сотрудника при каждом запуске
    // заново спрашивала, как ей работать.
    if (raw.mode === "client" && typeof raw.connectTo === "string" && raw.connectTo) return raw;
    if (raw.mode === "online") return raw;
    return null;
  } catch {
    return null;
  }
}

/**
 * Тот же путь, но отдельной строкой и без JSON.
 *
 * Читать его будет деинсталлятор, чтобы спросить, удалять ли данные
 * мастерской. Разбирать JSON в NSIS нечем, а спрашивать «где ваша база?» у
 * человека, который уже нажал «Удалить», — значит не спросить вовсе.
 */
function plainFile(userDataDir) {
  return path.join(userDataDir, "datadir.txt");
}

function writeLocation(userDataDir, location) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const file = pointerFile(userDataDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(location, null, 2), "utf8");
  fs.renameSync(tmp, file);

  // Без перевода строки в конце: деинсталлятор читает файл целиком, и лишний
  // символ превратил бы путь в несуществующий.
  if (location.dataDir) fs.writeFileSync(plainFile(userDataDir), location.dataDir, "utf8");
  else fs.rmSync(plainFile(userDataDir), { force: true });

  return location;
}

function forgetLocation(userDataDir) {
  fs.rmSync(pointerFile(userDataDir), { force: true });
  fs.rmSync(plainFile(userDataDir), { force: true });
}

/**
 * Синхронизируется ли папка с облаком, и с каким.
 *
 * Кластер PostgreSQL — это тысячи мелких файлов, которые переписываются
 * постоянно. Облачный клиент честно вмешивается в каждый: создание базы
 * растягивается с полуминуты до бесконечности, а живая база рискует быть
 * испорченной — облако не знает, что файлы базы нельзя трогать по одному.
 *
 * Самое подлое здесь в том, что человек об этом не догадывается: Windows
 * перенаправляет «Документы» в OneDrive сама, и путь выглядит обычным. На
 * такой папке initdb завис молча — ни одного файла, ни одной строки в
 * журнале, потому что застрял он в самой файловой системе.
 *
 * Отдельной функцией, а не внутри проверки: тот же ответ нужен до создания
 * чего бы то ни было — чтобы не предлагать человеку негодную папку.
 */
function cloudSync(dir) {
  const full = path.resolve(dir);
  const known = [
    [/[\\/]OneDrive/i, "OneDrive"],
    [/[\\/]Dropbox/i, "Dropbox"],
    [/[\\/]Google ?Drive/i, "Google Drive"],
    [/[\\/](\u042f\u043d\u0434\u0435\u043a\u0441\.?\u0414\u0438\u0441\u043a|YandexDisk)/i, "\u042f\u043d\u0434\u0435\u043a\u0441.\u0414\u0438\u0441\u043a"],
    [/[\\/]iCloudDrive/i, "iCloud"],
  ];
  for (const [rule, name] of known) if (rule.test(full)) return name;
  return null;
}

/**
 * Годится ли папка под данные.
 *
 * Отдельная проверка, а не «попробуем и посмотрим»: человек выбирает папку
 * один раз, и узнать о том, что туда нельзя писать, он должен сразу, а не
 * через минуту создания базы.
 */
function checkDataDir(dir) {
  if (!dir) return { ok: false, reason: "Папка не выбрана" };

  const full = path.resolve(dir);

  // Program Files: Windows молча подменит запись на скрытую копию в профиле,
  // и мастерская будет думать, что база лежит там, где её нет.
  if (/[\\/]Program Files( \(x86\))?[\\/]/i.test(full + path.sep)) {
    return { ok: false, reason: "В Program Files Windows не даёт писать — выберите другую папку" };
  }

  const cloud = cloudSync(full);
  if (cloud) {
    return {
      ok: false,
      reason:
        `Эта папка синхронизируется с ${cloud}. База данных из тысяч файлов там не заработает: ` +
        "выберите папку вне облачной синхронизации, а резервные копии настройте отдельно.",
    };
  }

  try {
    fs.mkdirSync(full, { recursive: true });
    const probe = path.join(full, ".finecrm-probe");
    fs.writeFileSync(probe, "проба");
    fs.rmSync(probe, { force: true });
  } catch (err) {
    return { ok: false, reason: `В эту папку не получается писать: ${err.message}` };
  }

  // Уже занятая папка — не ошибка: значит, программу переустановили и
  // указывают на прежние данные. Но сказать об этом надо.
  const used = fs.existsSync(path.join(full, "config.json"));
  return { ok: true, existing: used, path: full };
}


/** Можно ли что-нибудь создать в этой папке. Без следов: пробу сразу убираем. */
function canCreate(dir) {
  const probe = path.join(dir, `.finecrm-проба-${process.pid}`);
  try {
    fs.mkdirSync(probe);
    fs.rmdirSync(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Что предложить в качестве папки данных.
 *
 * Корень системного диска, а не «Документы». Так короче путь, который
 * мастерская однажды будет диктовать по телефону, и — главное — туда не
 * дотягивается облачная синхронизация. Windows нередко перенаправляет
 * «Документы» в OneDrive, ничего об этом не сказав, а в облачной папке база
 * не создаётся вовсе: initdb молча виснет на первом же файле. Предлагать
 * папку, в которой программа откажется работать, нельзя — человек выбирает её
 * один раз и обычно не глядя.
 *
 * Запасные варианты на случай, если в корень писать не дают: «Документы»,
 * если они не в облаке, и затем профиль пользователя — туда пускают всегда.
 *
 * Пути передаются снаружи, а не берутся из Electron, а проверка на запись —
 * отдельным доводом: иначе запасные варианты нельзя было бы проверить вовсе,
 * а именно они и понадобятся на чужой машине.
 */
function suggestDataDir({ home, documents }, mayCreate = canCreate) {
  const root = path.parse(path.resolve(home)).root;
  if (root && mayCreate(root)) return path.join(root, "FineCRMdata");

  const inDocuments = path.join(documents, "FineCRM");
  if (!cloudSync(inDocuments)) return inDocuments;

  return path.join(home, "FineCRM");
}

module.exports = { readLocation, writeLocation, forgetLocation, checkDataDir, cloudSync, suggestDataDir };
