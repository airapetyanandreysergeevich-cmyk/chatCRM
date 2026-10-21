import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { searchUrl, type Engine } from "./WebSearch";

/**
 * «Копировать» по правой кнопке — одно меню на всё приложение.
 *
 * Телефон, имя клиента, номер заказа и серийный номер попадаются на каждом
 * экране, и переписывать их руками в мессенджер или в поиск поставщика —
 * самое частое мелкое мучение у стойки. Поэтому любое такое место помечается
 * одной строкой — `{...copyable("phone", c.phone)}`, — а меню и копирование
 * живут здесь, один раз. Новое место с телефоном не требует нового кода, и
 * «работает везде» не расходится со временем.
 *
 * На телефоне меню не показываем: правой кнопки там нет, а долгое нажатие
 * система уже занимает своим меню (позвонить, скопировать), и подменять его
 * хуже, чем оставить.
 */

export type CopyKind = "phone" | "name" | "order" | "serial" | "device" | "outsource" | "text";

const WHAT: Record<CopyKind, string> = {
  phone: "телефон",
  name: "имя",
  order: "номер заказа",
  serial: "серийный номер",
  device: "марку и модель",
  outsource: "номер аутсорса",
  text: "текст",
};

/**
 * У техники и серийного номера в меню ещё поиск: по своей базе заказов и в
 * интернете (Андрей, 13.10.2026). Остальное — только «Копировать».
 */
const SEARCHABLE: ReadonlySet<CopyKind> = new Set<CopyKind>(["device", "serial"]);

/** Что копировать и искать у техники: марка и модель; нет их — тип («Ноутбук»). */
export function deviceText(d: { kind?: string | null; brand?: string | null; model?: string | null } | null | undefined): string {
  const bm = [d?.brand, d?.model].map((s) => (s ?? "").trim()).filter(Boolean).join(" ");
  return bm || (d?.kind ?? "").trim();
}

/**
 * Пометка для элемента: по правому щелчку на нём появится «Копировать …».
 * what — как назвать в меню, если не подходит название вида («неисправность»).
 */
export function copyable(kind: CopyKind, value: string | null | undefined, what?: string) {
  const text = (value ?? "").trim();
  if (!text) return {};
  return what ? { "data-copy": text, "data-copy-kind": kind, "data-copy-what": what } : { "data-copy": text, "data-copy-kind": kind };
}

/**
 * Строка целиком (заказ в таблице, плитка на доске): в меню любого поля под
 * ней — ещё и остальное из строки и «всё строкой». Пары «что — значение».
 */
export function copyRow(items: Array<[string, string | null | undefined]>) {
  const clean = items.map(([w, v]) => [w, (v ?? "").trim()] as [string, string]).filter(([, v]) => v);
  return clean.length ? { "data-copy-row": JSON.stringify(clean) } : {};
}

/** Открыть меню заказа там, где щёлкнули (пункт «Меню заказа…» в меню копирования). */
export const ORDER_MENU_EVENT = "finecrm:order-menu";

/**
 * Положить текст в буфер обмена.
 *
 * Обычный способ браузер разрешает только на защищённых страницах — на
 * https и на самом компьютере. А сотрудники заходят в Основу по адресу
 * локальной сети, http://192.168.1.40:7373, и там его просто нет. Для такого
 * случая — старый способ через невидимое поле: он работает везде, где есть
 * нажатие человека.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* ниже — запасной способ */
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

interface Open {
  x: number;
  y: number;
  text: string;
  kind: CopyKind;
  what: string;
  row: Array<[string, string]>;
  /** id заказа, если поле лежит внутри заказа с меню (useOrderMenu). */
  order: string | null;
}

