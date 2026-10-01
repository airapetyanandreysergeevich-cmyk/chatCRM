import { api } from "./api";

/**
 * Словарь распознавания шильдиков — правится собственником платформы.
 *
 * В окне это два простых текста, а не таблица с кнопками: список марок
 * удобнее вставить разом из Excel или заметок, чем добавлять по одной.
 *
 *   Марки — по одной в строке, синонимы через двоеточие и запятые:
 *     Haier
 *     Hewlett-Packard: HP, HPE
 *   Лишние слова — по одной фразе в строке:
 *     Made in China
 *     Energy Star
 *   Марка по модели — марка и шаблоны моделей через двоеточие и запятые:
 *     ASUS: X5##@*, D5##@*
 *     Raybook: RB-1###
 */

export interface PlateDictionary {
  brands: Array<{ name: string; aliases: string[] }>;
  noise: string[];
  models?: Array<{ brand: string; patterns: string[] }>;
}

export interface DictionaryReply {
  dictionary: PlateDictionary;
  builtin: {
    brands: string[];
    noise: string[];
    models?: Array<{ brand: string; patterns: string[] }>;
    series?: Array<{ brand: string; series: string[] }>;
  };
}

/** Модель, у которой при распознавании марка не нашлась. */
export interface PlateMiss {
  modelKey: string;
  model: string;
  uses: number;
  /** Сколько мест (облако целиком — одно, каждая Основа — своё). */
  workshops: number;
  lastAt: string;
  /** Узнаётся ли сейчас: по правилу или по памяти мастерских. */
  resolved: { brand: string; by: "rule" | "history" } | null;
  /** Что мастерские вписывали для этой модели руками. */
  votes: Array<{ brand: string; sources: number }>;
}

const tidy = (s: string) => s.replace(/\s+/g, " ").trim();

export function brandsFromText(text: string): PlateDictionary["brands"] {
  const out: PlateDictionary["brands"] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = tidy(raw);
    if (!line) continue;
    const at = line.indexOf(":");
    const name = tidy(at === -1 ? line : line.slice(0, at));
    const aliases = at === -1 ? [] : line.slice(at + 1).split(",").map(tidy).filter(Boolean);
    if (name.length < 2) continue;
    // Повтор марки — дописываем синонимы к первой, а не заводим вторую.
    const same = out.find((b) => b.name.toLowerCase() === name.toLowerCase());
    if (same) {
      for (const a of aliases) if (!same.aliases.some((x) => x.toLowerCase() === a.toLowerCase())) same.aliases.push(a);
    } else {
      out.push({ name, aliases: [...new Set(aliases)] });
    }
  }
  return out;
}

export const brandsToText = (brands: PlateDictionary["brands"]) =>
  brands.map((b) => (b.aliases.length ? `${b.name}: ${b.aliases.join(", ")}` : b.name)).join("\n");

export function noiseFromText(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = tidy(raw);
    if (line.length < 2 || seen.has(line.toLowerCase())) continue;
    seen.add(line.toLowerCase());
    out.push(line);
  }
  return out;
}

/** «ASUS: X5##@*, D5##@*» — повтор марки дописывает шаблоны к первой строке. */
export function modelsFromText(text: string): NonNullable<PlateDictionary["models"]> {
  const out: NonNullable<PlateDictionary["models"]> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = tidy(raw);
    const at = line.indexOf(":");
    if (at === -1) continue;
    const brand = tidy(line.slice(0, at));
    const patterns = line
      .slice(at + 1)
      .split(",")
      .map((p) => p.replace(/\s+/g, "").toUpperCase())
      .filter(Boolean);
    if (brand.length < 2 || !patterns.length) continue;
    const same = out.find((m) => m.brand.toLowerCase() === brand.toLowerCase());
    if (same) {
      for (const p of patterns) if (!same.patterns.includes(p)) same.patterns.push(p);
    } else {
      out.push({ brand, patterns: [...new Set(patterns)] });
    }
  }
  return out;
}

export const modelsToText = (models: PlateDictionary["models"]) =>
  (models ?? []).map((m) => `${m.brand}: ${m.patterns.join(", ")}`).join("\n");

/**
 * Строки без двоеточия в поле моделей — скорее всего, забыли марку. Не
 * выбрасываем молча, а говорим, какие.
 */
export const modelLinesWithoutBrand = (text: string) =>
  text
    .split(/\r?\n/)
    .map(tidy)
    .filter((l) => l && !l.includes(":"));

/**
 * Шаблон из конкретной модели: «X515EA-BQ1234» → «X515EA*». Основа до первого
 * разделителя, если она осмысленная, — так правило поймает и другие
 * комплектации. Собственник поправит шаблон сам, если нужно шире.
 */
export function patternFromModel(model: string): string {
  const up = model.trim().toUpperCase().replace(/\s+/g, "");
  const parts = up.split(/[-/(_.]/);
  let base = "";
  for (let i = 0; i < parts.length - 1; i++) {
    base += (i ? "-" : "") + parts[i];
    const plain = base.replace(/[^A-Z0-9]/g, "");
    if (plain.length >= 4 && /\d/.test(plain) && /[A-Z]/.test(plain)) return `${base}*`;
  }
  return up;
}

export const plateDictionaryApi = {
  get: () => api.get<DictionaryReply>("/platform/plate-dictionary"),
  save: (d: PlateDictionary) => api.put<DictionaryReply>("/platform/plate-dictionary", d),
  misses: () => api.get<{ items: PlateMiss[] }>("/platform/plate-misses"),
  hideMiss: (key: string) => api.del<{ ok: true }>(`/platform/plate-misses/${encodeURIComponent(key)}`),
};
