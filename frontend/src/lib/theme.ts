import { api } from "./api";

/**
 * Цвета интерфейса.
 *
 * Владелец задаёт семь цветов: фон, панели, кнопки и четыре стадии заказа.
 * Всё остальное — линии, оттенки текста, приподнятые поверхности, подложки
 * плашек — вычисляется из них здесь. Это не лень: если дать настроить сорок
 * цветов, первая же мастерская соберёт из них нечитаемый интерфейс, а с
 * семью исходными любой набор остаётся рабочим.
 *
 * Тема (светлая или тёмная) — личное дело сотрудника и живёт в его браузере.
 * Палитра общая на мастерскую: цвет колонки «Ремонт» должен значить одно и
 * то же для мастера и для приёмщика.
 */

export type Mode = "dark" | "light";

export interface Palette {
  /** Фон всего окна. */
  bg: string;
  /** Фон панелей и карточек. */
  surface: string;
  /** Кнопки и выделение активного пункта меню. */
  brand: string;
  stageNew: string;
  stageWaiting: string;
  stageProgress: string;
  stageDone: string;
}

/** Палитры хранятся раздельно: цвет, читаемый на чёрном, на белом слепнет. */
export type Theme = Record<Mode, Palette>;

export const PALETTE_FIELDS: Array<{ key: keyof Palette; label: string; hint: string }> = [
  { key: "stageNew", label: "Диагностика", hint: "Колонка на главной и статусы этой стадии" },
  { key: "stageWaiting", label: "Согласование", hint: "Ждём ответа клиента или запчасть" },
  { key: "stageProgress", label: "Ремонт", hint: "Мастер работает с техникой" },
  { key: "stageDone", label: "Выдача", hint: "Готово, ждёт клиента" },
  { key: "bg", label: "Фон окна", hint: "Самый нижний слой, под панелями" },
  { key: "surface", label: "Фон панелей", hint: "Карточки, списки, модальные окна" },
  { key: "brand", label: "Кнопки", hint: "Основные кнопки и выделение в меню" },
];

export const DEFAULT_THEME: Theme = {
  dark: {
    bg: "#0F1117",
    surface: "#171A22",
    brand: "#2F8FE0",
    stageNew: "#FFF993",
    stageWaiting: "#FC7E68",
    stageProgress: "#FE3E7D",
    stageDone: "#A5F88B",
  },
  light: {
    bg: "#F1F4F9",
    surface: "#FFFFFF",
    brand: "#2478C6",
    // На белом те же оттенки приходится брать темнее и насыщеннее:
    // бледно-жёлтый на белом не виден вовсе.
    stageNew: "#B38A00",
    stageWaiting: "#D9542F",
    stageProgress: "#D4145A",
    stageDone: "#2C8C4A",
  },
};

/**
 * Служебные цвета состояний. Это не палитра мастерской, а язык интерфейса:
 * просрочка красная, деньги пришли — зелёные. Настраивать их незачем, но
 * под светлую тему они всё равно должны темнеть, иначе выцветают.
 */
const STATE: Record<Mode, Record<"new" | "waiting" | "progress" | "done" | "off", string>> = {
  dark: { new: "#4C8DFF", waiting: "#E8A94B", progress: "#46B9CE", done: "#45C08A", off: "#E06B6B" },
  light: { new: "#2563C9", waiting: "#A96A00", progress: "#1E7F93", done: "#1F8A4C", off: "#C4362F" },
};

// ------------------------------------------------------------- работа с цветом

const HEX = /^#[0-9A-Fa-f]{6}$/;

export const isHex = (v: string) => HEX.test(v.trim());

function toRgb(hex: string): [number, number, number] {
  const h = hex.trim().replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const toHex = ([r, g, b]: [number, number, number]) =>
  "#" + [r, g, b].map((n) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, "0")).join("");

/** t — доля второго цвета: mix(чёрный, белый, 0.25) даёт тёмно-серый. */
function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = toRgb(a);
  const [r2, g2, b2] = toRgb(b);
  return toHex([r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t]);
}

/** Относительная яркость по sRGB — по ней решаем, тёмный фон или светлый. */
export function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export const isDarkColor = (hex: string) => luminance(hex) < 0.35;

