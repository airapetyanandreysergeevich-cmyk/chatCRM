import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { BlankCanvas } from "../components/blank/BlankCanvas";
import { Layers, Props, Tools, type Tool } from "../components/blank/BlankPanels";
import { BlankPages } from "../components/blank/BlankRender";
import { Modal } from "../components/Modal";
import { Banner, Button, Input, PageHeader } from "../components/ui";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fieldLabel, fieldsOf, orderData, saleData, sampleOrder, sampleSale } from "../lib/blankData";
import { DEFAULT_STROKE, fieldsUsed, newId, pageSize, USES_OF, type BlankDesign, type BlankEl, type DocUse, type Target, type TextStyle } from "../lib/blankModel";
import { hline, starterDesign, STARTERS, table, text, type Starter } from "../lib/blankStarters";
import { exportFile, layoutsApi, readFile, USE_LABEL, type Layout, type LayoutMeta } from "../lib/docLayouts";
import { printFormsApi, type PrintForms } from "../lib/printForms";

/**
 * «Настройки → Редактор бланков» (05.11.2026).
 *
 * Слева — инструменты и свойства, справа — сам лист, где всё и делается.
 * Сверху — выбор бланка, новый, импорт и экспорт файлом .finecrm-blank
 * (мастерские обмениваются наработками), «Печатать вместо» — какой
 * стандартный документ бланк заменяет. В углу листа — «Вид печати»: без
 * рамок, с тестовым заказом, листами — как выйдет из принтера.
 *
 * Старые «Бланки» остаются, пока новый редактор не станет полноценным.
 */

interface Current {
  id: string;
  name: string;
  target: Target;
  use: DocUse | null;
  design: BlankDesign;
}

const HISTORY = 80;

