/**
 * Проверка локального хранилища файлов.
 *
 * Доказывает то, ради чего в облаке стоит приватный бакет: по угаданному
 * адресу чужой снимок не достаётся. Поднимает маршрут раздачи на живом
 * сервере и стучится в него так, как стучался бы любопытный.
 *
 *   npx tsx test/storage-local.ts
 */

import express from "express";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "finecrm-files-"));

// Настройки читаются при первом импорте, поэтому задаём их до него.
process.env.STORAGE_DRIVER = "local";
process.env.STORAGE_DIR = dir;
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
process.env.JWT_ACCESS_SECRET = "проверочный-секрет-доступа";
process.env.JWT_REFRESH_SECRET = "проверочный-секрет-обновления";

async function main() {
  const { putOrderFile, signedUrl, removeFile, isLocalStorage } = await import("../src/lib/storage");
  const { filesRouter } = await import("../src/modules/files/files.routes");
  const { errorHandler } = await import("../src/lib/errors");

  let fails = 0;
  const check = (ok: boolean, msg: string) => {
    console.log((ok ? "ok    " : "БЕДА  ") + msg);
    if (!ok) fails++;
  };

  check(isLocalStorage, "выбран локальный вариант хранилища");

  const app = express();
  app.use("/api/files", filesRouter);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // 1. Кладём файл
  const body = Buffer.from("фотография ноутбука");
  const key = await putOrderFile({
    tenantId: "t1",
    orderId: "o1",
    buffer: body,
    mimeType: "image/png",
  });
  check(key.startsWith("t1/o1/") && key.endsWith(".png"), `ключ начинается с мастерской (${key})`);

  // 2. По подписанной ссылке файл отдаётся
  const link = await signedUrl(key);
  const ok = await fetch(base + link);
  check(ok.status === 200, `подписанная ссылка отдаёт файл (${ok.status})`);
  check(ok.headers.get("content-type") === "image/png", "тип файла проставлен");
  check((await ok.text()) === body.toString(), "содержимое то же");

  // 3. Без подписи и с чужой подписью — мимо
  const bare = await fetch(`${base}/api/files/${key}`);
  check(bare.status === 404, `без подписи не отдаётся (${bare.status})`);

  const tampered = link.replace(/s=([0-9a-f])/, (_m, c) => `s=${c === "0" ? "1" : "0"}`);
  check((await fetch(base + tampered)).status === 404, "испорченная подпись не проходит");

  // 4. Просроченная ссылка
  const old = await signedUrl(key, -60);
  check((await fetch(base + old)).status === 404, "просроченная ссылка не проходит");

  // 5. Выход из папки
  writeFileSync(path.join(dir, "..", "секрет.txt"), "пароли");
  const escapes = [
    "../%D1%81%D0%B5%D0%BA%D1%80%D0%B5%D1%82.txt",
    "..%2f..%2fetc%2fpasswd",
    "%2e%2e/%2e%2e/etc/passwd",
  ];
  let allBlocked = true;
  for (const attempt of escapes) {
    const r = await fetch(`${base}/api/files/${attempt}?e=9999999999&s=deadbeef`);
    if (r.status === 200) allBlocked = false;
  }
  check(allBlocked, "из папки хранилища не выбраться");

  // 6. Удаление
  await removeFile(key);
  const gone = await fetch(base + (await signedUrl(key)));
  check(gone.status === 404, "удалённый файл больше не отдаётся");

  server.close();
  console.log(fails === 0 ? "\nвсе проверки прошли" : `\nпровалов: ${fails}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("сорвалось:", err);
  process.exit(1);
});