/** Контраст по WCAG: 4.5 — порог для обычного текста. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Tailwind ждёт каналы через пробел: так работает запись bg-surface/40. */
const channels = (hex: string) => toRgb(hex).join(" ");

// ------------------------------------------------------------------ вычисление

/**
 * Из семи заданных цветов получаем весь набор переменных.
 *
 * Оттенки берём подмешиванием цвета текста в фон, а не фиксированными
 * значениями: тогда и на угольном, и на белом фоне линии остаются видны, но
 * не лезут в глаза.
 */
export function deriveTokens(palette: Palette, mode: Mode): Record<string, string> {
  const p = palette;
  const dark = isDarkColor(p.bg);
  const ink = dark ? "#E7EAF2" : "#161A22";
  const state = STATE[mode];

  const tokens: Record<string, string> = {
    "--bg": p.bg,
    "--surface": p.surface,
    "--surface-raised": mix(p.surface, ink, 0.07),
    "--surface-hover": mix(p.surface, ink, 0.12),
    "--surface-input": dark ? mix(p.surface, p.bg, 0.65) : mix(p.surface, ink, 0.04),

    "--line": mix(p.surface, ink, 0.14),
    "--line-strong": mix(p.surface, ink, 0.26),

    "--ink": ink,
    "--ink-soft": mix(ink, p.surface, 0.22),
    "--ink-muted": mix(ink, p.surface, 0.42),
    "--ink-dim": mix(ink, p.surface, 0.58),

    "--brand": p.brand,
    "--brand-press": mix(p.brand, "#000000", 0.16),
    "--brand-tint": mix(p.surface, p.brand, dark ? 0.17 : 0.11),
    // Цвет текста-ссылки: чистый цвет кнопки на своём же фоне часто не
    // дочитывается, поэтому его осветляют или притемняют под тему.
    "--brand-ink": dark ? mix(p.brand, "#FFFFFF", 0.42) : mix(p.brand, "#000000", 0.2),

    "--stage-new": p.stageNew,
    "--stage-waiting": p.stageWaiting,
    "--stage-progress": p.stageProgress,
    "--stage-done": p.stageDone,

    "--state-new": state.new,
    "--state-waiting": state.waiting,
    "--state-progress": state.progress,
    "--state-done": state.done,
    "--state-off": state.off,
  };

  return Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k, channels(v)]));
}

// ------------------------------------------------------------------- применение

const MODE_KEY = "theme:mode";
const CACHE_KEY = "theme:tokens";

export function savedMode(): Mode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* приватное окно — просто берём тёмную */
  }
  return "dark";
}

export function saveMode(mode: Mode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* не сохранилось — переживём */
  }
}

/**
 * Раскрашивает страницу.
 *
 * Значения кладём инлайном на <html>: так они заведомо перебивают файл
 * стилей, и не нужно гадать про порядок подключения.
 */
export function applyTheme(theme: Theme, mode: Mode) {
  const tokens = deriveTokens(theme[mode], mode);
  const root = document.documentElement;
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);

  root.dataset.theme = mode;
  root.style.colorScheme = mode;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme[mode].bg);

  // Кэш нужен, чтобы при следующем открытии страница не моргнула
  // стандартными цветами, пока летит запрос за настройками мастерской.
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(tokens));
  } catch {
    /* без кэша просто будет моргать */
  }
}

// ---------------------------------------------------------------------- сервер

export const themeApi = {
  // Чтение идёт через /settings/appearance вместе с логотипом — см. lib/branding.ts.
  save: (theme: Theme) => api.put<{ ok: true }>("/settings/theme", { theme }),
  reset: () => api.del<{ ok: true }>("/settings/theme"),
};

/** Приводит что угодно с сервера к полной теме: чужие и битые поля отбрасываем. */
export function normalizeTheme(raw: unknown): Theme {
  const out: Theme = { dark: { ...DEFAULT_THEME.dark }, light: { ...DEFAULT_THEME.light } };
  if (!raw || typeof raw !== "object") return out;

  for (const mode of ["dark", "light"] as Mode[]) {
    const part = (raw as Record<string, unknown>)[mode];
    if (!part || typeof part !== "object") continue;
    for (const { key } of PALETTE_FIELDS) {
      const v = (part as Record<string, unknown>)[key];
      if (typeof v === "string" && isHex(v)) out[mode][key] = v.toUpperCase();
    }
  }
  return out;
}
