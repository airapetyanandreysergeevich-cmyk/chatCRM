import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "./auth";
import {
  appearanceApi,
  EMPTY_BRANDING,
  normalizeBranding,
  type Branding,
} from "./branding";
import {
  applyTheme,
  DEFAULT_THEME,
  normalizeTheme,
  saveMode,
  savedMode,
  themeApi,
  type Mode,
  type Palette,
  type Theme,
} from "./theme";

/**
 * Держит текущие цвета и раскрашивает ими страницу.
 *
 * Тема (светлая или тёмная) берётся из браузера сразу, палитра мастерской
 * прилетает с сервера после входа. Поэтому цвета применяются дважды: первый
 * раз мгновенно из кэша, второй — когда приедут настоящие настройки. Между
 * ними разница обычно нулевая, и человек ничего не замечает.
 */

interface ThemeState {
  mode: Mode;
  /** Что показано сейчас — с учётом несохранённого предпросмотра. */
  theme: Theme;
  /** Что лежит на сервере. По нему решают, есть ли несохранённые правки. */
  saved: Theme;
  setMode: (mode: Mode) => void;
  /** Показать цвета, не сохраняя: страница настроек — это и есть предпросмотр. */
  preview: (theme: Theme) => void;
  /** Вернуть то, что лежит на сервере, — после отказа от правок. */
  revert: () => void;
  save: (theme: Theme) => Promise<void>;
  reset: () => Promise<void>;
  /** Логотип и реквизиты мастерской — едут тем же запросом, что и палитра. */
  branding: Branding;
  saveBranding: (branding: Branding) => Promise<void>;
}

const ThemeContext = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const [mode, setModeState] = useState<Mode>(savedMode);
  /** Сохранённая палитра мастерской. */
  const [saved, setSaved] = useState<Theme>(DEFAULT_THEME);
  /** То, что показываем сейчас: обычно совпадает с сохранённой. */
  const [shown, setShown] = useState<Theme>(DEFAULT_THEME);
  const [branding, setBranding] = useState<Branding>(EMPTY_BRANDING);

  useEffect(() => {
    applyTheme(shown, mode);
  }, [shown, mode]);

  useEffect(() => {
    if (status !== "ready") return;
    let alive = true;
    appearanceApi
      .get()
      .then((r) => {
        if (!alive) return;
        const theme = normalizeTheme(r.theme);
        setSaved(theme);
        setShown(theme);
        setBranding(normalizeBranding(r.branding));
      })
      // Платформенный пользователь вне мастерской настроек не имеет — и не должен.
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [status]);

  /**
   * Откат обязан быть стабильным.
   *
   * Страница настроек вызывает его при уходе, через эффект размонтирования.
   * Если функция пересоздаётся на каждый рендер, React считает эффект
   * устаревшим и выполняет его очистку прямо посреди работы — цвет
   * откатывался в ту же секунду, когда его выбрали.
   */
  const savedRef = useRef(saved);
  useEffect(() => {
    savedRef.current = saved;
  }, [saved]);
  const revert = useCallback(() => setShown(savedRef.current), []);

  const setMode = useCallback((next: Mode) => {
    saveMode(next);
    setModeState(next);
  }, []);

  const saveBranding = useCallback(async (next: Branding) => {
    await appearanceApi.saveBranding(next);
    setBranding(next);
  }, []);

  const save = useCallback(async (theme: Theme) => {
    await themeApi.save(theme);
    setSaved(theme);
    setShown(theme);
  }, []);

  const reset = useCallback(async () => {
    await themeApi.reset();
    setSaved(DEFAULT_THEME);
    setShown(DEFAULT_THEME);
  }, []);

  const value = useMemo<ThemeState>(
    () => ({
      mode,
      theme: shown,
      saved,
      setMode,
      preview: setShown,
      revert,
      save,
      reset,
      branding,
      saveBranding,
    }),
    [mode, shown, saved, setMode, revert, save, reset, branding, saveBranding]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme вызван вне ThemeProvider");
  return ctx;
}

export type { Mode, Palette, Theme };
