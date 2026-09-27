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
const { Backups, findBackups, tooNew, restoreDump, PLACE_DIR } = require("../src/backup");
const { adoptBackupConfig } = require("../src/bootstrap");

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

  // ---------------------------------------------------------------- места
  //
  // Несколько мест: копия идёт во все, недоступное не срывает остальные.
  cfg.backup.folder = "";
  cfg.backup.keep = 7;
  cfg.workshopName = "Сервис на Ленина";
  const flash = path.join(dataDir, "..", "флешка-" + path.basename(dataDir));
  const gone = path.join(dataDir, "..", "вынутая-" + path.basename(dataDir));
  fs.mkdirSync(flash, { recursive: true });
  fs.mkdirSync(gone, { recursive: true });

  check(!backups.addPlace(path.join(l.root, "files")).ok, "место внутри папки базы не принимается");
  check(!backups.addPlace(path.join(flash, "нет-такой")).ok, "несуществующая папка не принимается");
  const added = backups.addPlace(flash);
  check(added.ok, `флешка добавлена местом (${added.error ?? "ok"})`);
  check(!backups.addPlace(flash).ok, "одно место дважды не добавляется");
  check(backups.addPlace(gone).ok, "второе место добавлено");
  fs.rmSync(gone, { recursive: true, force: true }); // «флешку вынули»
  check(config.read(l.config).backup.places.length === 2, "места записаны в настройки");

  const multi = await backups.run("в несколько мест");
  const flashDir = path.join(flash, PLACE_DIR);
  check(multi.ok, `основная копия сделана (${multi.error ?? "ok"})`);
  check(multi.places.length === 2 && multi.placesFailed === 1, `одно место записано, одно нет (${JSON.stringify(multi.places)})`);
  check(!fs.existsSync(gone), "на месте вынутой флешки папка не создаётся заново");
  const onFlash = fs.readdirSync(path.join(flashDir, "db"));
  check(onFlash.some((f) => f.endsWith(".dump")) && onFlash.some((f) => f.endsWith(".json")), "на флешке копия базы и её описание");
  check(fs.existsSync(path.join(flashDir, "files", "t1", "o1", "снимок.png")), "на флешке фотографии");
  check(fs.existsSync(path.join(flashDir, "config.json")), "на флешке настройки");
  check(fs.existsSync(path.join(flashDir, "Как восстановить.txt")), "на флешке подсказка для человека");
  check(!onFlash.some((f) => f.endsWith(".part")), "недописанных файлов не осталось");
  const saved2 = config.read(l.config).backup.places;
  check(saved2[0].lastOk === true && saved2[1].lastOk === false && /недоступно/.test(saved2[1].lastError), "у каждого места свой отчёт");

  const st = backups.status();
  check(st.places.length === 3 && st.places[0].primary && st.places[1].copies >= 1, "состояние для интерфейса: три места и число копий");

  // Хранится по семь копий в каждом месте
  for (let i = 1; i <= 9; i++) {
    const n = `finecrm-2020-01-0${i}-010000`;
    fs.writeFileSync(path.join(flashDir, "db", `${n}.dump`), "старьё");
    fs.writeFileSync(path.join(flashDir, "db", `${n}.json`), "{}");
  }
  backups.trim(flashDir);
  const leftFlash = fs.readdirSync(path.join(flashDir, "db"));
  check(leftFlash.filter((f) => f.endsWith(".dump")).length === 7, "в месте хранится семь копий");
  check(leftFlash.filter((f) => f.endsWith(".json")).length <= 7, "описания старых копий удалены вместе с ними");

  // Описание копии
  const newest = fs.readdirSync(path.join(flashDir, "db")).filter((f) => f.endsWith(".json")).sort().pop();
  const info = JSON.parse(fs.readFileSync(path.join(flashDir, "db", newest), "utf8"));
  check(info.workshop === "Сервис на Ленина" && info.photos === 1 && info.format === 1, `в описании мастерская и снимки (${JSON.stringify(info)})`);

  // Старые настройки: 14 копий и «своя папка» переезжают сами
  const norm = config.normalizeBackup({ folder: "E:\\копии", keep: 14 });
  check(norm.keep === 7 && norm.places.length === 1 && norm.folder === "", "старые настройки: 14 → 7, папка → место");

  // -------------------------------------------------------- поиск копий
  const fromFlash = findBackups(flash);
  check(fromFlash.ok && fromFlash.root === flashDir, "копии находятся, если указать флешку, а не саму папку");
  check(fromFlash.dumps[0].info && fromFlash.dumps[0].info.workshop === "Сервис на Ленина", "у свежей копии видно описание");
  check(fromFlash.photos === 1, "видно, сколько фотографий");
  const fromData = findBackups(l.root);
  check(fromData.ok && fromData.root === path.join(l.root, "backups"), "находятся и в старой папке данных");
  check(!findBackups(os.tmpdir()).ok, "в чужой папке копий нет — так и говорится");

  // Версии: копия от новой программы не поднимается старой
  const mig = path.join(dataDir, "..", "миграции-" + path.basename(dataDir));
  fs.mkdirSync(path.join(mig, "20260101000000_a"), { recursive: true });
  fs.mkdirSync(path.join(mig, "20260201000000_b"), { recursive: true });
  check(tooNew({ lastMigration: "20260201000000_b" }, mig) === null, "копия той же версии — годится");
  check(tooNew({ lastMigration: "20260101000000_a" }, mig) === null, "копия старой версии — годится");
  check(/новой версией/.test(tooNew({ lastMigration: "20270101000000_c", appVersion: "9.9.9" }, mig) || ""), "копия от новой версии — отказ");

  // ------------------------------------------------ восстановление с нуля
  //
  // Новый «компьютер»: пустая папка, свой кластер, свои пароли. Из копии —
  // база, фотографии, имя мастерской и места копий.
  const fresh = path.join(dataDir, "..", "новый-" + path.basename(dataDir));
  const l2 = ensureLayout(fresh);
  const cfg2 = config.ensureSecrets(config.read(l2.config));
  adoptBackupConfig(cfg2, fromFlash.root);
  check(cfg2.workshopName === "Сервис на Ленина", "имя мастерской приехало из копии");
  check(cfg2.backup.places.length === 2 && cfg2.backup.places.every((p) => p.lastAt === null), "места копий приехали, отчёты чистые");
  check(cfg2.auth.accessSecret === cfg.auth.accessSecret, "ключи входа те же — сотрудникам не входить заново");
  check(cfg2.db.ownerPassword !== cfg.db.ownerPassword, "пароли базы свои, новые");

  const { mirror } = require("../src/backup");
  mirror(path.join(fromFlash.root, "files"), l2.files);
  check(fs.existsSync(path.join(l2.files, "t1", "o1", "снимок.png")), "фотографии вернулись");

  const pg2 = new LocalPostgres({ dataDir: l2.db, logDir: l2.logs });
  await pg2.initdb(cfg2.db.ownerPassword);
  cfg2.db.port = await freePort();
  await pg2.start(cfg2.db.port);
  try {
    await pg2.provision(cfg2.db, cfg2.db.ownerPassword);
    await restoreDump({
      binDir: pg2.binDir,
      port: cfg2.db.port,
      db: cfg2.db,
      superPassword: cfg2.db.ownerPassword,
      file: fromFlash.dumps[0].file,
    });
    await pg2.provision(cfg2.db, cfg2.db.ownerPassword);

    const back = (
      await pg2.psql('SELECT string_agg(number, \' \' ORDER BY number) FROM "Order"', {
        database: cfg2.db.name,
        password: cfg2.db.ownerPassword,
      })
    ).trim();
    check(back.includes("Р-2026-00042") && back.includes("Р-2026-00043"), `база восстановлена (${back})`);

    const owner2 = (
      await pg2.psql(`SELECT tableowner FROM pg_tables WHERE tablename = 'Order'`, {
        database: cfg2.db.name,
        password: cfg2.db.ownerPassword,
      })
    ).trim();
    check(owner2 === cfg2.db.ownerUser, `таблицы принадлежат владельцу схемы, как при обычной установке (${owner2})`);

    // Изоляция приехала вместе с таблицами, и программа видит свои строки.
    const asApp = (
      await pg2.psql(
        `SELECT set_config('app.tenant_id','t1',false); SELECT count(*) FROM "Order";`,
        { database: cfg2.db.name, user: cfg2.db.appUser, password: cfg2.db.appPassword }
      )
    ).trim();
    check(/\b2$/.test(asApp), `программа читает восстановленные заказы своей мастерской (${asApp.replace(/\s+/g, " ")})`);
    const blind = (
      await pg2.psql(`SELECT count(*) FROM "Order";`, {
        database: cfg2.db.name,
        user: cfg2.db.appUser,
        password: cfg2.db.appPassword,
      })
    ).trim();
    check(blind === "0", `без мастерской не видно ничего — изоляция на месте (${blind})`);

    // Восстановить поверх непустой базы нельзя — только в пустую.
    let refused = false;
    try {
      await restoreDump({
        binDir: pg2.binDir,
        port: cfg2.db.port,
        db: cfg2.db,
        superPassword: cfg2.db.ownerPassword,
        file: fromFlash.dumps[0].file,
      });
    } catch {
      refused = true;
    }
    const still = (
      await pg2.psql('SELECT count(*) FROM "Order"', { database: cfg2.db.name, password: cfg2.db.ownerPassword })
    ).trim();
    check(refused && still === "2", "повторное восстановление поверх базы отвергнуто целиком, база цела");
  } finally {
    await pg2.stop();
  }

  await pg.stop();
  if (!keep) {
    for (const d of [flash, mig, fresh]) fs.rmSync(d, { recursive: true, force: true });
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
