import { useEffect, useRef, useState } from "react";
import { IconChevronDown, IconGlobe } from "./icons";

/**
 * «Найти в интернете» — поиск похожей неисправности по марке, модели и жалобе.
 *
 * Основная часть кнопки сразу открывает поиск выбранным поисковиком (запоминается
 * на устройстве), стрелка — окошко: поправить запрос, искать по диагнозу,
 * выбрать Яндекс или Google. В программе FineCRM ссылка уходит во внешний
 * браузер (main.js, setWindowOpenHandler), на телефоне — в браузер телефона.
 */

export type Engine = "yandex" | "google";
const ENGINE_KEY = "finecrm.websearch.engine";
export const ENGINE_LABEL: Record<Engine, string> = { yandex: "Яндекс", google: "Google" };

function savedEngine(): Engine {
  try {
    return localStorage.getItem(ENGINE_KEY) === "google" ? "google" : "yandex";
  } catch {
    return "yandex";
  }
}
function saveEngine(e: Engine) {
  try {
    localStorage.setItem(ENGINE_KEY, e);
  } catch {
    /* приватное окно — просто не запомним */
  }
}

export function searchUrl(engine: Engine, q: string): string {
  const text = encodeURIComponent(q);
  return engine === "google" ? `https://www.google.com/search?q=${text}` : `https://yandex.ru/search/?text=${text}`;
}

/** Первая фраза текста без лишнего: длинную жалобу поисковик всё равно обрежет и найдёт хуже. */
export function shortText(text: string | null | undefined, max = 90): string {
  const line = (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean) ?? "";
  let t = line.replace(/\s+/g, " ").replace(/[.,;:!?…\s]+$/, "");
  if (t.length > max) {
    const cut = t.slice(0, max);
    const sp = cut.lastIndexOf(" ");
    t = (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[.,;:!?…\s]+$/, "");
  }
  return t;
}

type DeviceLike = { kind?: string | null; brand?: string | null; model?: string | null } | null | undefined;

/** «ASUS X550CC не включается». Без марки и модели — тип техники, чтобы запрос не был пустым. */
export function webQuery(device: DeviceLike, text: string | null | undefined): string {
  const name = [device?.brand, device?.model].map((s) => (s ?? "").trim()).filter(Boolean);
  const head = name.length ? name : [(device?.kind ?? "").trim()].filter(Boolean);
  return [...head, shortText(text)].filter(Boolean).join(" ").trim();
}

function openSearch(engine: Engine, q: string) {
  window.open(searchUrl(engine, q), "_blank", "noopener,noreferrer");
}

export function WebSearchButton({
  device,
  complaint,
  diagnosis,
}: {
  device: DeviceLike;
  complaint: string | null | undefined;
  diagnosis?: string | null;
}) {
  const [engine, setEngine] = useState<Engine>(savedEngine);
  const [open, setOpen] = useState(false);
  const byComplaint = webQuery(device, complaint);
  const byDiagnosis = diagnosis?.trim() ? webQuery(device, diagnosis) : "";
  const [q, setQ] = useState(byComplaint);
  const box = useRef<HTMLDivElement>(null);

  // Окошко закрывается щелчком мимо и Esc; набранный запрос остаётся до следующего открытия.
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const go = (e: Engine, text = q) => {
    if (!text.trim()) return;
    setEngine(e);
    saveEngine(e);
    openSearch(e, text.trim());
    setOpen(false);
  };

  if (!byComplaint) return null;
  const seg =
    "inline-flex min-h-[36px] items-center gap-1.5 border border-line bg-surface-raised text-[13px] font-semibold text-ink transition-colors hover:border-line-strong hover:bg-surface-hover";

  return (
    <div ref={box} className="relative inline-flex" data-websearch>
      <button
        type="button"
        className={seg + " rounded-l-field px-3"}
        title={`${ENGINE_LABEL[engine]}: ${byComplaint}`}
        onClick={() => openSearch(engine, byComplaint)}
      >
        <IconGlobe className="h-[16px] w-[16px]" />
        Найти в интернете
      </button>
      <button
        type="button"
        aria-label="Как искать"
        aria-expanded={open}
        className={seg + " -ml-px rounded-r-field px-2"}
        onClick={() => {
          if (!open) setQ(byComplaint);
          setOpen(!open);
        }}
      >
        <IconChevronDown className="h-[16px] w-[16px]" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Поиск в интернете"
          className="absolute right-0 top-full z-30 mt-1.5 w-[min(420px,calc(100vw-32px))] rounded-panel border border-line bg-surface p-3 shadow-raised"
        >
          <p className="mb-1.5 text-[12.5px] font-semibold text-ink-muted">Что искать</p>
          <textarea
            value={q}
            rows={2}
            autoFocus
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                go(engine);
              }
            }}
            className="w-full resize-none rounded-field border border-line bg-surface-raised px-3 py-2 text-[14px] text-ink outline-none focus:border-brand"
          />
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setQ(byComplaint)}
              className={"rounded-pill px-2.5 py-1 text-[12.5px] " + (q === byComplaint ? "bg-brand/15 text-brand" : "bg-surface-raised text-ink-soft hover:text-ink")}
            >
              По неисправности
            </button>
            {byDiagnosis && (
              <button
                type="button"
                onClick={() => setQ(byDiagnosis)}
                className={"rounded-pill px-2.5 py-1 text-[12.5px] " + (q === byDiagnosis ? "bg-brand/15 text-brand" : "bg-surface-raised text-ink-soft hover:text-ink")}
              >
                По диагнозу
              </button>
            )}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {(["yandex", "google"] as Engine[]).map((e) => (
              <button
                key={e}
                type="button"
                disabled={!q.trim()}
                onClick={() => go(e)}
                className={
                  "min-h-[40px] rounded-field px-3 text-[13.5px] font-semibold transition-colors disabled:opacity-50 " +
                  (e === engine ? "bg-brand text-white hover:bg-brand-press" : "border border-line bg-surface-raised text-ink hover:bg-surface-hover")
                }
              >
                {ENGINE_LABEL[e]}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
