import { useEffect, useState } from "react";
import { summaryApi } from "./workshop";

/**
 * Где история ремонта в карточке заказа (Андрей, 27.10.2026): на своём месте
 * под фотографиями или прикреплена колонкой слева / справа во всю высоту.
 *
 * Выбор — у сотрудника (настройки главного экрана на сервере), чтобы на всех
 * его компьютерах было одинаково. Копия в браузере — чтобы карточка сразу
 * открывалась как надо, не дожидаясь ответа сервера.
 */
export type HistoryDock = "left" | "right" | null;

const KEY = "finecrm.history.dock";
let cache: HistoryDock | undefined;

const readLocal = (): HistoryDock => {
  try {
    const v = localStorage.getItem(KEY);
    return v === "left" || v === "right" ? v : null;
  } catch {
    return null;
  }
};
const writeLocal = (d: HistoryDock) => {
  try {
    if (d) localStorage.setItem(KEY, d);
    else localStorage.removeItem(KEY);
  } catch {
    /* не запомнили на этом компьютере — сервер помнит */
  }
};

export function useHistoryDock(): [HistoryDock, (d: HistoryDock) => void] {
  const [dock, setDock] = useState<HistoryDock>(() => cache ?? readLocal());

  useEffect(() => {
    if (cache !== undefined) return;
    let alive = true;
    summaryApi
      .prefs()
      .then((r) => {
        const d = r.prefs.historyDock ?? null;
        cache = d;
        writeLocal(d);
        if (alive) setDock(d);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const change = (d: HistoryDock) => {
    cache = d;
    setDock(d);
    writeLocal(d);
    // Остальные настройки главного экрана — как были: читаем свежие и меняем одно поле.
    void summaryApi
      .prefs()
      .then((r) => summaryApi.savePrefs({ ...r.prefs, historyDock: d ?? undefined }))
      .catch(() => undefined);
  };

  return [dock, change];
}

/** Ширина элемента — следим, пока он на экране. */
export function useWidth(el: HTMLElement | null): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!el) return;
    const put = () => setW(el.clientWidth);
    put();
    const ro = new ResizeObserver(put);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return w;
}

/**
 * Порядок истории ремонта (Андрей, 29.10.2026): новые снизу, как в переписке,
 * или новые сверху. Тоже у сотрудника, с копией в браузере.
 */
export type HistoryOrder = "bottom" | "top";
const ORDER_KEY = "finecrm.history.order";
let orderCache: HistoryOrder | undefined;

const readOrder = (): HistoryOrder => {
  try {
    return localStorage.getItem(ORDER_KEY) === "top" ? "top" : "bottom";
  } catch {
    return "bottom";
  }
};
const writeOrder = (o: HistoryOrder) => {
  try {
    localStorage.setItem(ORDER_KEY, o);
  } catch {
    /* сервер помнит */
  }
};

export function useHistoryOrder(): [HistoryOrder, (o: HistoryOrder) => void] {
  const [order, setOrder] = useState<HistoryOrder>(() => orderCache ?? readOrder());

  useEffect(() => {
    if (orderCache !== undefined) return;
    let alive = true;
    summaryApi
      .prefs()
      .then((r) => {
        const o: HistoryOrder = r.prefs.historyOrder === "top" ? "top" : "bottom";
        orderCache = o;
        writeOrder(o);
        if (alive) setOrder(o);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const change = (o: HistoryOrder) => {
    orderCache = o;
    setOrder(o);
    writeOrder(o);
    void summaryApi
      .prefs()
      .then((r) => summaryApi.savePrefs({ ...r.prefs, historyOrder: o === "top" ? "top" : undefined }))
      .catch(() => undefined);
  };

  return [order, change];
}
