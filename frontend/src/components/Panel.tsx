import { useState, type ReactNode } from "react";
import { Card } from "./ui";

/**
 * Сворачиваемая панель настроек.
 *
 * Андрей: «панели имели справа значок раскрывающегося списка — хочешь все
 * раскрой, хочешь парочку, при входе по умолчанию свёрнутыми». Заголовок —
 * всегда на виду, нажатие по нему раскрывает и сворачивает. Что раскрыто,
 * запоминается на этом устройстве: зашёл в «Бланки» поправить шапку — завтра
 * шапка открыта, остальное свёрнуто.
 *
 * Справа от заголовка можно поставить свой элемент — например выключатель.
 * Он живёт отдельно от кнопки заголовка: нажатие по нему панель не трогает.
 */

const STORE = "finecrm.panels";

function remembered(id: string): boolean | undefined {
  try {
    const all = JSON.parse(localStorage.getItem(STORE) ?? "{}") as Record<string, boolean>;
    return typeof all[id] === "boolean" ? all[id] : undefined;
  } catch {
    return undefined;
  }
}

function remember(id: string, open: boolean) {
  try {
    const all = JSON.parse(localStorage.getItem(STORE) ?? "{}") as Record<string, boolean>;
    all[id] = open;
    localStorage.setItem(STORE, JSON.stringify(all));
  } catch {
    /* не запомнили — откроется как обычно */
  }
}

export function Panel({
  id,
  title,
  summary,
  right,
  defaultOpen = false,
  open: forced,
  onOpenChange,
  className,
  children,
}: {
  /** Ключ для памяти «раскрыто/свёрнуто»: «страница:панель». */
  id: string;
  title: ReactNode;
  /** Строка под заголовком — видна и в свёрнутом виде: «Выключено», «Свой телефон · на связи». */
  summary?: ReactNode;
  /** Свой элемент справа, перед значком: выключатель, кнопка. */
  right?: ReactNode;
  defaultOpen?: boolean;
  /** Управлять снаружи: например, выключили SMS — панель сворачивается сама. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
  children: ReactNode;
}) {
  const [own, setOwn] = useState(() => remembered(id) ?? defaultOpen);
  const open = forced ?? own;

  const toggle = () => {
    const next = !open;
    setOwn(next);
    remember(id, next);
    onOpenChange?.(next);
  };

  return (
    <Card className={className}>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          className="-my-1 flex min-w-0 flex-1 items-center gap-3 rounded-field py-1 text-left outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-[15.5px] font-bold leading-snug text-ink">{title}</span>
            {summary && <span className="mt-1 block truncate text-[13px] text-ink-muted">{summary}</span>}
          </span>
        </button>
        {right}
        <button
          type="button"
          onClick={toggle}
          aria-label={open ? "Свернуть" : "Раскрыть"}
          className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full text-ink-dim transition-colors duration-150 hover:bg-surface-raised hover:text-ink"
        >
          <svg
            viewBox="0 0 20 20"
            aria-hidden
            className={"h-[18px] w-[18px] transition-transform duration-200 " + (open ? "rotate-180" : "")}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 8l5 5 5-5" />
          </svg>
        </button>
      </div>
      {/* Свёрнутое прячется, а не убирается: набранное в полях и начатая
          загрузка файла не должны пропадать оттого, что панель свернули. */}
      <div className={open ? "mt-1" : "hidden"}>{children}</div>
    </Card>
  );
}
