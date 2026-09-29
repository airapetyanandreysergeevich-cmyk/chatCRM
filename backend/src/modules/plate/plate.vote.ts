import { modelKeys } from "./plate.parse";

/**
 * Голосование мастерских: какая марка у модели. Без базы — чтобы проверялось
 * тестами (test/plate.ts). Зачем и почему так — в plate.learn.ts.
 */

/** Сколько мастерских должно сойтись на марке, чтобы ей поверили все. */
export const MIN_SOURCES = 2;
/** Во сколько раз согласных должно быть больше, чем несогласных. */
const MAJORITY = 3;

const tidyBrand = (s: string) => s.replace(/\s+/g, " ").trim();
const brandKey = (s: string) => tidyBrand(s).toUpperCase();

/**
 * Голоса по одной модели: марка → сколько мастерских за неё.
 * Подпись марки — самое частое написание.
 */
export interface KeyVotes {
  model: string;
  brands: Array<{ brand: string; sources: number }>;
}

export interface Knowledge {
  /** Все голоса — для списка у собственника. */
  votes: Map<string, KeyVotes>;
  /** Принятые марки: ключ модели → марка. */
  decided: Map<string, string>;
}

/** Пара из заказов одного источника (мастерской или Основы). */
export interface Pair {
  source: string;
  model: string;
  brand: string;
  uses: number;
}

/**
 * Итог по всем парам.
 *
 * Сначала каждый источник выбирает одну марку на ключ — ту, что вписывал
 * чаще. Потом источники голосуют.
 */
export function decide(pairs: Pair[]): Knowledge {
  // источник → ключ → марка → число
  const perSource = new Map<string, Map<string, Map<string, number>>>();
  const spelling = new Map<string, Map<string, number>>();
  const modelSpelling = new Map<string, Map<string, number>>();
  const bump = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);

  for (const p of pairs) {
    const brand = tidyBrand(p.brand);
    if (brand.length < 2 || brand.length > 40) continue;
    const bk = brandKey(brand);
    bump(spelling.get(bk) ?? (spelling.set(bk, new Map()), spelling.get(bk)!), brand, p.uses);
    for (const key of modelKeys(p.model)) {
      const src = perSource.get(p.source) ?? (perSource.set(p.source, new Map()), perSource.get(p.source)!);
      const byBrand = src.get(key) ?? (src.set(key, new Map()), src.get(key)!);
      bump(byBrand, bk, p.uses);
      const ms = modelSpelling.get(key) ?? (modelSpelling.set(key, new Map()), modelSpelling.get(key)!);
      bump(ms, p.model.trim(), p.uses);
    }
  }

  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];

  // ключ → марка → число источников
  const tally = new Map<string, Map<string, number>>();
  for (const keys of perSource.values()) {
    for (const [key, byBrand] of keys) {
      const choice = top(byBrand);
      if (!choice) continue;
      bump(tally.get(key) ?? (tally.set(key, new Map()), tally.get(key)!), choice, 1);
    }
  }

  const votes = new Map<string, KeyVotes>();
  const decided = new Map<string, string>();
  for (const [key, byBrand] of tally) {
    const brands = [...byBrand.entries()]
      .map(([bk, sources]) => ({ brand: top(spelling.get(bk) ?? new Map([[bk, 1]])) ?? bk, sources }))
      .sort((a, b) => b.sources - a.sources || a.brand.localeCompare(b.brand));
    votes.set(key, { model: top(modelSpelling.get(key) ?? new Map([[key, 1]])) ?? key, brands });
    const [first, second] = brands;
    if (first && first.sources >= MIN_SOURCES && first.sources >= MAJORITY * (second?.sources ?? 0)) {
      decided.set(key, first.brand);
    }
  }
  return { votes, decided };
}