/** Картинка → data:URL, крупная — уменьшается (до 1600 точек по большей стороне). */
async function imageFile(f: File): Promise<{ src: string; ratio: number }> {
  const url = URL.createObjectURL(f);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => bad(new Error("Это не картинка"));
      i.src = url;
    });
    const ratio = img.naturalHeight / Math.max(1, img.naturalWidth);
    let side = 1600;
    for (let attempt = 0; attempt < 5; attempt++) {
      const k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.naturalWidth * k));
      c.height = Math.max(1, Math.round(img.naturalHeight * k));
      c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
      const png = f.type === "image/png" || f.type === "image/gif" || f.type === "image/webp";
      const src = c.toDataURL(png ? "image/png" : "image/jpeg", 0.9);
      if (src.length < 1_400_000) return { src, ratio };
      side = Math.round(side * 0.7);
    }
    throw new Error("Картинка слишком большая даже после уменьшения");
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function BlankEditorPage() {
  const { me, can } = useAuth();
  const allowed = can("settings.manage");
  const workshop = me?.kind === "tenant" ? (me.tenant?.name ?? "Мастерская") : me?.kind === "platform" ? (me.impersonating?.name ?? "Мастерская") : "Мастерская";

  const [forms, setForms] = useState<PrintForms | null>(null);
  const [list, setList] = useState<LayoutMeta[] | null>(null);
  const [cur, setCur] = useState<Current | null>(null);
  const [saved, setSaved] = useState<string>(""); // снимок сохранённого: имя + бланк
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [scale, setScale] = useState(1);
  const [grid, setGrid] = useState(false);
  const [dialog, setDialog] = useState<null | "new" | "delete" | { leave: () => void } | { imported: { name: string; target: Target; design: BlankDesign } }>(null);
  const past = useRef<BlankDesign[]>([]);
  const future = useRef<BlankDesign[]>([]);
  const clip = useRef<BlankEl[]>([]);
  const imageFor = useRef<string | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);

  const snapshot = (c: Current | null) => (c ? JSON.stringify([c.name, c.design]) : "");
  const dirty = !!cur && snapshot(cur) !== saved;

  const fail = (e: unknown, d = "Не получилось") => setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : d);

  const open = useCallback(async (id: string) => {
    const l = await layoutsApi.get(id);
    const c: Current = { id: l.id, name: l.name, target: l.target, use: l.use, design: l.design };
    past.current = [];
    future.current = [];
    setCur(c);
    setSaved(snapshot(c));
    setSelected([]);
    setEditing(null);
  }, []);

  const reload = useCallback(async () => {
    const r = await layoutsApi.list();
    setList(r.items);
    return r.items;
  }, []);

  useEffect(() => {
    printFormsApi.get().then(setForms).catch(fail);
    reload()
      .then((items) => items[0] && open(items[0].id))
      .catch(fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Несохранённое — не терять: закрытие вкладки спросит.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const sample = useMemo(() => {
    if (!forms) return null;
    return cur?.target === "sale" ? saleData(sampleSale(), forms, workshop) : orderData(sampleOrder(), forms, workshop, cur?.use ?? "act");
  }, [forms, workshop, cur?.target, cur?.use]);

  // ---------------------------------------------------------------- правки бланка

  const setDesign = useCallback((next: BlankDesign, history = true) => {
    setCur((c) => {
      if (!c) return c;
      if (history) {
        past.current = [...past.current.slice(-HISTORY + 1), c.design];
        future.current = [];
      }
      return { ...c, design: next };
    });
  }, []);
  const undo = () => {
    if (!cur) return;
    const prev = past.current.pop();
    if (!prev) return;
    future.current = [cur.design, ...future.current];
    setEditing(null);
    setCur({ ...cur, design: prev });
  };
  const redo = () => {
    if (!cur) return;
    const [next, ...rest] = future.current;
    if (!next) return;
    future.current = rest;
    past.current = [...past.current, cur.design];
    setCur({ ...cur, design: next });
  };
  const patchEl = (id: string, p: Partial<BlankEl>) => cur && setDesign({ ...cur.design, els: cur.design.els.map((e) => (e.id === id ? ({ ...e, ...p } as BlankEl) : e)) });
  const patchStyle = (ids: string[], p: Partial<TextStyle>) =>
    cur && setDesign({ ...cur.design, els: cur.design.els.map((e) => (ids.includes(e.id) && e.type === "text" ? { ...e, st: { ...e.st, ...p } } : e)) });
  const startEdit = (id: string | null) => {
    if (id && cur) {
      past.current = [...past.current.slice(-HISTORY + 1), cur.design];
      future.current = [];
      setSelected([id]);
    }
    setEditing(id);
  };
  const remove = () => {
    if (!cur || !selected.length) return;
    setDesign({ ...cur.design, els: cur.design.els.filter((e) => !selected.includes(e.id)) });
    setSelected([]);
  };
  const cloneEls = (els: BlankEl[], dx: number, dy: number) => els.map((e) => ({ ...structuredClone(e), id: newId(), x: e.x + dx, y: e.y + dy, locked: undefined }) as BlankEl);
  const duplicate = () => {
    if (!cur || !selected.length) return;
    const copies = cloneEls(cur.design.els.filter((e) => selected.includes(e.id)), 4, 4);
    setDesign({ ...cur.design, els: [...cur.design.els, ...copies] });
    setSelected(copies.map((c) => c.id));
  };
  const copy = () => {
    if (!cur) return;
    clip.current = cur.design.els.filter((e) => selected.includes(e.id)).map((e) => structuredClone(e));
  };
  const paste = () => {
    if (!cur || !clip.current.length) return;
    const copies = cloneEls(clip.current, 5, 5);
    clip.current = copies.map((e) => structuredClone(e));
    setDesign({ ...cur.design, els: [...cur.design.els, ...copies] });
    setSelected(copies.map((c) => c.id));
  };
  const reorder = (dir: "front" | "back") => {
    if (!cur) return;
    const pick = cur.design.els.filter((e) => selected.includes(e.id));
    const rest = cur.design.els.filter((e) => !selected.includes(e.id));
    setDesign({ ...cur.design, els: dir === "front" ? [...rest, ...pick] : [...pick, ...rest] });
  };
  const align = (how: "left" | "hcenter" | "right" | "top" | "vmiddle" | "bottom" | "pageh") => {
    if (!cur) return;
    const sel = cur.design.els.filter((e) => selected.includes(e.id));
    if (!sel.length) return;
    const [pw] = pageSize(cur.design.page);
    const x1 = Math.min(...sel.map((e) => e.x));
    const x2 = Math.max(...sel.map((e) => e.x + e.w));
    const y1 = Math.min(...sel.map((e) => e.y));
    const y2 = Math.max(...sel.map((e) => e.y + e.h));
    const r = (v: number) => Math.round(v * 100) / 100;
    const at = (e: BlankEl): Partial<BlankEl> => {
      switch (how) {
        case "left":
          return { x: x1 };
        case "right":
          return { x: r(x2 - e.w) };
        case "hcenter":
          return { x: r((x1 + x2) / 2 - e.w / 2) };
        case "top":
          return { y: y1 };
        case "bottom":
          return { y: r(y2 - e.h) };
        case "vmiddle":
          return { y: r((y1 + y2) / 2 - e.h / 2) };
        case "pageh":
          return { x: r(e.x + (pw / 2 - (x1 + x2) / 2)) };
      }
    };
    setDesign({ ...cur.design, els: cur.design.els.map((e) => (selected.includes(e.id) ? ({ ...e, ...at(e) } as BlankEl) : e)) });
  };

  function add(tool: Tool, field?: string) {
    if (!cur) return;
    const [pw] = pageSize(cur.design.page);
    const m = cur.design.page.margin;
    const y = Math.round(m + 12 + (cur.design.els.length % 10) * 7);
    let el: BlankEl;
    switch (tool) {
      case "text":
        el = text(m + 10, y, 90, 8, "Новый текст");
        break;
      case "field":
        el = text(m + 10, y, 90, 6, `<span style="color: #555555">${fieldLabel(cur.target, field ?? "number")}:</span> <span data-f="${field ?? "number"}"></span>`);
        break;
      case "hline":
        el = hline(m, y, pw - m * 2);
        break;
      case "vline":
        el = { id: newId(), type: "line", x: m + 60, y, w: 2, h: 40, dir: "v", stroke: { ...DEFAULT_STROKE }, cut: false };
        break;
      case "cut":
        el = hline(m, y, pw - m * 2, 0.3, { cut: true, stroke: { ...DEFAULT_STROKE, style: "dashed", color: "#555555" } });
        break;
      case "rect":
        el = { id: newId(), type: "rect", x: m + 10, y, w: 70, h: 30, stroke: { ...DEFAULT_STROKE }, fill: null, radius: 0 };
        break;
      case "table":
        el = table(m, y, pw - m * 2, cur.target === "sale" ? "items" : "lines");
        break;
      case "barcode":
        el = { id: newId(), type: "code", x: pw - m - 55, y, w: 55, h: 14, kind: "code128", value: "{number}", caption: true };
        break;
      case "qr":
        el = { id: newId(), type: "code", x: pw - m - 28, y, w: 28, h: 28, kind: "qr", value: "{number}", caption: false };
        break;
      case "logo":
        el = { id: newId(), type: "image", x: m, y, w: 35, h: 18, src: "logo", fit: "contain" };
        break;
      case "sign": {
        const ln = hline(m + 10, y + 8, 80);
        const cap = text(m + 10, y + 9, 80, 5, "Подпись", { size: 8, color: "#555555" });
        setDesign({ ...cur.design, els: [...cur.design.els, ln, cap] });
        setSelected([ln.id, cap.id]);
        return;
      }
      case "image":
        imageFor.current = null;
        imageInput.current?.click();
        return;
    }
    setDesign({ ...cur.design, els: [...cur.design.els, el] });
    setSelected([el.id]);
    if (tool === "text") setTimeout(() => startEdit(el.id), 0);
  }

  async function onImage(f: File) {
    if (!cur) return;
    try {
      const { src, ratio } = await imageFile(f);
      if (imageFor.current) {
        patchEl(imageFor.current, { src });
      } else {
        const m = cur.design.page.margin;
        const w = 50;
        const el: BlankEl = { id: newId(), type: "image", x: m + 10, y: m + 20, w, h: Math.round(w * ratio * 100) / 100, src, fit: "contain" };
        setDesign({ ...cur.design, els: [...cur.design.els, el] });
        setSelected([el.id]);
      }
    } catch (e) {
      fail(e);
    }
  }

  // ---------------------------------------------------------------- бланки

  async function save() {
    if (!cur) return;
    setBusy(true);
    setError(null);
    try {
      const r = await layoutsApi.update(cur.id, { name: cur.name.trim() || "Бланк", data: cur.design });
      const c = { ...cur, name: r.name, design: r.design };
      setCur(c);
      setSaved(snapshot(c));
      setNotice("Сохранено");
      setTimeout(() => setNotice(null), 1800);
      await reload();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  // Ctrl+S — сохранить.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyS") {
        e.preventDefault();
        if (dirty && !busy) void save();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const guard = (go: () => void) => (dirty ? setDialog({ leave: go }) : go());

  async function create(name: string, target: Target, design: BlankDesign) {
    setBusy(true);
    setError(null);
    try {
      const r: Layout = await layoutsApi.create({ name, target, data: design });
      await reload();
      await open(r.id);
      setDialog(null);
      setPreview(false);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  async function setUse(use: DocUse | null) {
    if (!cur) return;
    try {
      const r = await layoutsApi.update(cur.id, { use });
      setCur({ ...cur, use: r.use });
      await reload();
      setNotice(use ? `Теперь «${USE_LABEL[use]}» печатается этим бланком` : "Бланк печатается отдельной вкладкой на странице печати");
      setTimeout(() => setNotice(null), 3500);
    } catch (e) {
      fail(e);
    }
  }

  async function del() {
    if (!cur) return;
    setBusy(true);
    try {
      await layoutsApi.remove(cur.id);
      setDialog(null);
      const items = await reload();
      setCur(null);
      setSaved("");
      if (items[0]) await open(items[0].id);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }

  if (!allowed) {
    return (
      <div className="mx-auto max-w-[900px] px-4 py-6">
        <PageHeader title="Редактор бланков" />
        <Banner tone="warning">Бланки настраивает владелец мастерской.</Banner>
      </div>
    );
  }

  const selEls = cur ? cur.design.els.filter((e) => selected.includes(e.id)) : [];
  const unknown = (d: BlankDesign, t: Target) => fieldsUsed(d).filter((k) => !fieldsOf(t).some((f) => f.key === k));

  return (
    <div className="px-4 pb-10 pt-5 sm:px-6" data-blank-editor>
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Link to="/settings" className="text-[13px] font-semibold text-ink-dim hover:text-ink">
          ‹ Настройки
        </Link>
        <h1 className="text-[22px] font-extrabold tracking-tight">Редактор бланков</h1>
        <span className="text-[12.5px] text-ink-dim">
          Новый редактор. Прежние <Link to="/settings/print" className="font-semibold text-brand hover:underline">«Бланки»</Link> работают, пока документ не переведён сюда.
        </span>
      </div>

      {/* Выбор бланка и действия */}
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-card border border-line bg-surface p-2.5" data-blank-bar>
        <select
          value={cur?.id ?? ""}
          onChange={(e) => {
            const id = e.target.value;
            guard(() => void open(id).catch(fail));
          }}
          className="h-10 min-w-0 max-w-full rounded-field border border-line bg-surface-input px-2.5 text-[14px] font-semibold text-ink sm:max-w-[320px]"
          aria-label="Бланк"
          data-blank-select
        >
          {!list?.length && <option value="">Бланков пока нет</option>}
          {(["order", "sale"] as Target[]).map((t) => {
            const items = (list ?? []).filter((l) => l.target === t);
            return items.length ? (
              <optgroup key={t} label={t === "order" ? "Для заказа" : "Для продажи"}>
                {items.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                    {l.use ? ` — вместо: ${USE_LABEL[l.use]}` : ""}
                  </option>
                ))}
              </optgroup>
            ) : null;
          })}
        </select>
        <Button variant="secondary" className="min-h-[40px] px-3" onClick={() => guard(() => setDialog("new"))} data-blank-new>
          + Новый
        </Button>
        <Button variant="ghost" className="min-h-[40px] px-3" onClick={() => importInput.current?.click()} data-blank-import>
          Импорт
        </Button>
        {cur && (
          <Button variant="ghost" className="min-h-[40px] px-3" onClick={() => exportFile(cur.name, cur.target, cur.design)} data-blank-export>
            Экспорт
          </Button>
        )}
        {cur && (
          <>
            <span className="mx-1 hidden h-6 w-px bg-line sm:block" />
            <label className="flex items-center gap-1.5 text-[12.5px] text-ink-dim">
              Печатать вместо
              <select
                value={cur.use ?? ""}
                onChange={(e) => void setUse((e.target.value || null) as DocUse | null)}
                className="h-10 rounded-field border border-line bg-surface-input px-2 text-[13px] text-ink"
                data-blank-use
              >
                <option value="">— отдельной вкладкой</option>
                {USES_OF[cur.target].map((u) => (
                  <option key={u} value={u}>
                    {USE_LABEL[u]}
                  </option>
                ))}
              </select>
            </label>
            <div className="ml-auto flex items-center gap-1.5">
              <Button variant="ghost" className="min-h-[40px] px-2.5" disabled={!past.current.length} onClick={undo} title="Отменить (Ctrl+Z)" aria-label="Отменить">
                ↶
              </Button>
              <Button variant="ghost" className="min-h-[40px] px-2.5" disabled={!future.current.length} onClick={redo} title="Вернуть (Ctrl+Y)" aria-label="Вернуть">
                ↷
              </Button>
              <Button className="min-h-[40px] px-4" disabled={!dirty || busy} onClick={() => void save()} data-blank-save>
                {busy ? "Сохраняем…" : dirty ? "Сохранить" : "Сохранено"}
              </Button>
            </div>
          </>
        )}
      </div>
      <input
        ref={importInput}
        type="file"
        accept=".finecrm-blank,application/json"
        className="hidden"
        data-blank-import-file
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          try {
            const imported = await readFile(f);
            guard(() => setDialog({ imported }));
          } catch (err) {
            fail(err);
          }
        }}
      />
      <input
        ref={imageInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void onImage(f);
        }}
      />

      {error && (
        <div className="mb-3">
          <Banner tone="error">{error}</Banner>
        </div>
      )}
      {notice && (
        <div className="mb-3">
          <Banner>{notice}</Banner>
        </div>
      )}

      {list && !list.length && !cur && (
        <div className="rounded-card border border-dashed border-line-strong p-6 text-center">
          <p className="text-[15px] font-bold">Бланков пока нет</p>
          <p className="mx-auto mt-1 max-w-[520px] text-[13.5px] text-ink-muted">
            Возьмите стандартную квитанцию, акт или чек — они разложатся на элементы, которые можно двигать и править прямо на листе. Или загрузите бланк, которым поделилась другая мастерская.
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button onClick={() => setDialog("new")}>Создать бланк</Button>
            <Button variant="secondary" onClick={() => importInput.current?.click()}>
              Импорт из файла
            </Button>
          </div>
        </div>
      )}

      {cur && sample && (
        <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
          <aside className="min-w-0 space-y-4 lg:sticky lg:top-3 lg:max-h-[calc(100vh-24px)] lg:self-start lg:overflow-auto lg:pr-1">
            <section className="rounded-card border border-line bg-surface p-3">
              <input
                value={cur.name}
                onChange={(e) => setCur({ ...cur, name: e.target.value.slice(0, 60) })}
                aria-label="Название бланка"
                className="mb-3 h-9 w-full rounded-field border border-transparent bg-transparent px-1.5 text-[15px] font-bold text-ink outline-none hover:border-line focus:border-brand"
                data-blank-name
              />
              <Tools target={cur.target} onAdd={add} />
            </section>
            <section className="rounded-card border border-line bg-surface p-3">
              <Props
                design={cur.design}
                target={cur.target}
                selected={selEls}
                onPatch={patchEl}
                onPage={(p) => setDesign({ ...cur.design, page: { ...cur.design.page, ...p } })}
                onDelete={remove}
                onDuplicate={duplicate}
                onOrder={reorder}
                onAlign={align}
                onImage={(id) => {
                  imageFor.current = id;
                  imageInput.current?.click();
                }}
              />
            </section>
            <details className="rounded-card border border-line bg-surface p-3">
              <summary className="cursor-pointer text-[12.5px] font-bold uppercase tracking-[0.08em] text-ink-dim">Элементы на листе · {cur.design.els.length}</summary>
              <div className="mt-2">
                <Layers design={cur.design} target={cur.target} selected={selected} onSelect={setSelected} />
              </div>
            </details>
            <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 text-[12.5px] font-semibold">
              <button type="button" className="text-state-off hover:underline" onClick={() => setDialog("delete")} data-blank-delete>
                Удалить бланк
              </button>
            </div>
          </aside>

          <section className="relative min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <div className="inline-flex items-center rounded-field border border-line bg-surface">
                <button type="button" className="h-9 px-2.5 text-[15px] text-ink-muted hover:text-ink disabled:opacity-40" disabled={preview} onClick={() => setZoom(Math.max(0.3, Math.round((scale - 0.1) * 10) / 10))} aria-label="Мельче">
                  −
                </button>
                <button type="button" className="h-9 min-w-[64px] px-1 text-[12.5px] font-semibold tabular-nums text-ink-muted hover:text-ink" disabled={preview} onClick={() => setZoom("fit")} title="По ширине">
                  {zoom === "fit" ? "По ширине" : `${Math.round(scale * 100)}%`}
                </button>
                <button type="button" className="h-9 px-2.5 text-[15px] text-ink-muted hover:text-ink disabled:opacity-40" disabled={preview} onClick={() => setZoom(Math.min(2, Math.round((scale + 0.1) * 10) / 10))} aria-label="Крупнее">
                  +
                </button>
              </div>
              {!preview && (
                <label className="flex items-center gap-1.5 text-[12.5px] text-ink-dim">
                  <input type="checkbox" checked={grid} onChange={(e) => setGrid(e.target.checked)} />
                  сетка 5 мм
                </label>
              )}
              <span className="hidden text-[12px] text-ink-dim xl:inline">Двойной щелчок — писать · Shift — несколько · Alt — без прилипания · Ctrl+Z, Ctrl+D, Delete</span>
              <button
                type="button"
                onClick={() => {
                  setEditing(null);
                  setPreview(!preview);
                }}
                aria-pressed={preview}
                data-blank-preview
                className={
                  "ml-auto inline-flex h-9 items-center gap-1.5 rounded-field px-3 text-[13px] font-bold shadow-sm transition-colors " +
                  (preview ? "bg-brand text-white" : "border border-line bg-surface text-ink hover:border-line-strong")
                }
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                {preview ? "Вернуться к правке" : "Вид печати"}
              </button>
            </div>
            {preview ? (
              <div className="overflow-auto rounded-card bg-[#6B7280] px-3 py-1" style={{ maxHeight: "calc(100vh - 170px)" }} data-blank-preview-pages>
                <p className="pt-2 text-center text-[12.5px] font-semibold text-white/85">Так выйдет из принтера — с тестовым заказом{cur.target === "sale" ? " (продажа)" : ""}: рамок и подсказок нет, таблица растянута по строкам.</p>
                <ScaledPages width={pageSize(cur.design.page)[0]}>
                  <BlankPages design={cur.design} data={sample} target={cur.target} />
                </ScaledPages>
              </div>
            ) : (
              <BlankCanvas
                design={cur.design}
                target={cur.target}
                sample={sample}
                selected={selected}
                editing={editing}
                zoom={zoom}
                grid={grid}
                onSelect={setSelected}
                onEdit={startEdit}
                onChange={setDesign}
                onUndo={undo}
                onRedo={redo}
                onDelete={remove}
                onDuplicate={duplicate}
                onCopy={copy}
                onPaste={paste}
                onPatchStyle={patchStyle}
                onScale={setScale}
              />
            )}
          </section>
        </div>
      )}

      {dialog === "new" && forms && <NewDialog forms={forms} busy={busy} onClose={() => setDialog(null)} onCreate={(name, target, d) => void create(name, target, d)} />}

      {dialog === "delete" && cur && (
        <Modal title="Удалить бланк?" onClose={() => setDialog(null)}>
          <p className="text-[14px] text-ink-muted">
            «{cur.name}» удалится насовсем.{cur.use ? ` «${USE_LABEL[cur.use]}» снова будет печататься стандартным бланком.` : ""} Если он может пригодиться — сначала «Экспорт» в файл.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Отмена
            </Button>
            <Button variant="danger" disabled={busy} onClick={() => void del()} data-blank-delete-yes>
              Удалить
            </Button>
          </div>
        </Modal>
      )}

      {dialog && typeof dialog === "object" && "leave" in dialog && (
        <Modal title="Сохранить изменения?" onClose={() => setDialog(null)}>
          <p className="text-[14px] text-ink-muted">В бланке «{cur?.name}» есть несохранённые правки.</p>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Остаться
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                const go = dialog.leave;
                setSaved(snapshot(cur));
                setDialog(null);
                go();
              }}
            >
              Не сохранять
            </Button>
            <Button
              onClick={async () => {
                const go = dialog.leave;
                await save();
                setDialog(null);
                go();
              }}
            >
              Сохранить
            </Button>
          </div>
        </Modal>
      )}

      {dialog && typeof dialog === "object" && "imported" in dialog && forms && (
        <ImportDialog
          file={dialog.imported}
          unknown={unknown(dialog.imported.design, dialog.imported.target)}
          sample={dialog.imported.target === "sale" ? saleData(sampleSale(), forms, workshop) : orderData(sampleOrder(), forms, workshop, "act")}
          busy={busy}
          onClose={() => setDialog(null)}
          onCreate={(name) => void create(name, dialog.imported.target, dialog.imported.design)}
        />
      )}
    </div>
  );
}

