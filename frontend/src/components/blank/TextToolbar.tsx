import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fieldsOf } from "../../lib/blankData";
import { FONTS, fontCss, type TextEl, type TextStyle, type Target } from "../../lib/blankModel";

/**
 * Панель текста — как в Word: появляется над выбранным текстом.
 *
 *   текст выбран, но не правится → меняет весь блок (шрифт, размер, интервал…);
 *   правится и выделен кусок     → меняет только выделенное;
 *   курсор без выделения         → весь блок (как «стиль абзаца»).
 *
 * Кнопки не забирают фокус у текста (mousedown → preventDefault), а для
 * полей ввода (размер, шрифт) выделение запоминается и возвращается.
 */

export interface EditorApi {
  el: TextEl;
  node: React.RefObject<HTMLDivElement>;
  commit: (html: string) => void;
}

const SIZES = [7, 8, 9, 9.5, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48];
const LEADING = [1, 1.15, 1.25, 1.4, 1.5, 1.75, 2];

const btn = (on = false) =>
  "inline-flex h-8 min-w-[30px] items-center justify-center rounded-[7px] px-1.5 text-[13px] transition-colors " +
  (on ? "bg-[#d6e6f7] text-[#14456f]" : "text-[#1d2433] hover:bg-[#eef1f5]");

const keep = (e: React.MouseEvent) => e.preventDefault();

function Popover({ open, onClose, children, width = 220 }: { open: boolean; onClose: () => void; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div ref={ref} className="absolute left-0 top-[calc(100%+4px)] z-30 rounded-[10px] border border-[#d5dae2] bg-white p-1.5 text-[#1d2433] shadow-xl" style={{ width }}>
      {children}
    </div>
  );
}

