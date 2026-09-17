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
    return null;
  } catch {
    return null;
  }
}

function writeLocation(userDataDir, location) {
  fs.mkdirSync(userDataDir, { recursive: true });
  const file = pointerFile(userDataDir);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(location, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return location;
}

function forgetLocation(userDataDir) {
  fs.rmSync(pointerFile(userDataDir), { force: true });
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

module.exports = { readLocation, writeLocation, forgetLocation, checkDataDir };
