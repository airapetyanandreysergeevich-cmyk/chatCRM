/**
 * Сжатие и пачки фотографий заказа — то, что можно проверить без браузера.
 *
 *   npx tsx test/photos.ts
 */
import { chunks, fitSide, formatSize, jpegName } from "../src/lib/photos";

let bad = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "ok    " : "БЕДА  ") + m); if (!c) bad++; };

ok(JSON.stringify(fitSide(4032, 3024)) === JSON.stringify({ w: 2560, h: 1920 }), "снимок телефона 12 Мп → 2560×1920");
ok(JSON.stringify(fitSide(3024, 4032)) === JSON.stringify({ w: 1920, h: 2560 }), "вертикальный — тоже по длинной стороне");
ok(JSON.stringify(fitSide(1280, 720)) === JSON.stringify({ w: 1280, h: 720 }), "маленький не растягивается");
ok(jpegName("IMG_0042.HEIC") === "IMG_0042.jpg" && jpegName("фото.png") === "фото.jpg" && jpegName("без") === "без.jpg", "имя сжатого — .jpg");
const c = chunks(Array.from({ length: 23 }, (_, i) => i));
ok(c.length === 3 && c[0].length === 10 && c[2].length === 3, "23 снимка уходят тремя пачками: 10, 10, 3");
ok(formatSize(500 * 1024) === "500 КБ" && formatSize(3.4 * 1024 * 1024) === "3,4 МБ", "размер по-русски");

console.log(bad === 0 ? "\nвсе проверки прошли" : `\nпровалов: ${bad}`);
process.exitCode = bad === 0 ? 0 : 1;
