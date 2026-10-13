import { useMemo, useState } from "react";
import { ApiError } from "../lib/api";
import { stockApi, type StockCatalog, type StockCategory } from "../lib/workshop";
import { IconChevronDown, IconDelete, IconEdit, IconPlus } from "./icons";
import { Modal } from "./Modal";
import { Banner, Button, Field, Input, Select } from "./ui";

/**
 * Каталог склада деревом — как папки в Проводнике.
 *
 * Слева «Все позиции», «Без категории» и категории с подкатегориями; число —
 * позиций вместе с подкатегориями. Что раскрыто, помнится на устройстве.
 * У того, кто ведёт склад, при наведении — «+» (подкатегория), карандаш и
 * урна; позицию из списка можно перетащить мышью на категорию.
 */

const OPEN_KEY = "finecrm.stock.open";
const readOpen = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
};
const saveOpen = (s: Set<string>) => {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...s]));
  } catch {
    /* не запомнили — откроется свёрнутым */
  }
};

export interface TreeNode extends StockCategory {
  children: TreeNode[];
  /** Позиций вместе с подкатегориями. */
  total: number;
  depth: number;
}

export function buildTree(cats: StockCategory[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>(cats.map((c) => [c.id, { ...c, children: [], total: c.count, depth: 0 }]));
  const roots: TreeNode[] = [];
  for (const n of nodes.values()) {
    const parent = n.parentId ? nodes.get(n.parentId) : undefined;
    if (parent) parent.children.push(n);
    else roots.push(n);
  }
  const walk = (list: TreeNode[], depth: number): number => {
    let sum = 0;
    list.sort((a, b) => a.name.localeCompare(b.name, "ru"));
    for (const n of list) {
      n.depth = depth;
      n.total = n.count + walk(n.children, depth + 1);
      sum += n.total;
    }
    return sum;
  };
  walk(roots, 0);
  return roots;
}

/** Плоский список для выбора категории: «Матрицы», «  15.6», «    30 pin». */
export function flatTree(roots: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const go = (list: TreeNode[]) => list.forEach((n) => (out.push(n), go(n.children)));
  go(roots);
  return out;
}

export const indent = (n: TreeNode) => "   ".repeat(n.depth) + n.name;

type Dialog =
  | { kind: "create"; parentId: string | null }
  | { kind: "edit"; node: TreeNode }
  | { kind: "delete"; node: TreeNode };

export function StockTree({
  catalog,
  selected,
  onSelect,
  canEdit,
  onChanged,
  onDropItem,
}: {
  catalog: StockCatalog;
  /** "" — все позиции, "none" — без категории, иначе id. */
  selected: string;
  onSelect: (key: string) => void;
  canEdit: boolean;
  onChanged: () => void;
  /** Позицию бросили на категорию (null — «Без категории»). */
  onDropItem?: (itemId: string, categoryId: string | null) => void;
}) {
  const roots = useMemo(() => buildTree(catalog.items), [catalog.items]);
  const [open, setOpen] = useState<Set<string>>(readOpen);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const toggle = (id: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveOpen(next);
      return next;
    });

  const drop = (key: string) =>
    onDropItem
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (!e.dataTransfer.types.includes("text/x-stock-item")) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            if (over !== key) setOver(key);
          },
          onDragLeave: () => setOver((o) => (o === key ? null : o)),
          onDrop: (e: React.DragEvent) => {
            e.preventDefault();
            setOver(null);
            const id = e.dataTransfer.getData("text/x-stock-item");
            if (id) onDropItem(id, key === "none" ? null : key);
          },
        }
      : {};

  const row = (key: string, label: string, count: number, depth: number, node?: TreeNode) => {
    const active = selected === key;
    const hasKids = !!node?.children.length;
    const isOpen = node ? open.has(node.id) : false;
    return (
      <div
        key={key || "all"}
        {...(key ? drop(key) : {})}
        data-cat={key || "all"}
        className={
          "group flex min-h-[38px] items-center rounded-field pr-1 text-[14px] transition-colors " +
          (over === key ? "bg-brand-tint ring-2 ring-brand " : active ? "bg-brand-tint text-brand-ink " : "hover:bg-surface-raised ")
        }
        style={{ paddingLeft: `${4 + depth * 16}px` }}
      >
        <button
          type="button"
          aria-label={hasKids ? (isOpen ? `Свернуть: ${label}` : `Раскрыть: ${label}`) : undefined}
          tabIndex={hasKids ? 0 : -1}
          onClick={() => node && hasKids && toggle(node.id)}
          className={"flex h-7 w-6 shrink-0 items-center justify-center text-ink-dim " + (hasKids ? "hover:text-ink" : "invisible")}
        >
          <IconChevronDown className={"h-4 w-4 transition-transform " + (isOpen ? "" : "-rotate-90")} />
        </button>
        <button
          type="button"
          onClick={() => {
            onSelect(key);
            if (node && hasKids && !isOpen) toggle(node.id);
          }}
          className={"min-w-0 flex-1 truncate py-1.5 text-left " + (active ? "font-semibold" : "")}
          title={label}
        >
          {label}
        </button>
        {node && canEdit && (
          <span className="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:opacity-100">
            <IconBtn label={`Подкатегория в «${label}»`} onClick={() => setDialog({ kind: "create", parentId: node.id })}>
              <IconPlus className="h-[15px] w-[15px]" />
            </IconBtn>
            <IconBtn label={`Изменить «${label}»`} onClick={() => setDialog({ kind: "edit", node })}>
              <IconEdit className="h-[15px] w-[15px]" />
            </IconBtn>
            <IconBtn label={`Удалить «${label}»`} onClick={() => setDialog({ kind: "delete", node })}>
              <IconDelete className="h-[15px] w-[15px]" />
            </IconBtn>
          </span>
        )}
        <span className="ml-1 w-8 shrink-0 text-right font-mono text-[12px] text-ink-dim">{count}</span>
      </div>
    );
  };

  const render = (list: TreeNode[]): React.ReactNode =>
    list.map((n) => (
      <div key={n.id}>
        {row(n.id, n.name, n.total, n.depth, n)}
        {open.has(n.id) && n.children.length > 0 && render(n.children)}
      </div>
    ));

  return (
    <div data-stock-tree>
      <div className="space-y-0.5">
        {row("", "Все позиции", catalog.total, 0)}
        {render(roots)}
        {(catalog.uncategorized > 0 || selected === "none") && row("none", "Без категории", catalog.uncategorized, 0)}
      </div>
      {canEdit && (
        <button
          type="button"
          onClick={() => setDialog({ kind: "create", parentId: null })}
          className="mt-2 flex min-h-[36px] w-full items-center gap-2 rounded-field px-2 text-[13.5px] font-semibold text-brand-ink hover:bg-surface-raised"
        >
          <IconPlus className="h-4 w-4" /> Категория
        </button>
      )}
      {dialog && (
        <CategoryDialog
          dialog={dialog}
          roots={roots}
          onClose={() => setDialog(null)}
          onDone={(selectId) => {
            setDialog(null);
            if (selectId !== undefined) onSelect(selectId);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="flex h-7 w-7 items-center justify-center rounded-field text-ink-dim hover:bg-surface-input hover:text-ink"
    >
      {children}
    </button>
  );
}

function CategoryDialog({
  dialog,
  roots,
  onClose,
  onDone,
}: {
  dialog: Dialog;
  roots: TreeNode[];
  onClose: () => void;
  onDone: (selectId?: string) => void;
}) {
  const flat = flatTree(roots);
  const node = dialog.kind === "create" ? null : dialog.node;
  // Куда можно переносить: не в саму категорию и не в её подкатегории.
  const inside = new Set<string>();
  if (node) {
    const go = (n: TreeNode) => (inside.add(n.id), n.children.forEach(go));
    go(node);
  }
  const [name, setName] = useState(dialog.kind === "edit" ? dialog.node.name : "");
  const [parentId, setParentId] = useState<string>(dialog.kind === "create" ? (dialog.parentId ?? "") : (node?.parentId ?? ""));
  const [moveTo, setMoveTo] = useState<string>(node?.parentId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (dialog.kind === "create") {
        const c = await stockApi.createCategory(name.trim(), parentId || null);
        onDone(c.id);
      } else if (dialog.kind === "edit") {
        await stockApi.updateCategory(dialog.node.id, { name: name.trim(), parentId: parentId || null });
        onDone();
      } else {
        await stockApi.deleteCategory(dialog.node.id, moveTo || null);
        onDone(moveTo || "");
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не получилось");
      setBusy(false);
    }
  }

  const title = dialog.kind === "create" ? "Новая категория" : dialog.kind === "edit" ? "Категория" : `Удалить «${dialog.node.name}»`;
  const parentSelect = (label: string, value: string, set: (v: string) => void, none: string) => (
    <Field label={label}>
      <Select value={value} onChange={(e) => set(e.target.value)}>
        <option value="">{none}</option>
        {flat
          .filter((n) => !inside.has(n.id))
          .map((n) => (
            <option key={n.id} value={n.id}>
              {indent(n)}
            </option>
          ))}
      </Select>
    </Field>
  );

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4" data-category-dialog>
        {dialog.kind === "delete" ? (
          <>
            <p className="text-[14px] leading-relaxed text-ink-soft">
              {dialog.node.total > 0 || dialog.node.children.length > 0
                ? `В категории ${dialog.node.total} поз.${dialog.node.children.length ? ` и подкатегории (${dialog.node.children.length})` : ""}. Куда их перенести?`
                : "Категория пустая — удалится сразу."}
            </p>
            {(dialog.node.total > 0 || dialog.node.children.length > 0) &&
              parentSelect("Перенести в", moveTo, setMoveTo, "Без категории (на верхний уровень)")}
          </>
        ) : (
          <>
            <Field label="Название">
              <Input value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="Матрицы" maxLength={80} />
            </Field>
            {parentSelect("Внутри категории", parentId, setParentId, "— верхний уровень —")}
          </>
        )}
        {error && <Banner tone="error">{error}</Banner>}
        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button
            type="submit"
            variant={dialog.kind === "delete" ? "danger" : "primary"}
            disabled={busy || (dialog.kind !== "delete" && !name.trim())}
            className="sm:flex-1"
          >
            {busy ? "Сохраняем…" : dialog.kind === "delete" ? "Удалить" : dialog.kind === "create" ? "Создать" : "Сохранить"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} className="sm:flex-1">
            Отмена
          </Button>
        </div>
      </form>
    </Modal>
  );
}