export function CopyMenu() {
  const navigate = useNavigate();
  const [open, setOpen] = useState<Open | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const lastPointer = useRef<string>("mouse");

  useEffect(() => {
    // Каким пальцем или мышью нажимали последний раз: долгое нажатие на
    // экране тоже присылает contextmenu, а его мы не трогаем.
    const pointer = (e: PointerEvent) => (lastPointer.current = e.pointerType);
    const context = (e: MouseEvent) => {
      if (lastPointer.current === "touch" || lastPointer.current === "pen") return;
      const el = (e.target as Element | null)?.closest?.("[data-copy]") as HTMLElement | null;
      if (!el) return;
      const text = el.dataset.copy ?? "";
      const kind = (el.dataset.copyKind ?? "name") as CopyKind;
      if (!text) return;
      e.preventDefault();
      e.stopPropagation();
      let row: Array<[string, string]> = [];
      try {
        const raw = (el.closest("[data-copy-row]") as HTMLElement | null)?.dataset.copyRow;
        if (raw) row = (JSON.parse(raw) as Array<[string, string]>).filter((x) => Array.isArray(x) && typeof x[1] === "string");
      } catch {
        row = [];
      }
      const order = (el.closest("[data-order-menu]") as HTMLElement | null)?.dataset.orderMenu ?? null;
      setOpen({ x: e.clientX, y: e.clientY, text, kind, what: el.dataset.copyWhat || WHAT[kind], row, order });
    };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("contextmenu", context);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("contextmenu", context);
    };
  }, []);

  // Меню закрывается щелчком мимо, Esc, прокруткой и сменой окна — как любое меню.
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e.type === "mousedown" && menu.current?.contains(e.target as Node)) return;
      setOpen(null);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [open]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1600);
    return () => clearTimeout(t);
  }, [toast]);

  async function run(text = open?.text ?? "") {
    if (!open) return;
    const ok = await copyText(text);
    setOpen(null);
    setToast(ok ? `Скопировано: ${text}` : "Не удалось скопировать — выделите и нажмите Ctrl+C");
  }

  function orderMenu() {
    if (!open?.order) return;
    const { x, y, order } = open;
    setOpen(null);
    document.dispatchEvent(new CustomEvent(ORDER_MENU_EVENT, { detail: { id: order, x, y } }));
  }

  /** Заказы с такой же техникой: поиск по словам ищет во всех стадиях, выданные тоже. */
  function inBase() {
    if (!open) return;
    const q = open.text;
    setOpen(null);
    navigate(`/orders?search=${encodeURIComponent(q)}`);
  }

  /** В программе FineCRM ссылка уходит во внешний браузер (main.js), на телефоне — в браузер телефона. */
  function web(engine: Engine) {
    if (!open) return;
    window.open(searchUrl(engine, open.text), "_blank", "noopener,noreferrer");
    setOpen(null);
  }

  // Меню не должно уезжать за край окна: у правого и нижнего края — открываем влево и вверх.
  const W = 290;
  // Остальное из строки — без того, что уже скопирует первый пункт.
  const others = open ? open.row.filter(([, v]) => v !== open.text) : [];
  const whole = open && open.row.length > 1 ? open.row.map(([, v]) => v).join(", ") : null;
  const H =
    48 +
    (open && SEARCHABLE.has(open.kind) ? 9 + 3 * 42 : 0) +
    (others.length || whole ? 9 + (others.length + (whole ? 1 : 0)) * 42 : 0) +
    (open?.order ? 9 + 42 : 0);
  // Чуть ниже и правее курсора, как системное меню, — чтобы не закрывать то, что копируем.
  const left = open ? Math.min(open.x + 2, window.innerWidth - W - 8) : 0;
  const top = open ? (open.y + H + 12 > window.innerHeight ? open.y - H - 4 : open.y + 6) : 0;

  return (
    <>
      {open && (
        <div
          ref={menu}
          role="menu"
          className="fixed z-[100] min-w-[190px] max-w-[290px] overflow-hidden rounded-field border border-line bg-surface-raised py-1 shadow-raised"
          style={{ left, top }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            type="button"
            role="menuitem"
            autoFocus
            onClick={() => void run()}
            className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[14px] text-ink transition-colors duration-100 hover:bg-surface-input focus:bg-surface-input focus:outline-none"
          >
            <CopyIcon />
            <span className="min-w-0 truncate">Копировать {open.what}</span>
          </button>
          {(others.length > 0 || whole) && (
            <>
              <div className="my-1 h-px bg-line" />
              {others.map(([w, v]) => (
                <MenuButton key={w} onClick={() => void run(v)} icon={<CopyIcon />}>
                  Копировать {w}
                </MenuButton>
              ))}
              {whole && (
                <MenuButton onClick={() => void run(whole)} icon={<CopyIcon />}>
                  Копировать всё строкой
                </MenuButton>
              )}
            </>
          )}
          {SEARCHABLE.has(open.kind) && (
            <>
              <div className="my-1 h-px bg-line" />
              <MenuButton onClick={inBase} icon={<BaseIcon />}>
                Найти в базе
              </MenuButton>
              <MenuButton onClick={() => web("google")} icon={<WebIcon />}>
                Искать в Google
              </MenuButton>
              <MenuButton onClick={() => web("yandex")} icon={<WebIcon />}>
                Искать в Яндексе
              </MenuButton>
            </>
          )}
          {open.order && (
            <>
              <div className="my-1 h-px bg-line" />
              <MenuButton onClick={orderMenu} icon={<MoreIcon />}>
                Меню заказа…
              </MenuButton>
            </>
          )}
        </div>
      )}
      {toast && (
        <div
          role="status"
          className="pointer-events-none fixed bottom-24 left-1/2 sm:bottom-6 z-[100] max-w-[90vw] -translate-x-1/2 truncate rounded-pill bg-ink px-4 py-2 text-[13.5px] font-semibold text-surface shadow-raised"
        >
          {toast}
        </div>
      )}
    </>
  );
}

function MenuButton({ onClick, icon, children }: { onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left text-[14px] text-ink transition-colors duration-100 hover:bg-surface-input focus:bg-surface-input focus:outline-none"
    >
      {icon}
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
}

function BaseIcon() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className="h-[16px] w-[16px] shrink-0 text-ink-dim" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="8.5" cy="8.5" r="5" />
      <path d="m12.5 12.5 4 4" />
    </svg>
  );
}

function WebIcon() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className="h-[16px] w-[16px] shrink-0 text-ink-dim" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="10" cy="10" r="7" />
      <path d="M3 10h14M10 3c2 2.2 2.8 4.5 2.8 7s-.8 4.8-2.8 7c-2-2.2-2.8-4.5-2.8-7S8 5.2 10 3Z" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className="h-[16px] w-[16px] shrink-0 text-ink-dim" fill="currentColor">
      <circle cx="4.5" cy="10" r="1.6" />
      <circle cx="10" cy="10" r="1.6" />
      <circle cx="15.5" cy="10" r="1.6" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 20 20"
      className="h-[16px] w-[16px] shrink-0 text-ink-dim"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
    </svg>
  );
}