export function TextToolbar({
  el,
  target,
  editor,
  anchor,
  onPatch,
  onEditStart,
}: {
  el: TextEl;
  target: Target;
  editor: EditorApi | null;
  anchor: { x: number; y: number; w: number; h: number };
  onPatch: (st: Partial<TextStyle>) => void;
  onEditStart: () => void;
}) {
  const [, setTick] = useState(0);
  const saved = useRef<Range | null>(null);
  const [menu, setMenu] = useState<null | "size" | "leading" | "field" | "font">(null);
  const [q, setQ] = useState("");
  const [sizeText, setSizeText] = useState<string | null>(null);

  // Запоминаем выделение внутри текста — поля ввода панели его сбрасывают.
  useEffect(() => {
    if (!editor) return;
    const on = () => {
      const s = window.getSelection();
      const n = editor.node.current;
      if (s && s.rangeCount && n && n.contains(s.getRangeAt(0).commonAncestorContainer)) saved.current = s.getRangeAt(0).cloneRange();
      setTick((t) => t + 1);
    };
    document.addEventListener("selectionchange", on);
    return () => document.removeEventListener("selectionchange", on);
  }, [editor]);

  const restore = (): Range | null => {
    const n = editor?.node.current;
    if (!n || !saved.current) return null;
    n.focus({ preventScroll: true });
    const s = window.getSelection();
    s?.removeAllRanges();
    s?.addRange(saved.current);
    return saved.current;
  };
  /** Выделен кусок текста — команда к нему; иначе — ко всему блоку. */
  const ranged = () => {
    const r = editor ? restore() : null;
    return r && !r.collapsed ? r : null;
  };
  const done = () => {
    const n = editor?.node.current;
    if (!n) return;
    fixFontTags(n);
    editor!.commit(n.innerHTML);
    const s = window.getSelection();
    if (s && s.rangeCount) saved.current = s.getRangeAt(0).cloneRange();
    setTick((t) => t + 1);
  };
  const exec = (cmd: string, val?: string) => {
    document.execCommand(cmd, false, val);
    done();
  };

  // Что сейчас у выделенного — для подсветки кнопок.
  const state = useMemo(() => {
    const s = window.getSelection();
    const n = editor?.node.current;
    const inside = !!(s && s.rangeCount && n && n.contains(s.getRangeAt(0).commonAncestorContainer));
    if (!inside || !s) return { bold: el.st.bold, italic: el.st.italic, underline: el.st.underline, size: el.st.size, font: el.st.font, align: el.st.align, leading: el.st.leading };
    const node = s.getRangeAt(0).startContainer;
    const elx = (node.nodeType === 1 ? node : node.parentElement) as HTMLElement | null;
    const cs = elx ? getComputedStyle(elx) : null;
    const fam = cs?.fontFamily ?? "";
    const font = FONTS.find((f) => fam.toLowerCase().includes(f.name.toLowerCase()))?.key ?? el.st.font;
    const block = elx?.closest("div,p,li") as HTMLElement | null;
    const lh = block && block !== n ? Number(block.style.lineHeight) || el.st.leading : el.st.leading;
    const q = (c: string) => {
      try {
        return document.queryCommandState(c);
      } catch {
        return false;
      }
    };
    return {
      bold: q("bold"),
      italic: q("italic"),
      underline: q("underline"),
      size: cs ? Math.round((parseFloat(cs.fontSize) * 72 * 10) / 96) / 10 : el.st.size,
      font,
      align: ((block && block !== n && block.style.textAlign) || el.st.align) as TextStyle["align"],
      leading: lh,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el, editor, saved.current]);

  function setSize(pt: number) {
    pt = Math.round(Math.min(72, Math.max(4, pt)) * 10) / 10;
    const r = ranged();
    if (!r) return onPatch({ size: pt });
    document.execCommand("fontSize", false, "7");
    const n = editor!.node.current!;
    n.querySelectorAll('font[size="7"]').forEach((f) => {
      const s = document.createElement("span");
      s.style.fontSize = `${pt}pt`;
      while (f.firstChild) s.appendChild(f.firstChild);
      f.replaceWith(s);
    });
    n.querySelectorAll<HTMLElement>("span").forEach((s) => {
      if (/xxx-large/.test(s.style.fontSize)) s.style.fontSize = `${pt}pt`;
    });
    done();
  }
  function setFont(key: string) {
    const r = ranged();
    if (!r) return onPatch({ font: key as TextStyle["font"] });
    exec("fontName", fontCss(key));
  }
  function setLeading(v: number) {
    const n = editor?.node.current;
    const r = editor ? restore() : null;
    // Курсор без выделения в единственном абзаце — это весь блок.
    if (!n || !r || (r.collapsed && n.childNodes.length <= 1)) return onPatch({ leading: v });
    const blocks = blocksOf(n, r);
    if (!blocks.length) return onPatch({ leading: v });
    blocks.forEach((b) => (b.style.lineHeight = String(v)));
    done();
  }
  function toggle(cmd: "bold" | "italic" | "underline") {
    if (!ranged()) return onPatch({ [cmd]: !el.st[cmd] } as Partial<TextStyle>);
    exec(cmd);
  }
  function align(a: TextStyle["align"]) {
    const n = editor?.node.current;
    const r = editor ? restore() : null;
    if (!n || !r || (r.collapsed && n.children.length <= 1)) return onPatch({ align: a });
    exec({ left: "justifyLeft", center: "justifyCenter", right: "justifyRight", justify: "justifyFull" }[a]);
  }
  function color(c: string, back: boolean) {
    if (!ranged()) return onPatch(back ? { fill: c } : { color: c });
    exec(back ? "hiliteColor" : "foreColor", c);
  }
  function insertField(key: string, label: string) {
    setMenu(null);
    if (!editor) {
      onEditStart();
      // после перехода в правку поле добавится в конец — проще всего так
      setTimeout(() => {
        const n = document.querySelector("[data-text-editor]") as HTMLDivElement | null;
        if (!n) return;
        n.focus();
        const r = document.createRange();
        r.selectNodeContents(n.lastElementChild ?? n);
        r.collapse(false);
        const s = window.getSelection();
        s?.removeAllRanges();
        s?.addRange(r);
        document.execCommand("insertHTML", false, chip(key, label));
        n.dispatchEvent(new Event("input", { bubbles: true }));
      }, 30);
      return;
    }
    const r = restore();
    const n = editor.node.current;
    if (!r || !n) return;
    // Вставляем сами, а не командой браузера: та выносит нередактируемое поле за пределы абзаца.
    let at = r;
    if (r.startContainer === n) {
      // курсор «между абзацами» — в конец абзаца перед ним
      const prev = n.childNodes[r.startOffset - 1] ?? n.firstChild;
      if (prev instanceof HTMLElement && /^(DIV|P|LI)$/.test(prev.tagName)) {
        at = document.createRange();
        at.selectNodeContents(prev);
        at.collapse(false);
      }
    }
    at.deleteContents();
    const t = document.createElement("template");
    t.innerHTML = chip(key, label);
    const last = t.content.lastChild;
    at.insertNode(t.content);
    if (last) {
      const after = document.createRange();
      after.setStartAfter(last);
      after.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(after);
    }
    done();
  }

  // Панель целиком в пределах листа: шире места справа — сдвигается влево.
  const bar = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(anchor.x);
  useLayoutEffect(() => {
    const el = bar.current;
    const room = el?.parentElement?.clientWidth ?? 0;
    if (!el || !room) return;
    setLeft(Math.max(0, Math.min(anchor.x, room - el.offsetWidth)));
  });

  const fields = fieldsOf(target).filter((f) => !q || f.label.toLowerCase().includes(q.toLowerCase()));
  const groups = [...new Set(fields.map((f) => f.group))];
  const fontName = FONTS.find((f) => f.key === state.font)?.name ?? "PT Sans";
  const above = anchor.y > 60;

  return (
    <div
      ref={bar}
      data-text-toolbar
      onMouseDown={(e) => {
        const t = e.target as HTMLElement;
        if (!t.closest("input")) keep(e);
      }}
      className="absolute z-20 flex max-w-full flex-wrap items-center gap-0.5 rounded-[12px] border border-[#d5dae2] bg-white px-1.5 py-1 text-[#1d2433] shadow-[0_8px_28px_rgba(0,0,0,.25)]"
      style={{ left, top: above ? anchor.y - 8 : anchor.y + anchor.h + 8, transform: above ? "translateY(-100%)" : undefined, width: "max-content" }}
    >
      <div className="relative">
        <button type="button" className={btn() + " w-[118px] justify-between border border-[#d5dae2] text-left"} onClick={() => setMenu(menu === "font" ? null : "font")} title="Шрифт" data-tb="font">
          <span className="truncate" style={{ fontFamily: fontCss(state.font) }}>{fontName}</span>
          <span className="text-[10px]">▾</span>
        </button>
        <Popover open={menu === "font"} onClose={() => setMenu(null)} width={190}>
          {FONTS.map((f) => (
            <button key={f.key} type="button" className={btn(f.key === state.font) + " w-full justify-start text-[14px]"} style={{ fontFamily: f.css }} onClick={() => (setMenu(null), setFont(f.key))}>
              {f.name}
            </button>
          ))}
        </Popover>
      </div>
      <div className="relative flex items-center">
        <input
          aria-label="Размер шрифта"
          data-tb="size"
          value={sizeText ?? String(state.size).replace(".", ",")}
          onFocus={() => setSizeText(String(state.size).replace(".", ","))}
          onChange={(e) => setSizeText(e.target.value)}
          onBlur={() => {
            const v = Number((sizeText ?? "").replace(",", "."));
            setSizeText(null);
            if (Number.isFinite(v) && v > 0 && v !== state.size) setSize(v);
          }}
          onKeyDown={(e) => {
            // Enter не должен долететь до текста: фокус вернётся туда и заменит выделенное абзацем.
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            }
            e.stopPropagation();
          }}
          className="h-8 w-[46px] rounded-l-[7px] border border-[#d5dae2] bg-white text-[#1d2433] text-center text-[13px] tabular-nums outline-none focus:border-[#2a7fd0]"
        />
        <button type="button" className="h-8 rounded-r-[7px] border border-l-0 border-[#d5dae2] bg-white text-[#1d2433] px-1 text-[10px] hover:bg-[#eef1f5]" onClick={() => setMenu(menu === "size" ? null : "size")} aria-label="Размеры">
          ▾
        </button>
        <Popover open={menu === "size"} onClose={() => setMenu(null)} width={90}>
          <div className="max-h-[240px] overflow-auto">
            {SIZES.map((s) => (
              <button key={s} type="button" className={btn(s === state.size) + " w-full"} onClick={() => (setMenu(null), setSize(s))}>
                {String(s).replace(".", ",")}
              </button>
            ))}
          </div>
        </Popover>
      </div>
      <button type="button" className={btn()} title="Крупнее" onClick={() => setSize(Math.floor(state.size) + 1)} data-tb="grow">
        A<sup className="text-[9px]">▲</sup>
      </button>
      <button type="button" className={btn()} title="Мельче" onClick={() => setSize(Math.ceil(state.size) - 1)}>
        A<sup className="text-[9px]">▼</sup>
      </button>
      <span className="mx-0.5 h-6 w-px bg-[#e3e7ed]" />
      <button type="button" className={btn(state.bold) + " font-black"} title="Жирный (Ctrl+B)" onClick={() => toggle("bold")} data-tb="bold">
        Ж
      </button>
      <button type="button" className={btn(state.italic) + " italic"} title="Курсив (Ctrl+I)" onClick={() => toggle("italic")} data-tb="italic">
        К
      </button>
      <button type="button" className={btn(state.underline) + " underline"} title="Подчёркнутый (Ctrl+U)" onClick={() => toggle("underline")}>
        Ч
      </button>
      {!editor && (
        <button type="button" className={btn(el.st.upper) + " text-[11px] font-bold"} title="ЗАГЛАВНЫЕ" onClick={() => onPatch({ upper: !el.st.upper })}>
          АА
        </button>
      )}
      <label className={btn() + " relative cursor-pointer"} title="Цвет текста">
        <span className="flex flex-col items-center leading-none">
          <span className="text-[13px] font-semibold">A</span>
          <span className="mt-[1px] h-[3px] w-4 rounded" style={{ background: el.st.color }} />
        </span>
        <input type="color" className="absolute inset-0 cursor-pointer opacity-0" defaultValue={el.st.color} onChange={(e) => color(e.target.value, false)} onMouseDown={(e) => e.stopPropagation()} />
      </label>
      <label className={btn() + " relative cursor-pointer"} title={editor ? "Выделение цветом" : "Заливка блока"}>
        <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M5 19h14M8 15l6-10 4 2-6 10H8z" />
        </svg>
        <input type="color" className="absolute inset-0 cursor-pointer opacity-0" defaultValue="#fff59d" onChange={(e) => color(e.target.value, true)} onMouseDown={(e) => e.stopPropagation()} />
      </label>
      <span className="mx-0.5 h-6 w-px bg-[#e3e7ed]" />
      {(
        [
          ["left", "Влево", "M4 6h16M4 12h10M4 18h13"],
          ["center", "По центру", "M4 6h16M7 12h10M5.5 18h13"],
          ["right", "Вправо", "M4 6h16M10 12h10M7 18h13"],
          ["justify", "По ширине", "M4 6h16M4 12h16M4 18h16"],
        ] as const
      ).map(([v, t, d]) => (
        <button key={v} type="button" className={btn(state.align === v)} title={t} aria-label={t} onClick={() => align(v)} data-tb={`align-${v}`}>
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d={d} />
          </svg>
        </button>
      ))}
      <div className="relative">
        <button type="button" className={btn() + " gap-0.5"} title="Межстрочный интервал" onClick={() => setMenu(menu === "leading" ? null : "leading")} data-tb="leading">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M10 6h10M10 12h10M10 18h10M4 8l2-3 2 3M4 16l2 3 2-3M6 5v14" />
          </svg>
          <span className="text-[11px] tabular-nums">{String(state.leading).replace(".", ",")}</span>
        </button>
        <Popover open={menu === "leading"} onClose={() => setMenu(null)} width={130}>
          <p className="px-1.5 pb-1 text-[11px] text-[#6b7280]">Межстрочный интервал</p>
          {LEADING.map((v) => (
            <button key={v} type="button" className={btn(v === state.leading) + " w-full justify-start"} onClick={() => (setMenu(null), setLeading(v))} data-leading={v}>
              {String(v).replace(".", ",")}
            </button>
          ))}
        </Popover>
      </div>
      {editor && (
        <>
          <button type="button" className={btn()} title="Список" onClick={() => exec("insertUnorderedList")}>
            •≡
          </button>
          <button type="button" className={btn()} title="Нумерованный список" onClick={() => exec("insertOrderedList")}>
            1≡
          </button>
        </>
      )}
      <span className="mx-0.5 h-6 w-px bg-[#e3e7ed]" />
      <div className="relative">
        <button type="button" className={btn() + " gap-1 font-semibold text-[#1f5f9e]"} title="Вставить поле из базы" onClick={() => setMenu(menu === "field" ? null : "field")} data-tb="field">
          {"{ }"} Поле
        </button>
        <Popover open={menu === "field"} onClose={() => setMenu(null)} width={260}>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Найти поле…"
            className="mb-1 h-8 w-full rounded-[7px] border border-[#d5dae2] bg-white px-2 text-[13px] text-[#1d2433] outline-none focus:border-[#2a7fd0]"
          />
          <div className="max-h-[280px] overflow-auto">
            {groups.map((g) => (
              <div key={g}>
                <p className="px-1.5 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#6b7280]">{g}</p>
                {fields
                  .filter((f) => f.group === g)
                  .map((f) => (
                    <button key={f.key} type="button" className={btn() + " w-full justify-between gap-2 text-left"} onClick={() => insertField(f.key, f.label)} data-field-pick={f.key}>
                      <span className="truncate">{f.label}</span>
                      <span className="max-w-[90px] truncate text-[11px] text-[#9aa3af]">{f.sample}</span>
                    </button>
                  ))}
              </div>
            ))}
          </div>
        </Popover>
      </div>
      {editor ? (
        <button type="button" className={btn()} title="Очистить оформление выделенного" onClick={() => exec("removeFormat")}>
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 5h11M11 5l-3 14M4 20l16-16" />
          </svg>
        </button>
      ) : (
        <button type="button" className={btn() + " font-semibold"} title="Писать в этом тексте (двойной щелчок)" onClick={onEditStart} data-tb="edit">
          ✎ Писать
        </button>
      )}
    </div>
  );
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const chip = (key: string, label: string) => `<span class="bf-chip" data-f="${key}" contenteditable="false">${esc(label)}</span>&nbsp;`;

/**
 * Абзацы, которых касается выделение. Строчное содержимое верхнего уровня
 * (бывает после вставки) заворачивается в абзац — интервал задаётся абзацу.
 */
function blocksOf(n: HTMLElement, r: Range): HTMLElement[] {
  const top = (x: Node | null): Node | null => {
    while (x && x.parentNode !== n) x = x.parentNode;
    return x;
  };
  const a = r.startContainer === n ? (n.childNodes[r.startOffset] ?? n.lastChild) : top(r.startContainer);
  const b = r.endContainer === n ? (n.childNodes[Math.max(0, r.endOffset - 1)] ?? n.lastChild) : top(r.endContainer);
  if (!a || !b) return [];
  const run: Node[] = [];
  for (let x: Node | null = a; x; x = x.nextSibling) {
    run.push(x);
    if (x === b) break;
  }
  const out: HTMLElement[] = [];
  let wrap: HTMLDivElement | null = null;
  for (const x of run) {
    if (x instanceof HTMLElement && /^(DIV|P|UL|OL)$/.test(x.tagName)) {
      wrap = null;
      out.push(x);
      continue;
    }
    if (!wrap) {
      wrap = document.createElement("div");
      n.insertBefore(wrap, x);
      out.push(wrap);
    }
    wrap.appendChild(x);
  }
  return out;
}

/** <font face/color> от старых команд браузера — в <span style>: иначе чистка выбросит оформление. */
function fixFontTags(root: HTMLElement) {
  root.querySelectorAll("font").forEach((f) => {
    const s = document.createElement("span");
    const face = f.getAttribute("face");
    const col = f.getAttribute("color");
    if (face) s.style.fontFamily = face;
    if (col) s.style.color = col;
    while (f.firstChild) s.appendChild(f.firstChild);
    f.replaceWith(s);
  });
}
