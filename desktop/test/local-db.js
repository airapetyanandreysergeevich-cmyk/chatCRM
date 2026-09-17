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
const { execFile } = require("child_process");
const { promisify } = require("util");

const run = promisify(execFile);
const { ensureLayout } = require("../src/paths");
const config = require("../src/config");
const { LocalPostgres, freePort, HOST } = require("../src/postgres");

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

  const appEnv = { ...process.env, PGPASSWORD: cfg.db.appPassword };
  const asApp = async (sql) => {
    const { stdout } = await run(
      path.join(pg.binDir, process.platform === "win32" ? "psql.exe" : "psql"),
      ["-h", HOST, "-p", String(cfg.db.port), "-U", cfg.db.appUser, "-d", cfg.db.name, "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", "-c", sql],
      { env: appEnv }
    );
    return stdout.trim();
  };

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
