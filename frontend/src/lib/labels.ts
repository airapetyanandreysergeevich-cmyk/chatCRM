import { useEffect, useState } from "react";
import { api } from "./api";
import { printFormsApi } from "./printForms";
import type { Order } from "./orders";
import type { LabelData } from "../components/Label";

/**
 * Наклейки на технику: настройка, штрихкод и что на какой наклейке.
 *
 * Настройку хранит сервер (backend/src/modules/printing/labels.ts), здесь —
 * её вид для интерфейса, штрихкод Code 128 и расчёт «на какие вещи печатать».
 */

export const LABEL_FIELDS = [
  { id: "logo", label: "Логотип" },
  { id: "workshop", label: "Название мастерской" },
  { id: "number", label: "Номер заказа крупно" },
  { id: "item", label: "Вещь и «1 из 3»" },
  { id: "client", label: "Клиент" },
  { id: "phone", label: "4 последние цифры телефона" },
  { id: "device", label: "Техника: тип, марка, модель" },
  { id: "serial", label: "Серийный номер" },
  { id: "complaint", label: "Неисправность, коротко" },
  { id: "date", label: "Дата приёма" },
  { id: "due", label: "Срок готовности" },
] as const;
export type LabelField = (typeof LABEL_FIELDS)[number]["id"];

export interface LabelSettings {
  width: number;
  height: number;
  rotate: boolean;
  code: "code128" | "qr";
  fields: Record<LabelField, boolean>;
  perItem: string[];
}

/** Ходовые размеры этикеток, мм: ширина × высота, как пишут на рулоне. */
export const LABEL_SIZES: Array<[number, number]> = [
  [58, 40],
  [40, 58],
  [58, 30],
  [58, 60],
  [50, 30],
  [50, 40],
  [43, 25],
  [40, 30],
  [40, 25],
  [30, 20],
  [60, 40],
  [75, 50],
  [80, 50],
  [100, 50],
];

export const labelsApi = {
  get: () => api.get<LabelSettings>("/printing/labels"),
  save: (s: LabelSettings) => api.put<{ ok: true }>("/printing/labels", s),
  byCode: (code: string) => api.get<{ orders: Array<{ id: string; number: string }> }>(`/orders/by-code/${code}`),
};

// ---------------------------------------------------------------- что печатать

/** Цифры номера — то, что в штрихкоде. Буквы сканер на русской раскладке путает, Code 128 их и не умеет. */
export const codeOf = (number: string) => number.replace(/\D/g, "");

export interface LabelItem {
  /** «device» — сама техника, иначе — пункт комплектности как он записан в заказе. */
  key: string;
  title: string;
}

/**
 * На какие вещи печатать наклейки: на саму технику всегда, плюс на пункты
 * комплектности, отмеченные в настройке («Блок питания», «Сумка или чехол»).
 * Пункт сверяется без регистра: в заказе могли написать «блок питания».
 */
export function labelItems(order: Pick<Order, "device" | "completeness">, settings: Pick<LabelSettings, "perItem">): LabelItem[] {
  const wanted = new Set(settings.perItem.map((x) => x.trim().toLowerCase()));
  const device = order.device?.kind?.trim() || "Техника";
  const extra = (order.completeness ?? []).filter((c) => wanted.has(c.trim().toLowerCase()));
  return [{ key: "device", title: device }, ...[...new Set(extra)].map((c) => ({ key: c, title: c }))];
}

/** «Иванов Иван Петрович» → «Иванов И. П.»: на наклейке места мало, а фамилии хватает. */
export function shortName(name: string, company: boolean): string {
  const n = name.trim().replace(/\s+/g, " ");
  if (company) return n;
  const [first, ...rest] = n.split(" ");
  if (!first || !rest.length) return first ?? "";
  // Сокращаем только имена: «Клиент 1886» или «Иванов 2-й» так и остаются.
  return `${first} ${rest.map((w) => (/^\p{L}/u.test(w) ? `${w[0].toUpperCase()}.` : w)).join(" ")}`;
}

// ---------------------------------------------------------------- Code 128

/**
 * Ширины полос и промежутков для значений 0–106 (106 — «стоп»). Таблица из
 * стандарта ISO/IEC 15417: шесть цифр — полоса, промежуток, полоса,
 * промежуток, полоса, промежуток; у «стопа» семь.
 */
const PATTERNS = (
  "212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 " +
  "123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 " +
  "232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 " +
  "313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 " +
  "111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 " +
  "111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 " +
  "114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112"
).split(" ");

const START_B = 104;
const START_C = 105;
const CODE_B = 100;

/**
 * Значения символов Code 128 для строки цифр, с контрольным и «стопом».
 * Пары цифр — набором C (одна полоса на две цифры, штрихкод вдвое короче);
 * нечётная последняя цифра — набором B.
 */
export function code128Values(digits: string): number[] {
  if (!/^\d+$/.test(digits)) throw new Error("В штрихкоде — только цифры");
  const values: number[] = [START_C];
  const even = digits.length - (digits.length % 2);
  for (let i = 0; i < even; i += 2) values.push(Number(digits.slice(i, i + 2)));
  if (digits.length % 2) values.push(CODE_B, digits.charCodeAt(digits.length - 1) - 32);
  const check = values.reduce((sum, v, i) => sum + v * (i === 0 ? 1 : i), 0) % 103;
  return [...values, check, 106];
}

