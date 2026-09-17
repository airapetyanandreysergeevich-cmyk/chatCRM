"use strict";

/**
 * Проверка запуска вспомогательных инструментов.
 *
 * Здесь дважды подряд всплывала одна и та же ловушка Windows: ожидание
 * процесса не заканчивается, потому что кто-то держит открытыми потоки
 * вывода. Проверяем то, что от этого защищает: вывод уходит в файл, а не в
 * трубу, у ожидания есть срок, и отказ объясняется строкой из журнала.
 *
 *   node test/run-tool.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const { runTool } = require("../src/bootstrap");
const { readText } = require("../src/postgres");

let fails = 0;
const check = (ok, msg) => {
  console.log((ok ? "ok    " : "БЕДА  ") + msg);
  if (!ok) fails++;
};

const room = fs.mkdtempSync(path.join(os.tmpdir(), "finecrm-tool-"));
const logFile = path.join(room, "logs", "tool.log");

const script = (body) => {
  const file = path.join(room, `s${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(file, body);
  return file;
};

async function main() {
  // 1. Обычная работа: вывод попадает в журнал
  await runTool(script('console.log("миграция применена");'), [], {
    cwd: room,
    logFile,
    what: "Проба",
  });
  const log = fs.readFileSync(logFile, "utf8");
  check(log.includes("миграция применена"), "вывод инструмента записан в журнал");
  check(log.includes("Проба"), "в журнале видно, что именно запускалось");

  // 2. Отказ объясняется строкой из журнала, а не голым кодом возврата
  let failed = "";
  try {
    await runTool(script('console.error("нет подключения к базе"); process.exit(4);'), [], {
      cwd: room,
      logFile,
      what: "Проба с отказом",
    });
  } catch (err) {
    failed = err.message;
  }
  check(
    /код 4/.test(failed) && /нет подключения к базе/.test(failed),
    `отказ объяснён причиной (${failed})`
  );

  // 3. Зависший инструмент прерывается по сроку, а не ждёт вечно
  const started = Date.now();
  let stuck = "";
  try {
    await runTool(script("setInterval(() => {}, 1000);"), [], {
      cwd: room,
      logFile,
      what: "Проба с зависанием",
      timeoutMs: 1500,
    });
  } catch (err) {
    stuck = err.message;
  }
  const waited = Date.now() - started;
  check(/не уложилось/.test(stuck), `зависший инструмент прерван (${stuck.split(".")[0]})`);
  check(waited < 5000, `и прерван вовремя, за ${waited} мс`);

  // 4. Потомок, который держит вывод открытым, не удерживает ожидание.
  //    Ровно та ловушка, из-за которой программа виснула на запуске базы:
  //    сам процесс завершился, а «внук» унаследовал потоки и живёт дальше.
  const pidFile = path.join(room, "внук.pid");
  const child = script(`
    const { spawn } = require("child_process");
    // detached + unref: иначе родитель сам ждёт потомка, и проверялось бы
    // совсем не то. Нам нужен именно случай pg_ctl — родитель ушёл, а
    // «внук» живёт дальше и держит унаследованные потоки.
    const grandchild = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "inherit",
      detached: true,
    });
    grandchild.unref();
    // Оставляем след, чтобы проверка могла его потом прибить: на Windows
    // живой процесс держит папку, и уборка за собой падает с EPERM.
    require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
    console.log("родитель отработал и уходит");
  `);
  const t0 = Date.now();
  let grandchildError = "";
  try {
    await runTool(child, [], { cwd: room, logFile, what: "Проба с внуком", timeoutMs: 8000 });
  } catch (err) {
    grandchildError = err.message;
  }
  const spent = Date.now() - t0;
  check(!grandchildError && spent < 5000, `ожидание не зависло из-за живого потомка (${spent} мс${grandchildError ? ", " + grandchildError : ""})`);

  // 5. Русское сообщение из журнала читается, а не превращается в кашу.
  //
  // Windows переводит сообщения программ на русский и пишет их в своей
  // однобайтовой кодировке — какой именно, зависит от того, ушёл вывод в
  // консоль или в файл. Прочитанное как UTF-8, это «??????»; прочитанное не в
  // той однобайтовой — бодрое «ю°шсър» без единого знака вопроса. Поэтому
  // проверяем обе, байтами, а не полагаясь на то, какая придёт.
  const слово = {
    "windows-1251": [0xee, 0xf8, 0xe8, 0xe1, 0xea, 0xe0], // «ошибка»
    ibm866: [0xae, 0xe8, 0xa8, 0xa1, 0xaa, 0xa0], // она же
  };
  for (const [имя, байты] of Object.entries(слово)) {
    const file = path.join(room, `журнал-${имя}.log`);
    fs.writeFileSync(
      file,
      Buffer.concat([
        Buffer.from("initdb: ", "latin1"),
        Buffer.from(байты),
        Buffer.from(": directory exists but is not empty", "latin1"),
      ])
    );
    const прочли = readText(file);
    check(прочли.includes("ошибка"), `журнал в ${имя} читается по-русски (${прочли.trim()})`);
  }

  const родной = path.join(room, "журнал-utf8.log");
  fs.writeFileSync(родной, "initdb: ошибка: каталог не пуст", "utf8");
  check(readText(родной).includes("ошибка: каталог не пуст"), "обычный UTF-8 не портится попытками угадать");

  // Прибираем за собой. «Внук» из четвёртой проверки живёт до сих пор — на то
  // она и была; но пока он жив, Windows не отдаёт папку, и уборка падает с
  // EPERM. Поэтому сперва гасим его, а саму уборку не даём испортить итог
  // проверок: не убранная папка во временных файлах — не повод считать, что
  // программа сломана.
  try {
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    if (pid) process.kill(pid);
  } catch {
    /* уже сам ушёл */
  }
  try {
    fs.rmSync(room, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    console.log(`(не убралось: ${err.code || err.message} — ${room})`);
  }
  console.log(fails === 0 ? "\nвсе проверки прошли" : `\nпровалов: ${fails}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("сорвалось:", err);
  process.exit(1);
});
