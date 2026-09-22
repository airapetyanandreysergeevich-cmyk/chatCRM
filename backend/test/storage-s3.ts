/**
 * Облачное хранилище: снимок отдаёт наш сервер, а не MinIO.
 *
 * Раньше ссылка на фотографию вела прямо в MinIO по внутреннему адресу
 * http://minio:9000 — браузер его не знает, и в облаке вместо снимков были
 * пустые квадраты. Проверяем, что ссылка теперь наша, относительная и
 * подписанная, а файл по ней достаётся из бакета.
 *
 *   npx tsx test/storage-s3.ts
 */

import express from "express";
import { Readable } from "node:stream";

process.env.STORAGE_DRIVER = "s3";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
process.env.JWT_ACCESS_SECRET = "проверочный-секрет-доступа";
process.env.JWT_REFRESH_SECRET = "проверочный-секрет-обновления";

async function main() {
  const { s3 } = await import("../src/lib/storage.s3");
  const { putOrderFile, signedUrl, isLocalStorage } = await import("../src/lib/storage");
  const { filesRouter } = await import("../src/modules/files/files.routes");
  const { errorHandler } = await import("../src/lib/errors");

  let fails = 0;
  const check = (ok: boolean, msg: string) => {
    console.log((ok ? "ok    " : "БЕДА  ") + msg);
    if (!ok) fails++;
  };
  check(!isLocalStorage, "выбрано облачное хранилище");

  // Бакет в памяти вместо MinIO.
  const bucket = new Map<string, Buffer>();
  (s3 as unknown as { send: (cmd: { constructor: { name: string }; input: Record<string, unknown> }) => Promise<unknown> }).send =
    async (cmd) => {
      const name = cmd.constructor.name;
      const key = String(cmd.input.Key);
      if (name === "PutObjectCommand") {
        bucket.set(key, Buffer.from(cmd.input.Body as Buffer));
        return {};
      }
      if (name === "GetObjectCommand") {
        const b = bucket.get(key);
        if (!b) throw Object.assign(new Error("NoSuchKey"), { name: "NoSuchKey" });
        return { Body: Readable.from([b]), ContentLength: b.length };
      }
      return {};
    };

  const app = express();
  app.use("/api/files", filesRouter);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const body = Buffer.from("снимок ноутбука");
  const key = await putOrderFile({ tenantId: "t1", orderId: "o1", buffer: body, mimeType: "image/jpeg" });
  const link = await signedUrl(key);
  check(link.startsWith("/api/files/t1/o1/") && !link.includes("minio"), `ссылка наша и относительная (${link.slice(0, 40)}…)`);

  const r = await fetch(base + link);
  check(r.status === 200 && (await r.text()) === body.toString(), `по ссылке отдаётся файл из бакета (${r.status})`);
  check(r.headers.get("content-type") === "image/jpeg", "тип файла проставлен");

  check((await fetch(`${base}/api/files/${key}`)).status === 404, "без подписи не отдаётся");
  check((await fetch(base + (await signedUrl("t1/o1/nope.jpg")))).status === 404, "нет в бакете — 404, а не падение");

  server.close();
  console.log(fails === 0 ? "\nвсе проверки прошли" : `\nпровалов: ${fails}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("сорвалось:", err);
  process.exit(1);
});