/** Полосы штрихкода: [начало, ширина] в модулях, и общая ширина с тихими зонами по 10 модулей. */
export function code128Bars(digits: string): { bars: Array<[number, number]>; modules: number } {
  const quiet = 10;
  let x = quiet;
  const bars: Array<[number, number]> = [];
  for (const v of code128Values(digits)) {
    const p = PATTERNS[v];
    for (let i = 0; i < p.length; i++) {
      const w = Number(p[i]);
      if (i % 2 === 0) bars.push([x, w]);
      x += w;
    }
  }
  return { bars, modules: x + quiet };
}

/** Точка термопринтера 203 dpi — 0,125 мм. Ширину модуля берём кратной точке: иначе полосы «плывут». */
export const DOT_MM = 25.4 / 203;

/**
 * Ширина модуля штрихкода, мм: целое число точек, чтобы влезть в ширину.
 * Меньше двух точек сканер читает плохо — тогда честно предупреждаем.
 */
export function moduleWidth(modules: number, widthMm: number): { mm: number; dots: number } {
  const dots = Math.max(1, Math.min(4, Math.floor(widthMm / modules / DOT_MM)));
  return { mm: dots * DOT_MM, dots };
}

// ---------------------------------------------------------------- данные наклейки


const shortDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" }) : null;

/** Наклейка заказа: что на ней написать для одной вещи из нескольких. */
export function labelData(order: Order, item: LabelItem, index: number, total: number, workshop: string): LabelData {
  const phoneDigits = (order.customer.phone ?? "").replace(/\D/g, "");
  const d = order.device;
  return {
    workshop,
    number: order.number,
    code: codeOf(order.number) || "0",
    item: { title: item.title, index, total, accessory: item.key !== "device" },
    client: shortName(order.customer.name ?? "", order.customer.type === "COMPANY"),
    phone: phoneDigits.length >= 4 ? phoneDigits.slice(-4) : null,
    device: [d?.kind, d?.brand, d?.model].filter((x) => x && x.trim()).join(" "),
    serial: d?.serial?.trim() || null,
    complaint: order.complaint.replace(/\s+/g, " ").trim(),
    date: shortDate(order.acceptedAt) ?? "",
    due: shortDate(order.dueAt),
  };
}

/** Пример для конструктора и пробной наклейки — когда настоящего заказа под рукой нет. */
export const SAMPLE_LABEL: LabelData = {
  workshop: "Мастерская",
  number: "Р-2026-00123",
  code: "202600123",
  item: { title: "Блок питания", index: 2, total: 3, accessory: true },
  client: "Иванов И. П.",
  phone: "4567",
  device: "Ноутбук ASUS X550",
  serial: "K2N0CV12345678A",
  complaint: "Не включается, после залития чаем",
  date: "03.10.26",
  due: "06.10.26",
};

// ---------------------------------------------------------------- логотип

/**
 * Логотип для термопринтера: только чёрное и белое.
 *
 * Термопринтер не печатает серого — полутон он превращает в редкие точки, и
 * цветной логотип выходит грязным пятном. Поэтому картинка заранее
 * переводится в два цвета: прозрачное — белое, светлее порога — белое,
 * остальное — чёрное. Порог — середина между самым светлым и самым тёмным
 * у самой картинки: бледно-голубой логотип не пропадает целиком, а чёрный не
 * заливается.
 */
export async function monoLogo(src: string, maxHeightPx = 240): Promise<string | null> {
  const img = new Image();
  img.decoding = "async";
  img.src = src;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const k = Math.min(1, maxHeightPx / img.naturalHeight);
  const w = Math.max(1, Math.round(img.naturalWidth * k));
  const h = Math.max(1, Math.round(img.naturalHeight * k));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  // Яркость каждой точки (прозрачное уже на белом фоне).
  let lo = 255, hi = 0;
  const lum = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const y = Math.round(0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]);
    lum[i] = y;
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  if (hi - lo < 16) return null; // однотонная картинка — печатать нечего
  const t = (lo + hi) / 2;
  for (let i = 0; i < w * h; i++) {
    const v = lum[i] < t ? 0 : 255;
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v;
    px[i * 4 + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * Логотип мастерской для наклейки — тот же, что на бланках («Настройки →
 * Бланки»), уже чёрно-белый. ready — можно рисовать: логотип готов или его нет.
 */
export function useLabelLogo(wanted: boolean): { logo: string | null; ready: boolean; missing: boolean } {
  const [state, setState] = useState<{ logo: string | null; ready: boolean; missing: boolean }>({ logo: null, ready: !wanted, missing: false });
  useEffect(() => {
    if (!wanted) {
      setState({ logo: null, ready: true, missing: false });
      return;
    }
    let alive = true;
    setState((s) => ({ ...s, ready: false }));
    printFormsApi
      .get()
      .then(async (f) => {
        const logo = f.logo ? await monoLogo(f.logo) : null;
        if (alive) setState({ logo, ready: true, missing: !f.logo });
      })
      .catch(() => alive && setState({ logo: null, ready: true, missing: false }));
    return () => {
      alive = false;
    };
  }, [wanted]);
  return state;
}
