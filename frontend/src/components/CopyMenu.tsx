import { useEffect, useRef, useState } from "react";

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

export type CopyKind = "phone" | "name" | "order" | "serial";

const WHAT: Record<CopyKind, string> = {
  phone: "телефон",
  name: "имя",
  order: "номер заказа",
  serial: "серийный номер",
};

/** Пометка для элемента: по правому щелчку на нём появится «Копировать …». */
export function copyable(kind: CopyKind, value: string | null | undefined) {
  const text = (value ?? "").trim();
  return text ? { "data-copy": text, "data-copy-kind": kind } : {};
}

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
}

export function CopyMenu() {
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
      setOpen({ x: e.clientX, y: e.clientY, text, kind });
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

  async function run() {
    if (!open) return;
    const ok = await copyText(open.text);
    setOpen(null);
    setToast(ok ? `Скопировано: ${open.text}` : "Не удалось скопировать — выделите и нажмите Ctrl+C");
  }

  // Меню не должно уезжать за край окна: у правого и нижнего края — открываем влево и вверх.
  const W = 250;
  const H = 48;
  // Чуть ниже и правее курсора, как системное меню, — чтобы не закрывать то, что копируем.
  const left = open ? Math.min(open.x + 2, window.innerWidth - W - 8) : 0;
  const top = open ? (open.y + H + 12 > window.innerHeight ? open.y - H - 4 : open.y + 6) : 0;

  return (
    <>
      {open && (
        <div
          ref={menu}
          role="menu"
          className="fixed z-[100] min-w-[190px] max-w-[250px] overflow-hidden rounded-field border border-line bg-surface-raised py-1 shadow-raised"
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
            <span className="min-w-0 truncate">Копировать {WHAT[open.kind]}</span>
          </button>
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
