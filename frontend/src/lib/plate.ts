import { api } from "./api";

/**
 * Распознавание шильдика: снимок → бренд, модель, серийный номер, вид.
 * Разбор делает сервер (backend/src/modules/plate/plate.parse.ts).
 */

export interface PlateField {
  /** Основной вариант. */
  value: string;
  /** Все варианты, основной первым. */
  options: string[];
}

export interface PlateResult {
  brand: PlateField | null;
  model: PlateField | null;
  serial: PlateField | null;
  /** Номер совпал со штрихкодом или QR. */
  serialConfirmed: boolean;
  kind: string | null;
  text: string[];
}

export type PlateKey = "kind" | "brand" | "model" | "serial";

export type DeviceFields = Record<PlateKey, string>;

/**
 * Где распознаётся снимок: на сервере (облако, сервис ocr) или прямо в
 * окне программы (локальная версия, модели раздаёт Основа).
 */
export type PlateMode = "server" | "browser";

export const plateApi = {
  recognize: async (image: Blob, mode: PlateMode = "server") => {
    if (mode === "browser") {
      // Модуль с распознавателем грузится только здесь: в облаке его никто
      // не скачивает.
      const { recognizeHere } = await import("./ocr/browser");
      const ocr = await recognizeHere(image);
      return api.post<PlateResult>("/plate/parse", ocr);
    }
    const form = new FormData();
    form.append("image", image, "plate.jpg");
    return api.upload<PlateResult>("/plate/recognize", form);
  },
  warmUp: async (mode: PlateMode) => {
    if (mode !== "browser") return;
    const { warmUp } = await import("./ocr/browser");
    warmUp();
  },
};

/** Что предложить в окне: основной вариант каждого поля или пусто. */
export function draftOf(r: PlateResult): DeviceFields {
  return {
    kind: r.kind ?? "",
    brand: r.brand?.value ?? "",
    model: r.model?.value ?? "",
    serial: r.serial?.value ?? "",
  };
}

/**
 * Подставить распознанное в бланк.
 *
 * Пустое поле из окна ничего не стирает: не нашёлся серийный номер — значит,
 * не нашёлся, а не «его нет». Вид подставляется, только если в бланке он ещё
 * пуст: «Ноутбук» с шильдика не должен затирать «Игровой ноутбук», который
 * приёмщик выбрал сам.
 */
export function mergeDevice<T extends DeviceFields>(device: T, draft: DeviceFields): T {
  const next = { ...device };
  for (const key of ["brand", "model", "serial"] as const) {
    const v = draft[key].replace(/\s+/g, " ").trim();
    if (v) next[key] = v as T[typeof key];
  }
  const kind = draft.kind.trim();
  if (kind && !device.kind.trim()) next.kind = kind as T["kind"];
  return next;
}

/**
 * Кадр для отправки: не больше 2000 точек по длинной стороне, JPEG.
 *
 * Распознавателю больше и не нужно, а снимок с телефона в 12 мегапикселей
 * весит несколько мегабайт и шёл бы по мобильному интернету дольше, чем
 * распознаётся.
 */
export const MAX_SIDE = 2000;

export function fitSize(w: number, h: number, max = MAX_SIDE): { w: number; h: number } {
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.round(w * k), h: Math.round(h * k) };
}

export async function toJpeg(source: CanvasImageSource, w: number, h: number): Promise<Blob> {
  const size = fitSize(w, h);
  const canvas = document.createElement("canvas");
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Браузер не дал нарисовать кадр");
  ctx.drawImage(source, 0, 0, size.w, size.h);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Не удалось сохранить кадр"))), "image/jpeg", 0.9)
  );
}

/** Файл с диска или из камеры телефона — в тот же JPEG. */
export async function fileToJpeg(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    return await toJpeg(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}
