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
  brand: Hint[];
  model: Hint[];
}

export const EMPTY_HINTS: Hints = { brand: [], model: [] };

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
export function matchHints(all: Hint[], query: string, scope = "", limit = 8): Hint[] {
  const q = query.trim().toLowerCase();
  const s = scope.trim().toLowerCase();

  const starts: Hint[] = [];
  const inside: Hint[] = [];
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
    brand: hints.brand.filter((h) => h.id !== id),
    model: hints.model.filter((h) => h.id !== id),
  };
}

export const hintsApi = {
  list: () => api.get<Hints>("/hints"),
  remove: (id: string) => api.del(`/hints/${id}`),
};
