import { useEffect, useState } from "react";

/**
 * Обновление программы FineCRM — значком у часов вместо всплывающего окна
 * (Андрей, 22.10.2026: окно посреди работы нажимали по привычке и ждали с
 * клиентом установки). Программа сама загружает обновление в фоне и говорит
 * об этом через мостик (desktop/src/preload.js); страница рисует значок и
 * окно «что нового». В браузере и в облаке мостика нет — значка тоже.
 */

export interface DesktopUpdate {
  version: string;
  /** Сейчас установлена. */
  current: string;
  notes: string;
  /** Загружено — можно ставить. */
  ready: boolean;
  /** Mac: не ставится само, а скачивается. */
  download: boolean;
}

export interface UpdatesBridge {
  state: () => Promise<DesktopUpdate | null>;
  install: () => Promise<{ result: string }>;
  onChange: (fn: (u: DesktopUpdate) => void) => () => void;
}

const bridge = (): UpdatesBridge | null => (typeof window !== "undefined" && window.finecrmDesktop?.updates) || null;

export function useDesktopUpdate(): { update: DesktopUpdate | null; install: () => Promise<{ result: string }> } {
  const [update, setUpdate] = useState<DesktopUpdate | null>(null);
  useEffect(() => {
    const b = bridge();
    if (!b) return;
    let alive = true;
    b.state()
      .then((u) => alive && setUpdate(u))
      .catch(() => undefined);
    const off = b.onChange((u) => alive && setUpdate(u));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return { update, install: () => bridge()?.install() ?? Promise.resolve({ result: "nothing" }) };
}
