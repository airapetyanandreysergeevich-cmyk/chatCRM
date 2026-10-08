import { useState, type CSSProperties, type ReactNode } from "react";
import { copyable } from "./CopyMenu";
import { customerColor, nameStyle } from "../lib/customerColor";
import { dueLabel, shortName } from "../lib/format";
import { money } from "../lib/orders";
import { STAGES } from "../lib/stages";
import { DEFAULT_TILE, TILE_LABEL, tileRows, type TileElement, type TileKey, type TileLayout } from "../lib/tile";
import type { BoardCard } from "../lib/workshop";

/**
 * Содержимое карточки заказа на главном экране — по раскладке из
 * «Редактора панелей заказа». Одна и та же отрисовка на доске и в редакторе:
 * предпросмотр, нарисованный отдельно, разошёлся бы с доской в первый же день.
 *
 * Пустое (нет срока, не срочный) на доске не рисуется вовсе. В редакторе
 * пустое показано бледной подсказкой — иначе его не выбрать и не подвинуть.
 */

export interface TileEditing {
  selected: TileKey | null;
  onPick: (k: TileKey) => void;
  /** Перетащили элемент from на элемент to: встать перед ним или после. */
  onMove: (from: TileKey, to: TileKey, before: boolean) => void;
}

const ALIGN = { left: "text-left", center: "text-center", right: "text-right" } as const;
const JUSTIFY = { left: "justify-start", center: "justify-center", right: "justify-end" } as const;

