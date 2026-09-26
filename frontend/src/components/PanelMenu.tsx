import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { IconSettings } from "./icons";
import {
  DEBTOR_SORT_LABELS,
  STAGE_SORT_LABELS,
  summaryApi,
  type DeviceKindOption,
  type PanelPrefs,
} from "../lib/workshop";

/**
 * Шестерёнка на панели главного экрана и её меню.
 *
 * Меню выпадает прямо из панели, а не открывается окном: настройка здесь —
 * «убрать ноутбуки», «новые сверху», — и результат виден сразу, за меню, на
 * той же доске. Окно закрыло бы собой то, что человек и настраивает.
 *
 * Каждое изменение сохраняется сразу, кнопки «Сохранить» нет: переключатель,
 * который не действует до нажатия ещё одной кнопки, на главном экране
 * воспринимается как сломанный.
 */

/** Список типов один на всё приложение: он меняется редко, а меню открывают часто. */
let kindsCache: Promise<DeviceKindOption[]> | null = null;
const loadKinds = () => {
  kindsCache ??= summaryApi
    .kinds()
    .then((r) => r.kinds)
    .catch((e) => {
      kindsCache = null;
      throw e;
    });
  return kindsCache;
};

export function GearButton({ open, onClick, active }: { open: boolean; onClick: () => void; active: boolean }) {
  return (
    <button
      type="button"
      data-gear
      onClick={onClick}
      aria-expanded={open}
      aria-label="Настройки панели"
      title="Настройки панели"
      className={
        "relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-pill transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand " +
        (open ? "bg-surface-hover text-ink" : "text-ink-dim hover:bg-surface-hover hover:text-ink")
      }
    >
      <IconSettings className="h-[17px] w-[17px]" />
      {/* Точка — у панели есть свои настройки: иначе через месяц не
          вспомнить, почему в «Ремонте» нет ноутбуков. */}
      {active && <span aria-hidden className="absolute right-0.5 top-0.5 h-[7px] w-[7px] rounded-full bg-brand" />}
    </button>
  );
}

