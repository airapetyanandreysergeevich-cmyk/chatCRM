import { useEffect, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";

/**
 * Список, к которому можно вернуться (16.10.2026, просьба мастерских: «кнопку
 * назад, к результатам поиска, чтобы заново не вводить то, что ищем»).
 *
 * Поиск живёт в адресе страницы рядом с фильтрами и номером страницы. Тогда
 * «назад» из карточки заказа или клиента приводит к тем же результатам, а
 * ссылку на найденное можно переслать.
 */
export function useUrlSearch(param = "search"): [string, (v: string) => void] {
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get(param) ?? "";
  const [value, setValue] = useState(fromUrl);
  // Что мы сами записали в адрес: его возврат из адреса — не повод
  // переписывать поле, где человек тем временем набрал ещё букву.
  const written = useRef(fromUrl);

  useEffect(() => {
    if (fromUrl === written.current) return;
    written.current = fromUrl;
    setValue(fromUrl);
  }, [fromUrl]);

  useEffect(() => {
    const t = setTimeout(() => {
      const want = value.trim() ? value : "";
      if (want === written.current) return;
      written.current = want;
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (want) p.set(param, want);
          else p.delete(param);
          return p;
        },
        { replace: true }
      );
    }, 300);
    return () => clearTimeout(t);
  }, [value, param, setParams]);

  return [value, setValue];
}

const scrollKey = (key: string, search: string) => `finecrm.scroll:${key}|${search}`;

/**
 * Место прокрутки списка: вернулись из карточки — список на той же строке.
 * Запоминается на каждый адрес списка отдельно (другой поиск — другое место).
 * Восстанавливается один раз, когда список загрузился (`ready`).
 */
export function useScrollMemory(key: string, ready: boolean) {
  const { search } = useLocation();
  const id = scrollKey(key, search);
  const restored = useRef<string | null>(null);

  useEffect(() => {
    const save = () => {
      try {
        sessionStorage.setItem(id, String(Math.round(window.scrollY)));
      } catch {
        // Хранилище недоступно — просто не запомним.
      }
    };
    window.addEventListener("scroll", save, { passive: true });
    return () => window.removeEventListener("scroll", save);
  }, [id]);

  useEffect(() => {
    if (!ready || restored.current === id) return;
    restored.current = id;
    let y = 0;
    try {
      y = Number(sessionStorage.getItem(id) ?? 0) || 0;
    } catch {
      y = 0;
    }
    if (y > 0) requestAnimationFrame(() => window.scrollTo({ top: y }));
  }, [ready, id]);
}

/** Откуда пришли в карточку: адрес списка, к которому вести «назад». */
export type BackState = { back?: string };

export const backState = (pathname: string, search: string): BackState => ({ back: pathname + search });

/** Куда вести «← Заказы»: в список, откуда пришли, иначе — в список заказов как есть. */
export function backTarget(state: unknown, fallback: string): string {
  const b = (state as BackState | null)?.back;
  return typeof b === "string" && b.startsWith("/") && !b.startsWith("//") ? b : fallback;
}