function clampStyle(lines: number): CSSProperties {
  return lines <= 1
    ? { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }
    : { display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", overflow: "hidden", overflowWrap: "anywhere" };
}

/** Значение элемента или null, если у заказа его нет. tone — класс цвета. */
function valueOf(k: TileKey, card: BoardCard): { node: ReactNode; tone?: string; style?: CSSProperties; copy?: object } | null {
  switch (k) {
    case "number":
      return { node: card.number, tone: "font-mono text-ink-soft", copy: copyable("order", card.number) };
    case "urgent":
      return card.isUrgent ? { node: <span className="tag tag-urgent px-2 py-[1px]">срочный</span> } : null;
    case "color": {
      const c = customerColor(card.customer.color);
      return c
        ? {
            node: (
              <span title={`Метка клиента: ${c.label}`} className="inline-block h-[0.75em] w-[0.75em] rounded-full align-middle" style={{ background: c.dot }} />
            ),
          }
        : null;
    }
    case "status": {
      const stage = STAGES.find((s) => s.key === card.status.group);
      return { node: card.status.name, tone: stage?.text ?? "text-ink-muted" };
    }
    case "device": {
      const d = [card.device?.kind, card.device?.brand, card.device?.model].filter(Boolean).join(" ");
      return { node: d || "Техника не указана" };
    }
    case "customer":
      return card.customer.name ? { node: card.customer.name, style: nameStyle(card.customer.color) } : null;
    case "complaint":
      return card.complaint?.trim() ? { node: card.complaint.trim(), tone: "text-ink-soft" } : null;
    case "due": {
      const due = dueLabel(card.dueAt);
      if (!due) return null;
      return {
        node: due.text,
        tone: due.overdue ? "font-semibold text-state-off" : due.soon ? "font-semibold text-state-waiting" : "text-ink-dim",
      };
    }
    case "master":
      return card.master ? { node: shortName(card.master.fullName), tone: "text-ink-dim" } : null;
    case "total":
      return card.total !== undefined && card.total > 0 ? { node: money(card.total), tone: "text-ink" } : null;
  }
}

/** Бледная подсказка в редакторе вместо пустого значения. */
const GHOST: Record<TileKey, string> = {
  number: "Р-0000",
  urgent: "срочный",
  color: "●",
  status: "статус",
  device: "техника",
  customer: "клиент",
  complaint: "неисправность",
  due: "срок",
  master: "мастер",
  total: "сумма",
};

export function TileBody({
  card,
  tile = DEFAULT_TILE,
  editing,
  firstRowPad = false,
}: {
  card: BoardCard;
  tile?: TileLayout;
  editing?: TileEditing;
  /** Место справа в первой строке под «⋯» (телефон: кнопка видна всегда). */
  firstRowPad?: boolean;
}) {
  const [over, setOver] = useState<{ k: TileKey; before: boolean } | null>(null);
  const items = tile.els
    .filter((e) => e.on)
    .map((e) => ({ ...e, value: valueOf(e.k, card) }))
    .filter((e) => editing || e.value);
  const rows = tileRows(items);

  const cell = (e: TileElement & { value: ReturnType<typeof valueOf> }, onlyAuto: boolean) => {
    const v = e.value;
    const ghost = !v;
    const style: CSSProperties = {
      fontSize: `${e.size}px`,
      lineHeight: 1.3,
      fontWeight: e.bold ? (e.k === "number" ? 600 : 700) : 400,
      ...clampStyle(e.lines),
      ...(v?.style ?? {}),
    };
    const width = e.w === "full" ? "w-full" : e.w === "half" ? "min-w-0 flex-1 basis-0" : "min-w-0 max-w-full shrink-0";
    const cls = [width, onlyAuto ? "" : ALIGN[e.align], ghost ? "text-ink-dim/60 italic" : (v?.tone ?? "")].join(" ");
    const props = editing
      ? {
          role: "button" as const,
          tabIndex: 0,
          "aria-label": TILE_LABEL[e.k],
          "data-tile-el": e.k,
          draggable: true,
          title: TILE_LABEL[e.k],
          onClick: (ev: React.MouseEvent) => {
            ev.preventDefault();
            editing.onPick(e.k);
          },
          onKeyDown: (ev: React.KeyboardEvent) => {
            if (ev.key === "Enter" || ev.key === " ") {
              ev.preventDefault();
              editing.onPick(e.k);
            }
          },
          onDragStart: (ev: React.DragEvent) => {
            ev.dataTransfer.effectAllowed = "move";
            ev.dataTransfer.setData("text/x-tile", e.k);
            editing.onPick(e.k);
          },
          onDragOver: (ev: React.DragEvent) => {
            if (!ev.dataTransfer.types.includes("text/x-tile")) return;
            ev.preventDefault();
            const r = (ev.currentTarget as HTMLElement).getBoundingClientRect();
            const before = e.w === "full" ? ev.clientY < r.top + r.height / 2 : ev.clientX < r.left + r.width / 2;
            if (over?.k !== e.k || over.before !== before) setOver({ k: e.k, before });
          },
          onDragLeave: () => setOver((o) => (o?.k === e.k ? null : o)),
          onDrop: (ev: React.DragEvent) => {
            ev.preventDefault();
            const from = ev.dataTransfer.getData("text/x-tile") as TileKey;
            const before = over?.k === e.k ? over.before : true;
            setOver(null);
            if (from && from !== e.k) editing.onMove(from, e.k, before);
          },
        }
      : { ...(v?.copy ?? {}), "data-tile": e.k };
    const sel = editing?.selected === e.k;
    const mark = over?.k === e.k ? (e.w === "full" ? (over.before ? "shadow-[0_-2px_0_0_rgb(var(--brand))]" : "shadow-[0_2px_0_0_rgb(var(--brand))]") : over.before ? "shadow-[-2px_0_0_0_rgb(var(--brand))]" : "shadow-[2px_0_0_0_rgb(var(--brand))]") : "";
    return (
      <span
        key={e.k}
        {...props}
        className={
          cls +
          (editing
            ? " cursor-pointer rounded-[4px] outline-offset-1 hover:outline hover:outline-1 hover:outline-brand/50 " + (sel ? "outline outline-2 outline-brand " : "") + mark
            : "")
        }
        style={style}
      >
        {v ? v.node : GHOST[e.k]}
      </span>
    );
  };

  return (
    <div className="flex flex-col" style={{ gap: `${tile.gap}px` }}>
      {rows.map((row, i) => {
        const onlyAuto = row.every((e) => e.w === "auto");
        return (
          <div
            key={row.map((e) => e.k).join(",")}
            className={
              "flex min-w-0 items-center gap-2 " +
              (onlyAuto ? JUSTIFY[row[0].align] + " flex-wrap " : "") +
              (i === 0 && firstRowPad ? "[@media(hover:none)]:pr-7" : "")
            }
          >
            {row.map((e) => cell(e, onlyAuto))}
          </div>
        );
      })}
    </div>
  );
}
