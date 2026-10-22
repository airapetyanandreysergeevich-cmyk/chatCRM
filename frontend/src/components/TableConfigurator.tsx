import { useState } from "react";
import { COL, COLS, DEFAULT_VIEW, GROUPS, type ColSpec } from "../lib/tableCols";
import type { ColWidth, TableColPrefs, TableViewPrefs } from "../lib/workshop";
import { Modal } from "./Modal";
import { Banner, Button, Input } from "./ui";
import { IconChevronDown } from "./icons";

/**
 * «Настройка таблицы» (Андрей, 22.10.2026: «чтобы любой мог под себя
 * настроить сводку в виде таблицы»). Слева — все поля по группам: нажали —
 * встало в конец таблицы, нажали ещё раз — убралось. Справа — выбранные
 * столбцы: порядок перетаскиванием (или стрелками — на телефоне и с
 * клавиатуры), ширина, перенос текста. Снизу — «Итого», плотные строки,
 * «Сделать так у всех».
 *
 * Каждое изменение сохраняется сразу — как шестерёнка на доске.
 */

const WIDTHS: Array<[ColWidth, string]> = [
  ["s", "узкий"],
  ["m", "средний"],
  ["l", "широкий"],
];
const FIXED = new Set(["number", "status"]);

export function TableConfigurator({
  view,
  views,
  seesMoney,
  contacts,
  canShare,
  onChange,
  onDelete,
  onShare,
  onClose,
}: {
  view: TableViewPrefs;
  views: TableViewPrefs[];
  seesMoney: boolean;
  contacts: boolean;
  canShare: boolean;
  onChange: (v: TableViewPrefs) => void;
  onDelete: () => void;
  onShare: () => Promise<void>;
  onClose: () => void;
}) {
  const [find, setFind] = useState("");
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [share, setShare] = useState<"idle" | "ask" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  const allowed = (c: ColSpec) => (!c.money || seesMoney) && (!c.contacts || contacts);
  const chosen = new Set(view.cols.map((c) => c.k));
  const set = (cols: TableColPrefs[], extra: Partial<TableViewPrefs> = {}) => onChange({ ...view, ...extra, cols });

  const toggle = (k: string) => {
    if (FIXED.has(k)) return;
    set(chosen.has(k) ? view.cols.filter((c) => c.k !== k) : [...view.cols, { k }]);
  };
  const patch = (k: string, p: Partial<TableColPrefs>) => set(view.cols.map((c) => (c.k === k ? { ...c, ...p } : c)));
  const move = (k: string, to: number) => {
    const from = view.cols.findIndex((c) => c.k === k);
    if (from < 0 || to < 0 || to >= view.cols.length || to === from) return;
    const next = [...view.cols];
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it);
    set(next);
  };

  const q = find.trim().toLowerCase();
  const visible = view.cols.filter((c) => COL.has(c.k) && allowed(COL.get(c.k)!));

  return (
    <Modal title="Настройка таблицы" onClose={onClose} wide="xl">
      <div className="space-y-4" data-table-config>
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-[220px] flex-1">
            <span className="mb-1.5 block text-[12.5px] font-semibold text-ink-soft">Название вида</span>
            <Input value={view.name} maxLength={40} onChange={(e) => onChange({ ...view, name: e.target.value })} data-view-name />
          </label>
          <label className="min-w-[200px] flex-1">
            <span className="mb-1.5 block text-[12.5px] font-semibold text-ink-soft">Найти поле</span>
            <Input value={find} onChange={(e) => setFind(e.target.value)} placeholder="телефон, диагноз, оплачено…" data-field-find />
          </label>
        </div>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          {/* Каталог полей */}
          <div data-field-catalog>
            <p className="text-[12.5px] text-ink-dim">Нажмите на поле — оно встанет в конец таблицы; ещё раз — уберётся.</p>
            {GROUPS.map((g) => {
              const items = COLS.filter((c) => c.group === g && allowed(c) && (!q || c.label.toLowerCase().includes(q)));
              if (!items.length) return null;
              return (
                <div key={g} className="mt-3">
                  <p className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.1em] text-ink-dim">{g}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {items.map((c) => {
                      const on = chosen.has(c.key);
                      return (
                        <button
                          key={c.key}
                          type="button"
                          aria-pressed={on}
                          disabled={FIXED.has(c.key)}
                          onClick={() => toggle(c.key)}
                          data-field={c.key}
                          className={
                            "inline-flex min-h-[32px] items-center gap-1.5 rounded-pill border px-3 text-[12.5px] transition-colors duration-100 disabled:opacity-70 " +
                            (on ? "border-brand/60 bg-brand-tint text-ink" : "border-line bg-surface-input text-ink-soft hover:border-line-strong")
                          }
                        >
                          <span className={on ? "text-state-done" : "font-bold text-brand-ink"}>{on ? "✓" : "+"}</span>
                          {c.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Выбранные столбцы */}
          <div data-field-chosen>
            <p className="text-[12.5px] text-ink-dim">Порядок — перетаскиванием за ⋮⋮ или стрелками. Ширина и перенос — у каждого столбца.</p>
            <div className="mt-2 space-y-1.5">
              {visible.map((c, i) => {
                const spec = COL.get(c.k)!;
                const w = c.w ?? spec.w;
                return (
                  <div
                    key={c.k}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/x-col", c.k);
                      setDrag(c.k);
                    }}
                    onDragEnd={() => {
                      setDrag(null);
                      setOver(null);
                    }}
                    onDragOver={(e) => {
                      if (!drag) return;
                      e.preventDefault();
                      if (over !== c.k) setOver(c.k);
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      const from = e.dataTransfer.getData("text/x-col");
                      if (from) move(from, view.cols.findIndex((x) => x.k === c.k));
                      setDrag(null);
                      setOver(null);
                    }}
                    data-chosen-col={c.k}
                    className={
                      "flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-field border px-2.5 py-1.5 text-[13px] transition-colors duration-100 " +
                      (drag === c.k ? "opacity-50 " : "") +
                      (over === c.k && drag !== c.k ? "border-brand bg-brand-tint" : "border-line bg-surface-input")
                    }
                  >
                    <span className="cursor-grab select-none text-ink-dim" aria-hidden title="Перетащить">
                      ⋮⋮
                    </span>
                    <span className="min-w-[110px] flex-1 truncate font-semibold">{spec.label}</span>
                    <span className="inline-flex overflow-hidden rounded-[8px] border border-line text-[11.5px]" role="radiogroup" aria-label="Ширина">
                      {WIDTHS.map(([k, label]) => (
                        <button
                          key={k}
                          type="button"
                          role="radio"
                          aria-checked={w === k}
                          data-col-width={`${c.k}:${k}`}
                          onClick={() => patch(c.k, { w: k === spec.w ? undefined : k })}
                          className={"px-2 py-0.5 " + (w === k ? "bg-surface-raised font-semibold text-ink" : "text-ink-muted hover:text-ink")}
                        >
                          {label}
                        </button>
                      ))}
                    </span>
                    <button
                      type="button"
                      aria-pressed={!!c.wrap}
                      title="Переносить текст на вторую строку"
                      data-col-wrap={c.k}
                      onClick={() => patch(c.k, { wrap: c.wrap ? undefined : true })}
                      className={"rounded-[8px] border px-2 py-0.5 text-[11.5px] " + (c.wrap ? "border-brand/60 bg-brand-tint text-ink" : "border-line text-ink-muted hover:text-ink")}
                    >
                      2 строки
                    </button>
                    <span className="flex gap-1">
                      <button type="button" aria-label="Левее" disabled={i === 0} onClick={() => move(c.k, view.cols.findIndex((x) => x.k === c.k) - 1)} className="flex h-7 w-7 items-center justify-center rounded-[8px] border border-line text-ink-muted hover:text-ink disabled:opacity-30">
                        <IconChevronDown className="h-3.5 w-3.5 rotate-180" />
                      </button>
                      <button type="button" aria-label="Правее" disabled={i === visible.length - 1} onClick={() => move(c.k, view.cols.findIndex((x) => x.k === c.k) + 1)} className="flex h-7 w-7 items-center justify-center rounded-[8px] border border-line text-ink-muted hover:text-ink disabled:opacity-30">
                        <IconChevronDown className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Убрать «${spec.label}»`}
                        disabled={FIXED.has(c.k)}
                        onClick={() => toggle(c.k)}
                        className="flex h-7 w-7 items-center justify-center rounded-[8px] border border-line text-ink-muted hover:border-state-off hover:text-state-off disabled:opacity-30"
                      >
                        ×
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-x-6 gap-y-2 border-t border-line pt-3 text-[13.5px]">
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={!!view.totals} onChange={(e) => onChange({ ...view, totals: e.target.checked || undefined })} className="h-4 w-4 accent-[rgb(var(--brand))]" data-view-totals />
            Строка «Итого» внизу — суммы денег и число заказов
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input type="checkbox" checked={!!view.dense} onChange={(e) => onChange({ ...view, dense: e.target.checked || undefined })} className="h-4 w-4 accent-[rgb(var(--brand))]" />
            Плотные строки
          </label>
        </div>

        {share === "ask" && (
          <Banner tone="warning">
            Виды таблицы ({views.map((v) => `«${v.name}»`).join(", ")}) станут у всех сотрудников такими же, их собственные виды
            сбросятся.
          </Banner>
        )}
        {share === "done" && <Banner>Готово: у всех сотрудников теперь такие же виды таблицы.</Banner>}
        {error && <Banner tone="error">{error}</Banner>}

        <div className="flex flex-wrap gap-2">
          <Button onClick={onClose} data-config-done>
            Готово
          </Button>
          <Button variant="secondary" onClick={() => set(DEFAULT_VIEW.cols.map((c) => ({ ...c })), { sort: undefined, totals: undefined, dense: undefined })}>
            Сбросить столбцы
          </Button>
          {canShare &&
            (share === "ask" ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setShare("busy");
                  setError(null);
                  onShare()
                    .then(() => setShare("done"))
                    .catch(() => {
                      setShare("idle");
                      setError("Не удалось сделать у всех");
                    });
                }}
                data-config-share-confirm
              >
                Да, сделать у всех
              </Button>
            ) : (
              <Button variant="secondary" disabled={share === "busy"} onClick={() => setShare("ask")} data-config-share>
                Сделать так у всех
              </Button>
            ))}
          {views.length > 1 && (
            <Button variant="danger" onClick={onDelete} data-view-delete>
              Удалить вид
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
