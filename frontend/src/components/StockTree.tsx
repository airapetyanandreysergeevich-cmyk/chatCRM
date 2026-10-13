import { useState } from "react";
import { ApiError } from "../lib/api";
import { stockApi, type StockCategory } from "../lib/workshop";
import { Modal } from "./Modal";
import { Banner, Button, Field, Input, Select } from "./ui";

/**
 * Каталог склада: дерево категорий и всё, что с ним работает, — цвета
 * карточек, окно «новая / переименовать / удалить».
 *
 * Сам склад (pages/Stock.tsx) показывает категории верхнего уровня
 * карточками своего цвета, подкатегории — кнопками внутри карточки.
 */

/** Цвета карточек категорий. Свой цвет не выбран — берётся по порядку. */
export const STOCK_PALETTE = ["#4C8DFF", "#45C08A", "#E8A94B", "#46B9CE", "#B48CF0", "#E06B6B", "#F08CC0", "#8A93A6"];

/**
 * Цвет категории верхнего уровня: свой или из палитры по её id. Не по месту в
 * списке: иначе новая категория «Аксессуары» перекрасила бы все карточки ниже.
 */
export const rootColor = (root: { id: string; color?: string | null }) => {
  if (root.color) return root.color;
  let h = 0;
  for (const ch of root.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return STOCK_PALETTE[h % (STOCK_PALETTE.length - 1)];
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

export type CategoryDialogKind =
  | { kind: "create"; parentId: string | null }
  | { kind: "edit"; node: TreeNode }
  | { kind: "delete"; node: TreeNode };

export function CategoryDialog({
  dialog,
  roots,
  onClose,
  onDone,
}: {
  dialog: CategoryDialogKind;
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
