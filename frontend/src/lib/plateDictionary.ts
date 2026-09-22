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
 */

export interface PlateDictionary {
  brands: Array<{ name: string; aliases: string[] }>;
  noise: string[];
}

export interface DictionaryReply {
  dictionary: PlateDictionary;
  builtin: { brands: string[]; noise: string[] };
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

export const plateDictionaryApi = {
  get: () => api.get<DictionaryReply>("/platform/plate-dictionary"),
  save: (d: PlateDictionary) => api.put<DictionaryReply>("/platform/plate-dictionary", d),
};
