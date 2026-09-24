import type { SetURLSearchParams } from "react-router-dom";

/**
 * Выбор в списке — сортировка, метка — живёт в адресе и запоминается на
 * устройстве.
 *
 * В адресе — чтобы «назад» из заказа вернуло в тот же список, а не в
 * исходный. На устройстве — чтобы приёмщику, который привык к «сначала
 * горящие», не приходилось выбирать это каждое утро заново.
 *
 * Хранилище браузера бывает недоступно (приватное окно, запрет сайта), и
 * тогда выбор просто не запоминается — список от этого не ломается.
 */

const remembered = (storageKey: string): string | null => {
  try {
    return localStorage.getItem(storageKey);
  } catch {
    return null;
  }
};

const remember = (storageKey: string, value: string) => {
  try {
    if (value) localStorage.setItem(storageKey, value);
    else localStorage.removeItem(storageKey);
  } catch {
    /* не запомнили — не беда */
  }
};

export function listPref<T extends string>(
  params: URLSearchParams,
  setParams: SetURLSearchParams,
  opts: { key: string; storageKey: string; fallback: T; allowed: readonly T[] }
): [T, (next: T) => void] {
  const pick = (raw: string | null): T | null =>
    raw !== null && (opts.allowed as readonly string[]).includes(raw) ? (raw as T) : null;

  const value = pick(params.get(opts.key)) ?? pick(remembered(opts.storageKey)) ?? opts.fallback;

  const set = (next: T) => {
    const p = new URLSearchParams(params);
    if (next === opts.fallback) p.delete(opts.key);
    else p.set(opts.key, next);
    // Сменили порядок или отбор — снова первая страница: седьмая страница
    // другого порядка — это случайные строки.
    p.delete("page");
    setParams(p, { replace: true });
    remember(opts.storageKey, next === opts.fallback ? "" : next);
  };

  return [value, set];
}
