import { Router } from "express";
import { ah, notFound } from "../../lib/errors";
import { mimeOfKey, openFile, verifyLink } from "../../lib/storage";

/**
 * Раздача файлов по подписанной ссылке — в облаке и в локальной версии.
 *
 * Единственный маршрут во всём приложении без проверки входа — и так и
 * задумано: ссылка на снимок попадает в тег <img> и в окно печати, куда
 * заголовок с токеном не подставить. Роль пропуска играет подпись в самой
 * ссылке: она выдана тому, кто уже имел доступ к заказу, и действует
 * пятнадцать минут.
 *
 * Файл берётся из папки (локальная версия) или из приватного бакета MinIO
 * (облако). Бакет наружу не открыт: прямые ссылки на него вели по
 * внутреннему адресу, и фотографии в облаке не показывались вовсе.
 */

export const filesRouter = Router();

filesRouter.get(
  /^\/(.+)$/,
  ah(async (req, res) => {
    const key = (req.params as unknown as string[])[0];
    const expires = Number(req.query.e);
    const sig = String(req.query.s ?? "");

    // Один и тот же ответ на просроченную ссылку, кривую подпись и чужой
    // путь: подсказывать, что именно не так, значит помогать подбирать.
    if (!verifyLink(key, expires, sig)) throw notFound("Ссылка недействительна");

    // Запись разговора плеер читает кусками: без ответа 206 нельзя перемотать.
    const m = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ""));
    const range = m ? { start: Number(m[1]), end: m[2] ? Number(m[2]) : Number.MAX_SAFE_INTEGER } : undefined;
    const file = await openFile(key, range && range.end >= range.start ? range : undefined);
    if (!file) throw notFound("Файл не найден");

    res.setHeader("Content-Type", mimeOfKey(key));
    res.setHeader("Accept-Ranges", "bytes");
    if (file.total !== undefined && range && file.size !== undefined) {
      res.status(206);
      res.setHeader("Content-Range", `bytes ${range.start}-${range.start + file.size - 1}/${file.total}`);
    }
    if (file.size !== undefined) res.setHeader("Content-Length", String(file.size));
    // Кэш приватный: ссылка всё равно живёт пятнадцать минут, а общий кэш на
    // пути к браузеру хранить чужие снимки не должен. Подпись входит в адрес,
    // поэтому повторный показ той же ссылки берётся из кэша браузера.
    res.setHeader("Cache-Control", "private, max-age=600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    file.body.on("error", () => res.destroy());
    file.body.pipe(res);
  })
);
