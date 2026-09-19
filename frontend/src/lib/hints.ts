import { api } from "./api";

/**
 * Память полей техники: что в мастерской уже вводили руками.
 *
 * Список не задан заранее и не приходит из справочника — он накапливается из
 * принятых заказов. Поэтому подсказки у каждой мастерской свои: та, что
 * чинит только ноутбуки, не листает моторные блоки чужого потока.
 */

export interface Hint {
  id: string;
  /** Для модели — марка, к которой она относится (в нижнем регистре); у марки пусто. */
  scope: string;
  value: string;
  /** Сколько раз пригодилось: по этому числу список и выстроен сервером. */
  uses: number;
}

export interface Hints {
  kind: Hint[];
  brand: Hint[];
  model: Hint[];
}

export const EMPTY_HINTS: Hints = { kind: [], brand: [], model: [] };

/**
 * Встроенные виды техники плюс то, что мастерская вводила сама.
 *
 * Встроенный список нужен первому дню работы: в пустой мастерской подсказать
 * нечего, а начинать с чистого поля — значит заставить приёмщика выдумывать
 * написание. Но он же и мешает: список из девяти строк заканчивается словом
 * «Прочее», и мастерская, которая чинит кофемашины, складывает туда половину
 * своих заказов.
 *
 * Поэтому оба: встроенное идёт следом за своим, а совпадения по написанию
 * убираем — «Ноутбук», уже введённый руками, не должен стоять в списке
 * дважды. Встроенные помечены fixed: забыть их нельзя, потому что их и не
 * запоминали.
 */
export function withBuiltIn(own: Hint[], builtIn: readonly string[]): Array<Hint & { fixed?: boolean }> {
  const known = new Set(own.map((h) => h.value.trim().toLowerCase()));
  return [
    ...own,
    ...builtIn
      .filter((v) => !known.has(v.trim().toLowerCase()))
      .map((v) => ({ id: "built-in:" + v, scope: "", value: v, uses: 0, fixed: true })),
  ];
}

/**
 * Подбор вариантов по набранному.
 *
 * Подсказываем с первой же буквы: поля короткие, и ждать третьего символа,
 * как в поиске, здесь незачем. Сначала те, что начинаются с набранного,
 * потом те, у кого оно внутри, — человек печатает начало слова, и «Acer»
 * должен стоять выше, чем «Packard Bell Acer».
 *
 * scope отсекает чужие модели: пока в марке стоит Lenovo, ASUS-овские
 * модели в списке не нужны. Варианты, запомненные без марки, показываем
 * всегда — они относятся ко всему сразу.
 */
export function matchHints<T extends Hint>(all: T[], query: string, scope = "", limit = 8): T[] {
  const q = query.trim().toLowerCase();
  const s = scope.trim().toLowerCase();

  // Обобщённый тип, а не просто Hint: у встроенных видов техники есть
  // пометка fixed, и потеряв её здесь, список показал бы урну там, где
  // забывать нечего.
  const starts: T[] = [];
  const inside: T[] = [];
  for (const h of all) {
    if (s && h.scope && h.scope !== s) continue;
    const value = h.value.toLowerCase();
    if (value === q) continue; // уже набрано целиком — подсказывать нечего
    if (!q) starts.push(h);
    else if (value.startsWith(q)) starts.push(h);
    else if (value.includes(q)) inside.push(h);
  }
  return [...starts, ...inside].slice(0, limit);
}

/** Убирает вариант из локального списка — чтобы не перезапрашивать весь. */
export function withoutHint(hints: Hints, id: string): Hints {
  return {
    kind: hints.kind.filter((h) => h.id !== id),
    brand: hints.brand.filter((h) => h.id !== id),
    model: hints.model.filter((h) => h.id !== id),
  };
}

export const hintsApi = {
  list: () => api.get<Hints>("/hints"),
  remove: (id: string) => api.del(`/hints/${id}`),
};
