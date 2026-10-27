import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Кнопка «свернуть / развернуть меню» — наверху, рядом с колокольчиком
 * (Андрей, 27.10.2026: «так будет правильней и удобней»). Значок — панель со
 * стрелкой: меню открыто — стрелка «‹» (свернуть), закрыто — «›». Стрелка
 * поворачивается, а левая полоса панели «заполнена», пока меню открыто.
 */
export function SideToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const label = collapsed ? "Развернуть меню" : "Свернуть меню";
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      aria-expanded={!collapsed}
      data-rail-tip={label}
      data-sidebar-toggle={collapsed ? "collapsed" : "expanded"}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-field text-ink-muted transition-colors duration-150 hover:bg-surface-raised hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
    >
      <svg viewBox="0 0 24 24" className="h-[19px] w-[19px]" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="M9 4v16" />
        <rect
          x="4.2"
          y="5.2"
          width="3.6"
          height="13.6"
          rx="1.6"
          fill="currentColor"
          stroke="none"
          className="transition-opacity duration-200"
          style={{ opacity: collapsed ? 0 : 0.35 }}
        />
        <g className="transition-transform duration-200 ease-out" style={{ transformOrigin: "14.75px 12px", transform: collapsed ? "rotate(180deg)" : "none" }}>
          <path d="m16 9.5-2.5 2.5 2.5 2.5" />
        </g>
      </svg>
    </button>
  );
}

/**
 * Подсказки свёрнутого меню: одна плашка с названием, которая плавно
 * переезжает за курсором от значка к значку (Андрей: «если вверх-вниз
 * проводить курсором, чтоб названия красиво и приятно перебирались»).
 *
 * Пункты помечаются data-rail-tip="Название" (и data-rail-badge — число).
 * Первый раз плашка появляется через 0,3 с — чтобы не мигала, когда мышь
 * просто проходит мимо меню; дальше между значками — сразу и плавно.
 * Уходит через 0,15 с после того, как курсор покинул меню.
 */
export function useRailTips(enabled: boolean) {
  const [tip, setTip] = useState<{ label: string; badge: number; y: number; x: number; shown: boolean; slide: boolean } | null>(null);
  const showTimer = useRef<number>();
  const hideTimer = useRef<number>();
  const shownRef = useRef(false);

  const clear = () => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
  };

  const place = useCallback((el: HTMLElement) => {
    window.clearTimeout(hideTimer.current);
    const r = el.getBoundingClientRect();
    const rail = el.closest("aside")?.getBoundingClientRect();
    const next = {
      label: el.dataset.railTip ?? "",
      badge: Number(el.dataset.railBadge ?? 0) || 0,
      y: r.top + r.height / 2,
      x: (rail?.right ?? r.right) + 10,
    };
    if (shownRef.current) {
      setTip({ ...next, shown: true, slide: true });
      return;
    }
    // Ещё не видна: ставим на место без анимации и показываем с задержкой.
    setTip({ ...next, shown: false, slide: false });
    window.clearTimeout(showTimer.current);
    showTimer.current = window.setTimeout(() => {
      shownRef.current = true;
      setTip((t) => (t ? { ...t, shown: true } : t));
    }, 300);
  }, []);

  const hide = useCallback((now = false) => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    const go = () => {
      shownRef.current = false;
      setTip((t) => (t ? { ...t, shown: false } : t));
    };
    if (now) go();
    else hideTimer.current = window.setTimeout(go, 150);
  }, []);

  useEffect(() => {
    if (!enabled) {
      clear();
      shownRef.current = false;
      setTip(null);
    }
    return clear;
  }, [enabled]);

  const bind = enabled
    ? {
        onPointerOver: (e: React.PointerEvent) => {
          if (e.pointerType === "touch") return;
          const el = (e.target as Element).closest<HTMLElement>("[data-rail-tip]");
          if (el) place(el);
          else hide();
        },
        onPointerLeave: () => hide(),
        onFocus: (e: React.FocusEvent) => {
          const el = (e.target as Element).closest<HTMLElement>("[data-rail-tip]");
          if (!el || !el.matches(":focus-visible")) return;
          shownRef.current = true;
          place(el);
        },
        onBlur: () => hide(),
        onClick: () => hide(true),
      }
    : {};

  const node =
    enabled && tip
      ? createPortal(
          <div
            role="tooltip"
            data-rail-tooltip={tip.shown ? tip.label : ""}
            className="pointer-events-none fixed left-0 top-0 z-[90] flex h-[34px] items-center gap-2 whitespace-nowrap rounded-[10px] border border-line-strong bg-surface-raised px-3 text-[13.5px] font-semibold text-ink shadow-raised before:absolute before:-left-[5px] before:top-1/2 before:h-[9px] before:w-[9px] before:-translate-y-1/2 before:rotate-45 before:border-b before:border-l before:border-line-strong before:bg-surface-raised"
            style={{
              transform: `translate(${tip.x}px, ${tip.y - 17}px)`,
              opacity: tip.shown ? 1 : 0,
              transition: tip.slide ? "transform 160ms cubic-bezier(.2,.8,.2,1), opacity 120ms ease" : "opacity 120ms ease",
            }}
          >
            {tip.label}
            {!!tip.badge && (
              <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-state-off px-1.5 text-[11px] font-bold text-white">
                {tip.badge > 99 ? "99+" : tip.badge}
              </span>
            )}
          </div>,
          document.body
        )
      : null;

  return { bind, node };
}
