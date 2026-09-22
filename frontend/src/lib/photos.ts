/**
 * Фотографии заказа: сжатие перед загрузкой.
 *
 * Снимок телефона — 12–48 мегапикселей и 3–8 МБ. Для заказа это лишнее
 * втрое и вдесятеро: царапину на крышке видно и на 2560 точках, а сотня
 * заказов с десятком снимков в оригинале съедала бы хранилище гигабайтами и
 * грузилась бы на мобильном интернете минутами. Поэтому каждый снимок перед
 * отправкой уменьшается до 2560 точек по длинной стороне и пересохраняется в
 * JPEG — обычно это 300–700 КБ вместо нескольких мегабайт.
 *
 * Что не удалось открыть (HEIC на компьютере, PDF), уходит как есть: лучше
 * тяжёлый снимок, чем потерянный.
 */

export const PHOTO_SIDE = 2560;
export const PHOTO_QUALITY = 0.82;
/** Сколько снимков в одном запросе: сервер принимает до двадцати. */
export const UPLOAD_CHUNK = 10;

/** Размер после уменьшения: длинная сторона не больше side, маленькие не растягиваем. */
export function fitSide(w: number, h: number, side = PHOTO_SIDE): { w: number; h: number } {
  const k = Math.min(1, side / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** Имя сжатого файла: то же, но .jpg. */
export function jpegName(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, "") || "photo";
  return `${base}.jpg`;
}

/** Разбить на пачки по n. */
export function chunks<T>(items: T[], n = UPLOAD_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

async function encode(source: CanvasImageSource, w: number, h: number): Promise<Blob> {
  const size = fitSide(w, h);
  const canvas = document.createElement("canvas");
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Браузер не дал нарисовать снимок");
  ctx.drawImage(source, 0, 0, size.w, size.h);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", PHOTO_QUALITY));
  // Освобождаем память сразу: на телефоне десяток холстов по 12 Мп — это
  // сотни мегабайт, и вкладку выгрузили бы посреди съёмки.
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new Error("Не удалось сохранить снимок");
  return blob;
}

/** Кадр с камеры — сразу в сжатый JPEG. */
export async function frameToPhoto(video: HTMLVideoElement, n: number): Promise<File> {
  const blob = await encode(video, video.videoWidth, video.videoHeight);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return new File([blob], `Снимок-${stamp}-${n}.jpg`, { type: "image/jpeg" });
}

/** Файл из галереи — уменьшить, если есть что уменьшать. */
export async function compressPhoto(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file; // HEIC на компьютере и прочее, что браузер не открывает
  }
  try {
    const small = Math.max(bitmap.width, bitmap.height) <= PHOTO_SIDE;
    // Уже небольшой JPEG пересохранять незачем: станет только хуже.
    if (small && file.type === "image/jpeg" && file.size <= 800 * 1024) return file;
    const blob = await encode(bitmap, bitmap.width, bitmap.height);
    if (blob.size >= file.size && file.type !== "image/heic") return file;
    return new File([blob], jpegName(file.name), { type: "image/jpeg" });
  } catch {
    return file;
  } finally {
    bitmap.close();
  }
}

export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} МБ`;
}