/** Листы в настоящем размере, уменьшенные под ширину колонки (zoom: перенос строк — как на бумаге). */
function ScaledPages({ width, children, max = 1 }: { width: number; children: React.ReactNode; max?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(800);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const k = Math.min(max, (w - 8) / ((width * 96) / 25.4));
  return (
    <div ref={ref} className="w-full">
      <div style={{ zoom: k }}>{children}</div>
    </div>
  );
}

function NewDialog({ forms, busy, onClose, onCreate }: { forms: PrintForms; busy: boolean; onClose: () => void; onCreate: (name: string, target: Target, d: BlankDesign) => void }) {
  const [starter, setStarter] = useState<Starter>("intake");
  const [name, setName] = useState("");
  const s = STARTERS.find((x) => x.key === starter)!;
  const [target, setTarget] = useState<Target>("order");
  const t = starter === "empty" ? target : s.target;
  return (
    <Modal title="Новый бланк" onClose={onClose}>
      <p className="mb-3 text-[13.5px] text-ink-muted">С чего начать: стандартный документ разложится на элементы — с вашими строками, условиями и подписями из «Бланков».</p>
      <div className="grid gap-1.5 sm:grid-cols-2">
        {STARTERS.map((x) => (
          <button
            key={x.key}
            type="button"
            onClick={() => setStarter(x.key)}
            data-starter={x.key}
            aria-pressed={starter === x.key}
            className={"rounded-field border px-3 py-2.5 text-left text-[14px] font-semibold " + (starter === x.key ? "border-brand bg-brand-tint text-brand-ink" : "border-line bg-surface-raised text-ink-muted hover:text-ink")}
          >
            {x.label}
            <span className="block text-[12px] font-normal text-ink-dim">{x.key === "empty" ? "чистый A4" : x.target === "sale" ? "для продажи со склада" : "для заказа"}</span>
          </button>
        ))}
      </div>
      {starter === "empty" && (
        <div className="mt-3 flex gap-2">
          {(["order", "sale"] as Target[]).map((v) => (
            <button key={v} type="button" onClick={() => setTarget(v)} aria-pressed={target === v} className={"rounded-pill px-3 py-1 text-[13px] font-semibold " + (target === v ? "bg-brand text-white" : "border border-line text-ink-muted")}>
              {v === "order" ? "Для заказа" : "Для продажи"}
            </button>
          ))}
        </div>
      )}
      <label className="mt-4 block text-[13px] font-semibold text-ink-soft">
        Название
        <Input value={name} maxLength={60} placeholder={s.label} onChange={(e) => setName(e.target.value)} className="mt-1" data-new-name />
      </label>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Отмена
        </Button>
        <Button disabled={busy} onClick={() => onCreate(name.trim() || s.label, t, starterDesign(starter, forms))} data-new-create>
          {busy ? "Создаём…" : "Создать"}
        </Button>
      </div>
    </Modal>
  );
}

function ImportDialog({
  file,
  unknown,
  sample,
  busy,
  onClose,
  onCreate,
}: {
  file: { name: string; target: Target; design: BlankDesign };
  unknown: string[];
  sample: ReturnType<typeof orderData>;
  busy: boolean;
  onClose: () => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState(file.name);
  return (
    <Modal title="Бланк из файла" onClose={onClose} wide>
      <p className="mb-2 text-[13.5px] text-ink-muted">
        {file.target === "sale" ? "Для продажи со склада" : "Для заказа"} · элементов: {file.design.els.length}. Загрузится отдельным бланком — ваши бланки не изменятся.
      </p>
      {unknown.length > 0 && (
        <div className="mb-2">
          <Banner tone="warning">
            В бланке есть поля, которых в этой версии FineCRM нет: {unknown.join(", ")}. На их месте будет пусто — обновите программу или замените поля.
          </Banner>
        </div>
      )}
      <div className="max-h-[52vh] overflow-auto rounded-card bg-[#6B7280] p-2" data-import-preview>
        <ScaledPages width={pageSize(file.design.page)[0]} max={0.6}>
          <BlankPages design={file.design} data={sample} target={file.target} />
        </ScaledPages>
      </div>
      <label className="mt-3 block text-[13px] font-semibold text-ink-soft">
        Название
        <Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} className="mt-1" data-import-name />
      </label>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Отмена
        </Button>
        <Button disabled={busy || !name.trim()} onClick={() => onCreate(name.trim())} data-import-create>
          Загрузить бланк
        </Button>
      </div>
    </Modal>
  );
}
