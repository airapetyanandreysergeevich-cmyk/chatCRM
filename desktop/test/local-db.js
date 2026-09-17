"use strict";

/**
 * Проверка встроенной базы.
 *
 * Запускается на пустой папке и доказывает главное: локальный кластер
 * настроен ровно так же, как облачный. Если эта проверка проходит, значит
 * миграции и построчная изоляция из облака встают на коробку без правок.
 *
 *   node test/local-db.js <папка> [--keep]
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { ensureLayout } = require("../src/paths");
const config = require("../src/config");
const { LocalPostgres, freePort, HOST, WINDOWS_CODES } = require("../src/postgres");

let fails = 0;
const check = (ok, msg) => {
  console.log((ok ? "ok    " : "БЕДА  ") + msg);
  if (!ok) fails++;
};

const dataDir = process.argv[2] || path.join(os.tmpdir(), "finecrm-test");
const keep = process.argv.includes("--keep");

async function main() {
  const l = ensureLayout(dataDir);
  const cfg = config.ensureSecrets(config.read(l.config));
  const pg = new LocalPostgres({ dataDir: l.db, logDir: l.logs });

  // 0. Отказ создания кластера объясняется причиной, а не командой.
  //
  // На чужом компьютере мы уже получили «Command failed: initdb.exe --pgdata …»
  // с длинной командой и без единого слова о том, что не так. Причину initdb
  // печатает всегда — её просто выбрасывали. Берём заведомо занятую папку:
  // это самый частый отказ при повторной установке.
  {
    const other = new LocalPostgres({ dataDir: path.join(dataDir, "проба-отказа", "db"), logDir: l.logs });
    let said = "";
    try {
      await other.runTold("initdb", "Создание кластера", [
        "--pgdata", other.dataDir,
        "--username", "postgres",
        "--encoding=UTF8",
        "--locale-provider=icu",
        "--icu-locale=такой-локали-нет",
        "--locale=C",
      ]);
    } catch (err) {
      said = err.message;
    }
    check(/не удалось/.test(said) && !/Command failed/.test(said), `отказ назван по-русски (${said.slice(0, 140)})`);
    check(/U_ILLEGAL_ARGUMENT_ERROR/.test(said), "в сообщении видно, на чём именно споткнулись");
    // Русская Windows пишет сообщения программ в кодировке консоли. Прочитанные
    // как UTF-8, они превращаются в «??????» — и объяснение отказа становится
    // нечитаемым ровно там, где оно нужнее всего.
    check(!said.includes("�"), "сообщение читается, а не набор вопросительных знаков");
    check(fs.existsSync(path.join(l.logs, "initdb.log")), "вывод initdb сохранён в журнале");
  }

  // 0а. Зависшая программа прерывается по сроку и объясняется.
  //
  // «Вечное создание базы» — всё, что человек когда-либо узнавал о такой
  // поломке: окно с бегущей полоской, за которым может стоять что угодно.
  // Ожидание без срока — это не терпение, а отказ сообщать.
  {
    const binDir = path.join(dataDir, "самодельные");
    fs.mkdirSync(binDir, { recursive: true });
    const sleeper = path.join(binDir, process.platform === "win32" ? "соня.cmd" : "соня");
    fs.writeFileSync(
      sleeper,
      process.platform === "win32"
        ? "@echo off\r\necho начал и задумался\r\nping -n 60 127.0.0.1 > nul\r\n"
        : '#!/bin/sh\necho "начал и задумался"\nsleep 60\n',
      { mode: 0o755 }
    );

    const slow = new LocalPostgres({ dataDir: path.join(dataDir, "неважно"), logDir: l.logs, binDir });
    const began = Date.now();
    let said = "";
    try {
      await slow.runTold("соня", "Создание кластера", [], { timeoutMs: 1500 });
    } catch (err) {
      said = err.message;
    }
    const waited = Date.now() - began;
    check(/не уложилось/.test(said), `зависшая программа прервана и названа (${said.slice(0, 110)})`);
    check(waited < 5000, `прервана вовремя, за ${waited} мс`);
    check(/задумался/.test(said), "в сообщении — последнее, что она успела сказать");
  }

  // 0в. Код Windows вместо объяснения переводится на человеческий.
  //
  // Когда программа не смогла даже начаться, она не пишет ничего — наружу
  // выходит только число. 3221225781 выглядит как мусор, а означает, что на
  // компьютере нет библиотек Visual C++. На машине разработчика они есть
  // всегда, на чистой — почти никогда; отсюда и «у тебя работает, у меня нет».
  check(
    /Visual C\+\+/.test(WINDOWS_CODES[3221225781] ?? ""),
    "код «нет библиотеки» назван словами, а не числом"
  );

  // 0б. Недоделанный кластер от сорвавшейся установки не блокирует повтор.
  //
  // Именно на это упёрлась установка на чужом компьютере: папка `db` не пуста,
  // PG_VERSION в ней нет, initdb отказывается, и дальше программа не идёт.
  {
    const again = path.join(dataDir, "повтор");
    const brokenDb = path.join(again, "db");
    fs.mkdirSync(brokenDb, { recursive: true });
    fs.writeFileSync(path.join(brokenDb, "postgresql.conf"), "# обрывок прошлой попытки");
    const retry = new LocalPostgres({ dataDir: brokenDb, logDir: path.join(again, "logs") });
    await retry.initdb("проба");
    check(retry.initialized, "после сорвавшейся установки кластер создаётся заново");
    const aside = fs.readdirSync(again).filter((n) => n.startsWith("db-неудачный-"));
    check(aside.length === 1, "обрывок прошлой попытки отложен в сторону, а не стёрт");
    fs.rmSync(again, { recursive: true, force: true });
  }

  // 1. Кластер создаётся
  const created = await pg.initdb(cfg.db.ownerPassword);
  check(created && pg.initialized, "кластер создан в папке данных");
  check(fs.existsSync(path.join(l.db, "PG_VERSION")), "PG_VERSION на месте");

  // 2. Порт свободный, запуск
  cfg.db.port = await freePort();
  config.write(l.config, cfg);
  await pg.start(cfg.db.port);
  check(await pg.isRunning(), `база отвечает на порту ${cfg.db.port}`);

  const sup = { password: cfg.db.ownerPassword };

  // 3. Слушает только себя
  const listen = (await pg.psql("SHOW listen_addresses", sup)).trim();
  check(listen.includes(HOST) && !listen.includes("*"), `наружу не выставлена (listen_addresses = ${listen})`);

  // 4. Русская сортировка
  const coll = (await pg.psql("SELECT datcollate, datlocprovider FROM pg_database WHERE datname = 'postgres'", sup)).trim();
  const order = (await pg.psql(
    "SELECT string_agg(x, ' ' ORDER BY x) FROM (VALUES ('Яшин'),('Ёлкин'),('Абрамов'),('Ежов')) v(x)",
    sup
  )).trim();
  check(order.includes("Абрамов Ежов Ёлкин Яшин"), `фамилии сортируются по-русски (${order})`);
  check(coll.endsWith("|i"), `сортировка через ICU (${coll})`);

  // 5. Роли и база
  await pg.provision(cfg.db, cfg.db.ownerPassword);
  const roles = await pg.psql(
    `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname IN ('${cfg.db.ownerUser}','${cfg.db.appUser}') ORDER BY 1`,
    sup
  );
  check(roles.includes(`${cfg.db.appUser}|f|f`), `роль приложения не суперпользователь и не обходит изоляцию (${roles.trim().replace(/\n/g, "; ")})`);
  check(roles.includes(`${cfg.db.ownerUser}|f|f`), "владелец схемы тоже без обхода изоляции");

  // 6. Изоляция мастерских — тот же приём, что в prisma/rls.sql
  // Таблицу создаёт владелец схемы — так же, как её создаст миграция. Права
  // приложению должны достаться сами, через ALTER DEFAULT PRIVILEGES.
  await pg.psqlFile(path.join(__dirname, "rls-sample.sql"), {
    database: cfg.db.name,
    user: cfg.db.ownerUser,
    password: cfg.db.ownerPassword,
  });

  const asApp = async (sql) =>
    (await pg.psql(sql, { database: cfg.db.name, user: cfg.db.appUser, password: cfg.db.appPassword })).trim();

  const seenByOne = await asApp(
    "BEGIN; SELECT set_config('app.tenant_id','t1',true); SELECT string_agg(name,',' ORDER BY name) FROM probe; COMMIT;"
  );
  check(/Первый/.test(seenByOne) && !/Второй/.test(seenByOne), `мастерская видит только свои строки (${seenByOne.replace(/\n/g, " ")})`);

  const seenByNobody = await asApp("SELECT count(*) FROM probe");
  check(seenByNobody.trim() === "0", "без указания мастерской не видно ничего — отказ в закрытую");

  let blocked = false;
  try {
    await asApp("BEGIN; SELECT set_config('app.tenant_id','t1',true); INSERT INTO probe VALUES ('x','t2','Чужая'); COMMIT;");
  } catch {
    blocked = true;
  }
  check(blocked, "записать строку чужой мастерской нельзя");

  // 7. Права достались приложению сами, без ручной раздачи на каждую таблицу
  const canWrite = await asApp(
    "BEGIN; SELECT set_config('app.tenant_id','t1',true); INSERT INTO probe VALUES ('n1','t1','Новая'); SELECT count(*) FROM probe; COMMIT;"
  );
  check(/2/.test(canWrite), "в свою мастерскую пишется без отдельной выдачи прав");

  // 8. Перезапуск — данные на месте
  await pg.stop();
  check(!(await pg.isRunning()), "база останавливается");
  await pg.start(cfg.db.port);
  const survived = await asApp(
    "BEGIN; SELECT set_config('app.tenant_id','t1',true); SELECT count(*) FROM probe; COMMIT;"
  );
  check(/2/.test(survived), "после перезапуска данные на месте");

  await pg.stop();

  if (!keep) fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(fails === 0 ? "\nвсе проверки прошли" : `\nпровалов: ${fails}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nсорвалось:", err.message);
  if (err.stderr) console.error(err.stderr);
  process.exit(1);
});
