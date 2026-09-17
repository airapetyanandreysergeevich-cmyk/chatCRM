import { api } from "./api";
import type { Theme } from "./theme";

/**
 * Логотип и реквизиты мастерской.
 *
 * Логотип живёт строкой data: прямо в настройках: он нужен и в шапке на
 * каждой странице, и в бланках на печать. Ссылка на файл в хранилище тут
 * не годится — она подписанная и живёт пятнадцать минут, а окно печати
 * открывают и через час.
 */

export interface Branding {
  logo: string | null;
  /** Строка под названием в бланках: адрес, телефон, часы работы. */
  printNote: string | null;
}

export const EMPTY_BRANDING: Branding = { logo: null, printNote: null };

/** Логотип в шапке не выше этого, поэтому больше и хранить незачем. */
const MAX_WIDTH = 480;
const MAX_HEIGHT = 240;
/** Потолок на сервере — 200 000 символов; оставляем запас. */
const MAX_CHARS = 180_000;

export const LOGO_TYPES = "image/png,image/jpeg,image/webp";

/**
 * Уменьшает картинку до разумного размера и отдаёт строкой data:.
 *
 * Уменьшаем на клиенте, а не на сервере: фотография логотипа с телефона
 * весит пять мегабайт, и тащить их через сеть ради картинки в сорок
 * пикселей высотой незачем. Прозрачность сохраняем — логотип ляжет и на
 * тёмный фон, и на белый бланк.
 */
export async function prepareLogo(file: File): Promise<string> {
  if (!LOGO_TYPES.split(",").includes(file.type)) {
    throw new Error("Подойдёт PNG, JPEG или WebP");
  }

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(MAX_WIDTH / bitmap.width, MAX_HEIGHT / bitmap.height, 1);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Браузер не дал обработать картинку");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  // PNG сохраняет прозрачность; если вышло слишком тяжело — пробуем WebP,
  // он тоже с прозрачностью, но заметно легче на фотографичных логотипах.
  let data = canvas.toDataURL("image/png");
  if (data.length > MAX_CHARS) data = canvas.toDataURL("image/webp", 0.9);
  if (data.length > MAX_CHARS) data = canvas.toDataURL("image/webp", 0.7);
  if (data.length > MAX_CHARS) throw new Error("Картинка слишком сложная — возьмите вариант попроще");

  return data;
}

export const appearanceApi = {
  get: () => api.get<{ theme: unknown; branding: Branding }>("/settings/appearance"),
  saveBranding: (branding: Branding) => api.put<{ ok: true }>("/settings/branding", branding),
};

export function normalizeBranding(raw: unknown): Branding {
  if (!raw || typeof raw !== "object") return EMPTY_BRANDING;
  const b = raw as Record<string, unknown>;
  return {
    logo: typeof b.logo === "string" && b.logo.startsWith("data:image/") ? b.logo : null,
    printNote: typeof b.printNote === "string" && b.printNote.trim() ? b.printNote.trim() : null,
  };
}

export type { Theme };