function Tick({ on }: { on: boolean }) {
  return (
    <span
      className={
        "flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-[5px] border transition-colors duration-150 " +
        (on ? "border-brand bg-brand text-white" : "border-line-strong")
      }
    >
      {on && (
        <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.4}>
          <path d="m3.5 8.5 3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

function Radio({ on }: { on: boolean }) {
  return (
    <span
      className={
        "flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-full border transition-colors duration-150 " +
        (on ? "border-brand" : "border-line-strong")
      }
    >
      {on && <span className="h-[9px] w-[9px] rounded-full bg-brand" />}
    </span>
  );
}

const rowClass =
  "flex min-h-[34px] w-full items-center gap-2.5 rounded-field px-2 text-left text-[13.5px] transition-colors duration-150 hover:bg-surface-hover";

function Heading({ children }: { children: React.ReactNode }) {
  return <p className="px-2 pb-1 pt-3 text-[11px] font-bold uppercase tracking-[0.12em] text-ink-dim">{children}</p>;
}

/** Поле количества: пусто — «авто». Сохраняем, когда человек закончил набирать. */
function LimitField({ value, onChange }: { value: number | null | undefined; onChange: (v: number | null) => void }) {
  const [draft, setDraft] = useState(value ? String(value) : "");
  useEffect(() => setDraft(value ? String(value) : ""), [value]);

  const commit = () => {
    const n = Math.round(Number(draft.replace(/\D+/g, "")));
    const next = draft.trim() === "" || !n ? null : Math.min(60, Math.max(1, n));
    setDraft(next ? String(next) : "");
    if (next !== (value ?? null)) onChange(next);
  };

  return (
    <div className="flex items-center gap-2 px-2">
      <input
        inputMode="numeric"
        value={draft}
        placeholder="авто"
        aria-label="Сколько карточек показывать"
        onChange={(e) => setDraft(e.target.value.replace(/\D+/g, "").slice(0, 2))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        className="h-9 w-20 rounded-field border border-line bg-surface-input px-3 text-[14px] text-ink outline-none placeholder:text-ink-dim focus:border-brand"
      />
      <span className="text-[12.5px] leading-snug text-ink-muted">
        {draft ? "не больше 60" : "сколько поместится на экран"}
      </span>
    </div>
  );
}

export function PanelMenu({
  kind,
  title,
  prefs,
  onChange,
  onKindsToAll,
  onClose,
}: {
  kind: "stage" | "debtors";
  /** Название панели — заголовок листа на телефоне. */
  title?: string;
  prefs: PanelPrefs;
  onChange: (next: PanelPrefs) => void;
  /** Разослать этот набор техники по всем колонкам стадий. */
  onKindsToAll?: (hiddenKinds: string[]) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const [kinds, setKinds] = useState<DeviceKindOption[] | null>(null);
  const [kindsError, setKindsError] = useState(false);
  const [spread, setSpread] = useState(false);

  // Закрываем по щелчку мимо и по Esc — как любое выпадающее меню.
  useEffect(() => {
    const onDown = (e: MouseEvent | TouchEvent) => {
      const el = box.current;
      if (el && !el.contains(e.target as Node) && !(e.target as HTMLElement).closest?.("[data-gear]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  useEffect(() => {
    if (kind !== "stage") return;
    loadKinds()
      .then(setKinds)
      .catch(() => setKindsError(true));
  }, [kind]);

  const sorts: Record<string, string> = kind === "stage" ? STAGE_SORT_LABELS : DEBTOR_SORT_LABELS;
  const defaultSort = Object.keys(sorts)[0];
  const sort = prefs.sort ?? defaultSort;
  const hidden = new Set(prefs.hiddenKinds ?? []);
  const touched = Boolean(prefs.sort || prefs.limit || prefs.hiddenKinds?.length);

  const setHidden = (next: Set<string>) => onChange({ ...prefs, hiddenKinds: [...next].sort() });

  // На телефоне — лист снизу поверх всего: выпадающее из колонки меню там
  // уезжает под нижнюю панель, и до галочек не долистать. На широком
  // экране — обычное выпадающее меню у шестерёнки.
  return (
    <>
      <div aria-hidden className="fixed inset-0 z-[55] bg-black/45 md:hidden" onClick={onClose} />
    <div
      ref={box}
      role="dialog"
      aria-label="Настройки панели"
      className="fixed inset-x-3 bottom-3 z-[60] max-h-[78vh] overflow-y-auto rounded-card border border-line-strong bg-surface-raised p-2 shadow-raised md:absolute md:inset-x-auto md:bottom-auto md:right-2 md:top-12 md:z-30 md:max-h-[min(72vh,560px)] md:w-[296px]"
    >
      {title && <p className="px-2 pt-1.5 text-[15px] font-bold md:hidden">{title}</p>}
      <Heading>Сортировка</Heading>
      {Object.entries(sorts).map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={sort === key}
          className={rowClass}
          onClick={() => onChange({ ...prefs, sort: key === defaultSort ? undefined : key })}
        >
          <Radio on={sort === key} />
          {label}
        </button>
      ))}

      <Heading>Сколько показывать</Heading>
      <LimitField value={prefs.limit} onChange={(limit) => onChange({ ...prefs, limit })} />

      {kind === "stage" && (
        <>
          <Heading>Техника</Heading>
          {kindsError ? (
            <p className="px-2 py-1 text-[13px] text-state-off">Не удалось загрузить типы техники</p>
          ) : !kinds ? (
            <p className="px-2 py-1 text-[13px] text-ink-dim">Загружаем…</p>
          ) : kinds.length === 0 ? (
            <p className="px-2 py-1 text-[13px] text-ink-dim">Техники в базе пока нет</p>
          ) : (
            <>
              {kinds.map((k) => {
                const on = !hidden.has(k.key);
                return (
                  <button
                    key={k.key || "-"}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    className={rowClass + (on ? "" : " text-ink-muted")}
                    onClick={() => {
                      const next = new Set(hidden);
                      if (on) next.add(k.key);
                      else next.delete(k.key);
                      setHidden(next);
                    }}
                  >
                    <Tick on={on} />
                    <span className="min-w-0 flex-1 truncate">{k.label}</span>
                  </button>
                );
              })}
              <div className="flex flex-wrap gap-x-3 gap-y-1 px-2 pt-1.5">
                {hidden.size > 0 && (
                  <button
                    type="button"
                    className="text-[12.5px] font-semibold text-brand-ink hover:underline"
                    onClick={() => setHidden(new Set())}
                  >
                    Включить все
                  </button>
                )}
                {onKindsToAll && (
                  <button
                    type="button"
                    className="text-[12.5px] font-semibold text-brand-ink hover:underline"
                    onClick={() => {
                      onKindsToAll([...hidden].sort());
                      setSpread(true);
                    }}
                  >
                    {spread ? "Применено ко всем панелям" : "Применить ко всем панелям"}
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line px-2 pb-1 pt-2.5">
        <Link to="/settings/interface" className="text-[12.5px] text-ink-muted hover:text-ink hover:underline">
          Порядок панелей
        </Link>
        {touched && (
          <button
            type="button"
            className="text-[12.5px] font-semibold text-ink-muted hover:text-ink hover:underline"
            onClick={() => onChange({})}
          >
            Сбросить
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={onClose}
        className="mt-2 flex min-h-[44px] w-full items-center justify-center rounded-field bg-brand text-[14px] font-semibold text-white md:hidden"
      >
        Готово
      </button>
    </div>
    </>
  );
}
