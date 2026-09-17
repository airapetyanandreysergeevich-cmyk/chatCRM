import { createReadStream, statSync } from "node:fs";
import { Router } from "express";
import { ah, notFound } from "../../lib/errors";
import { isLocalStorage, localFile, mimeOfKey } from "../../lib/storage";

/**
 * Раздача файлов в локальной версии.
 *
 * Единственный маршрут во всём приложении без проверки входа — и так и
 * задумано: ссылка на снимок попадает в тег <img> и в окно печати, куда
 * заголовок с токеном не подставить. Роль пропуска играет подпись в самой
 * ссылке: она выдана тому, кто уже имел доступ к заказу, и действует
 * пятнадцать минут.
 *
 * В облачной сборке маршрут не подключается вовсе — там файлы отдаёт S3.
 */

export const filesRouter = Router();

filesRouter.get(
  /^\/(.+)$/,
  ah(async (req, res) => {
    if (!isLocalStorage) throw notFound();

    const key = (req.params as unknown as string[])[0];
    const expires = Number(req.query.e);
    const sig = String(req.query.s ?? "");

    // Один и тот же ответ на просроченную ссылку, кривую подпись и чужой
    // путь: подсказывать, что именно не так, значит помогать подбирать.
    if (!localFile.verify(key, expires, sig)) throw notFound("Ссылка недействительна");

    const full = localFile.resolveKey(key);
    if (!full) throw notFound("Ссылка недействительна");

    let size: number;
    try {
      const st = statSync(full);
      if (!st.isFile()) throw new Error("не файл");
      size = st.size;
    } catch {
      throw notFound("Файл не найден");
    }

    res.setHeader("Content-Type", mimeOfKey(key));
    res.setHeader("Content-Length", String(size));
    // Кэш приватный и короткий: ссылка всё равно живёт пятнадцать минут, а
    // общий кэш на пути к браузеру хранить чужие снимки не должен.
    res.setHeader("Cache-Control", "private, max-age=600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    createReadStream(full).pipe(res);
  })
);
