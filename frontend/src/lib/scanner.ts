import { useEffect, useRef } from "react";

/**
 * Сканер штрихкодов.
 *
 * Сканер подключается как клавиатура: «печатает» цифры с наклейки и жмёт
 * Enter — быстрее, чем человек, на порядок. По этой скорости его и узнаём:
 * цифры подряд не медленнее 50 мс друг от друга, шесть и больше, в конце
 * Enter. Тогда это скан, а не набор.
 *
 * Скан, пока курсор в поле ввода, не трогаем: цифры уже напечатаны в поле,
 * и там им виднее (поиск заказов найдёт по ним сам). Исключение — поля с
 * data-scan: там Enter после скана сразу открывает заказ.
 */
const GAP_MS = 50;
const SCAN = /^\d{6,20}$/;

export function useBarcodeScanner(onCode: (code: string) => void) {
  const cb = useRef(onCode);
  cb.current = onCode;
  useEffect(() => {
    let buf = "";
    let last = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const now = performance.now();
      if (now - last > GAP_MS) buf = "";
      last = now;
      if (e.key === "Enter") {
        const code = buf;
        buf = "";
        if (!SCAN.test(code)) return;
        const t = e.target as HTMLElement | null;
        const editable = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
        if (editable && !t.dataset.scan) return;
        e.preventDefault();
        cb.current(code);
        return;
      }
      buf = /^\d$/.test(e.key) ? buf + e.key : "";
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
