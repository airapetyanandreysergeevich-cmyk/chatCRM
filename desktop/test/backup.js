"use strict";

/**
 * Проверка резервных копий.
 *
 * Главный вопрос здесь один: восстанавливается ли копия. Поэтому проверка не
 * ограничивается тем, что файл создался, — она поднимает из копии отдельную
 * базу и сверяет строки. Всё остальное («копия сделана», «файл на месте») без
 * этого ничего не значит.
 *
 *   node test/backup.js <папка> [--keep]
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
const { Backups } = require("../src/backup");

let fails = 0;
const check = (ok, msg) => {
  console.log((ok ? "ok    " : "БЕДА  ") + msg);
  if (!ok) fails++;
};

const dataDir = process.argv[2] || path.join(os.tmpdir(), "finecrm-backup-test");
const keep = process.argv.includes("--keep");

async function main() {
  const l = ensureLayout(dataDir);
  const cfg = config.ensureSecrets(config.read(l.config));
  const pg = new LocalPostgres({ dataDir: l.db, logDir: l.logs });

  await pg.initdb(cfg.db.ownerPassword);
  cfg.db.port = await freePort();
  cfg.backup.folder = path.join(dataDir, "..", "копии-" + path.basename(dataDir));
  config.write(l.config, cfg);
  await pg.start(cfg.db.port);
  await pg.provision(cfg.db, cfg.db.ownerPassword);

  const owner = { database: cfg.db.name, user: cfg.db.ownerUser, password: cfg.db.ownerPassword };

  // Данные, которые должны пережить восстановление.
  //
  // Таблицу закрываем той же построчной изоляцией, что стоит на боевых: без
  // этого проверка была слепа к главной беде копий — pg_dump под владельцем
  // схемы получает пустую копию и не жалуется достаточно громко.
  await pg.psql(
    `CREATE TABLE "Order" (id text PRIMARY KEY, number text NOT NULL, "tenantId" text NOT NULL);
     INSERT INTO "Order" VALUES ('o1','Р-2026-00042','t1'), ('o2','Р-2026-00043','t1');
     CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS text AS $$
       SELECT NULLIF(current_setting('app.tenant_id', true), '');
     $$ LANGUAGE sql STABLE;
     ALTER TABLE "Order" ENABLE ROW LEVEL SECURITY;
     ALTER TABLE "Order" FORCE ROW LEVEL SECURITY;
     CREATE POLICY tenant_isolation ON "Order"
       USING ("tenantId" = current_tenant_id())
       WITH CHECK ("tenantId" = current_tenant_id());`,
    owner
  );

  // И фотография заказа
  fs.mkdirSync(path.join(l.files, "t1", "o1"), { recursive: true });
  fs.writeFileSync(path.join(l.files, "t1", "o1", "снимок.png"), Buffer.alloc(2048, 7));

  const backups = new Backups({ layout: l, config: cfg, binDir: pg.binDir });

  // 1. Копия делается и проверяется
  const first = await backups.run("проверка");
  check(first.ok, `копия сделана (${first.ok ? `${first.bytes} байт, таблиц с данными: ${first.tables}` : first.error})`);
  check(fs.existsSync(first.file), "файл копии на месте");
  check(first.photos === 1, `фотографии скопированы (${first.photos})`);
  check(
    fs.existsSync(path.join(backups.folder, "config.json")),
    "настройки с паролями базы лежат рядом с копией"
  );

  // 2. Отчёт виден в настройках — интерфейсу есть что показать
  const saved = config.read(l.config);
  check(saved.backup.lastOk === true && !!saved.backup.lastAt, "отчёт о копии записан в настройки");

  // 3. Самое главное: копия восстанавливается, и данные те же
  const restoredDb = "finecrm_restore";
  await pg.psql(`CREATE DATABASE ${restoredDb} OWNER ${cfg.db.ownerUser}`, { password: cfg.db.ownerPassword });
  await run(
    path.join(pg.binDir, process.platform === "win32" ? "pg_restore.exe" : "pg_restore"),
    ["-h", HOST, "-p", String(cfg.db.port), "-U", cfg.db.ownerUser, "-d", restoredDb, first.file],
    { env: { ...process.env, PGPASSWORD: cfg.db.ownerPassword }, maxBuffer: 64 * 1024 * 1024 }
  );
  // Читаем под суперпользователем: на восстановленной таблице та же изоляция,
  // и владелец схемы увидел бы ноль строк — как и при снятии копии.
  const rows = (
    await pg.psql('SELECT string_agg(number, \' \' ORDER BY number) FROM "Order"', {
      database: restoredDb,
      password: cfg.db.ownerPassword,
    })
  ).trim();
  check(
    rows.includes("Р-2026-00042") && rows.includes("Р-2026-00043"),
    `из копии поднимается рабочая база (${rows})`
  );

  // 4. Повторная копия не копирует те же фотографии заново
  cfg.backup.lastAt = null;
  const second = await backups.run("повтор");
  check(second.ok && second.photos === 0, `второй раз снимки не переписываются (${second.photos})`);

  // 5. Старые копии удаляются, свежие остаются
  cfg.backup.keep = 2;
  const dbDir = path.join(backups.folder, "db");
  for (const name of ["finecrm-2020-01-01-0100.dump", "finecrm-2020-01-02-0100.dump"]) {
    fs.writeFileSync(path.join(dbDir, name), "старьё");
  }
  backups.trim();
  const left = fs.readdirSync(dbDir).filter((f) => f.endsWith(".dump")).sort();
  check(
    left.length === 2 && left.every((f) => !f.includes("2020")),
    `хранятся две свежие копии, старьё удалено (${left.join(", ")})`
  );

  // 6. Копия рядом с данными честно называется недостаточной
  cfg.backup.folder = "";
  check(backups.sameDisk, "копия на том же диске распознаётся как ненадёжная");

  // 7. Расписание: раз в сутки, и не чаще
  cfg.backup.folder = path.join(dataDir, "..", "копии-" + path.basename(dataDir));
  cfg.backup.lastAt = new Date().toISOString();
  check(!backups.due(), "сразу после копии новая не начинается");
  cfg.backup.lastAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
  check(backups.due(), "через сутки копия становится нужна");
  cfg.backup.enabled = false;
  check(!backups.due(), "выключенные копии не делаются");

  // 8. Испорченная копия не считается копией
  cfg.backup.enabled = true;
  const broken = path.join(dbDir, "битая.dump");
  fs.writeFileSync(broken, "это не дамп");
  let caught = false;
  try {
    await backups.verifyDump(broken);
  } catch {
    caught = true;
  }
  check(caught, "нечитаемая копия распознаётся, а не принимается на веру");

  await pg.stop();
  if (!keep) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(path.join(dataDir, "..", "копии-" + path.basename(dataDir)), { recursive: true, force: true });
  }
  console.log(fails === 0 ? "\nвсе проверки прошли" : `\nпровалов: ${fails}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\nсорвалось:", err.message);
  if (err.stderr) console.error(err.stderr);
  process.exit(1);
});
