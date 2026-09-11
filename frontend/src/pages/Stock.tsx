import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { Modal } from "../components/Modal";
import { IconDownload, IconPlus, IconStock, IconUpload } from "../components/icons";
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  List,
  ListRow,
  PageHeader,
  SearchInput,
  Select,
  Spinner,
  StatusGlyph,
} from "../components/ui";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDateTime, plural } from "../lib/format";
import { money } from "../lib/orders";
import { stockApi, type StockItem, type StockList, type StockMovement } from "../lib/workshop";

/**
 * Склад.
 *
 * Экран отвечает на два вопроса: что у нас есть и чего вот-вот не хватит.
 * Поэтому список отсортирован по названию, а не по дате, а позиции ниже
 * минимума видно не цветом строки, а отдельным фильтром — искать глазами
 * красное среди трёхсот строк никто не станет.
 */

const FILTERS = [
  { value: "all", label: "Все" },
  { value: "in", label: "В наличии" },
  { value: "low", label: "Ниже минимума" },
  { value: "zero", label: "Закончились" },
] as const;

export default function Stock() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState<StockList | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [moving, setMoving] = useState<{ item: StockItem; type: MoveType } | null>(null);
  const [history, setHistory] = useState<StockItem | null>(null);

  const filter = params.get("filter") ?? "all";
  const canMove = can("stock.move");
  const canCount = can("stock.inventory");
  const seesCost = can("orders.cost", "finance.view", "stock.move");

  const setFilter = (next: string) => {
    const p = new URLSearchParams(params);
    if (next && next !== "all") p.set("filter", next);
    else p.delete("filter");
    setParams(p, { replace: true });
  };

  const load = useCallback(async () => {
    try {
      setData(await stockApi.list({ search: search.trim(), filter }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить склад");
    }
  }, [search, filter]);

  useEffect(() => {
    const t = setTimeout(() => void load(), search ? 350 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  if (error) return <Banner tone="error">{error}</Banner>;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Мастерская"
        title="Склад"
        subtitle="Остатки запчастей и расходников. Любое изменение остатка — движение с автором и причиной."
        actions={
          canMove && (
            <Button icon={<IconPlus />} onClick={() => setCreating(true)}>
              Новая позиция
            </Button>
          )
        }
      />

      <Card className="p-3.5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <SearchInput
            placeholder="Название, артикул или категория"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="lg:max-w-[380px]"
          />
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                className={
                  "rounded-pill px-3.5 py-1.5 text-[13px] font-semibold transition-colors duration-150 " +
                  (filter === f.value
                    ? "bg-brand text-white"
                    : "border border-line bg-surface-raised text-ink-muted hover:text-ink")
                }
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </Card>

      {!data ? (
        <Spinner />
      ) : (
        <>
          {data.totals.low > 0 && filter !== "low" && (
            <Banner tone="warning">
              {plural(data.totals.low, "позиция", "позиции", "позиций")} ниже минимального остатка.{" "}
              <button onClick={() => setFilter("low")} className="font-bold underline underline-offset-2">
                Показать
              </button>
            </Banner>
          )}

          {data.items.length === 0 ? (
            <EmptyState
              icon={<IconStock />}
              title={search || filter !== "all" ? "Ничего не нашлось" : "На складе пусто"}
              action={
                canMove && !search && filter === "all" ? (
                  <Button icon={<IconPlus />} onClick={() => setCreating(true)}>
                    Завести первую позицию
                  </Button>
                ) : undefined
              }
            >
              {search || filter !== "all"
                ? "Попробуйте изменить запрос или снять фильтр."
                : "Заведите позицию и оприходуйте её — дальше списание в заказ будет уменьшать остаток само."}
            </EmptyState>
          ) : (
            <List>
              {data.items.map((i) => (
                <ListRow
                  key={i.id}
                  glyph={
                    <StatusGlyph
                      tone={i.qty <= 0 ? "cancelled" : i.low ? "waiting" : "done"}
                      title={i.qty <= 0 ? "Закончилось" : i.low ? "Ниже минимума" : "В наличии"}
                      icon={<IconStock />}
                    />
                  }
                  title={
                    <>
                      <span className="truncate">{i.name}</span>
                      {i.sku && <span className="font-mono text-[12.5px] text-ink-dim">{i.sku}</span>}
                      {i.low && i.qty > 0 && <Badge tone="warning">мало</Badge>}
                      {i.qty <= 0 && <Badge tone="danger">нет</Badge>}
                    </>
                  }
                  subtitle={
                    <>
                      {i.category ?? "без категории"}
                      {i.places.length > 0 && (
                        <span className="text-ink-dim">
                          {" · "}
                          {i.places.map((p) => `${p.warehouse}: ${p.qty}`).join(", ")}
                        </span>
                      )}
                      {i.minQty > 0 && <span className="text-ink-dim">{` · минимум ${i.minQty}`}</span>}
                    </>
                  }
                  meta={
                    <>
                      <span
                        className={
                          "whitespace-nowrap font-bold lg:w-[92px] lg:text-right " +
                          (i.qty <= 0 ? "text-state-off" : i.low ? "text-state-waiting" : "text-ink")
                        }
                      >
                        {i.qty} {i.unit}
                      </span>
                      {seesCost && (
                        <span className="whitespace-nowrap lg:w-[110px] lg:text-right">
                          {i.avgCost ? money(Math.round(i.avgCost)) : "—"}
                        </span>
                      )}
                    </>
                  }
                  actions={
                    <div className="flex flex-wrap gap-1.5 sm:min-w-[318px] sm:justify-end">
                      {canMove && (
                        <Button
                          variant="secondary"
                          className="min-h-[34px] px-3 text-[13px]"
                          icon={<IconDownload />}
                          onClick={() => setMoving({ item: i, type: "IN" })}
                          title="Приход на склад"
                        >
                          Приход
                        </Button>
                      )}
                      {(canMove || canCount) && (
                        <Button
                          variant="secondary"
                          className="min-h-[34px] px-3 text-[13px]"
                          icon={<IconUpload />}
                          onClick={() => setMoving({ item: i, type: "WRITE_OFF" })}
                          title="Списание со склада"
                        >
                          Списать
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        className="min-h-[34px] px-3 text-[13px]"
                        onClick={() => setHistory(i)}
                      >
                        История
                      </Button>
                    </div>
                  }
                />
              ))}
            </List>
          )}

          <p className="text-[12.5px] text-ink-dim">
            {plural(data.totals.positions, "позиция", "позиции", "позиций")} в номенклатуре
            {data.totals.value !== undefined && ` · склад на ${money(Math.round(data.totals.value))}`}.
          </p>
        </>
      )}

      {creating && (
        <ItemModal
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            void load();
          }}
        />
      )}

      {moving && (
        <MoveModal
          item={moving.item}
          initial={moving.type}
          canCount={canCount}
          canMove={canMove}
          onClose={() => setMoving(null)}
          onDone={() => {
            setMoving(null);
            void load();
          }}
        />
      )}

      {history && <HistoryModal item={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

// ------------------------------------------------------------------ окна

function ItemModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ name: "", sku: "", category: "", unit: "шт", minQty: "0" });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await stockApi.createItem({
        name: form.name,
        sku: form.sku || undefined,
        category: form.category || undefined,
        unit: form.unit,
        minQty: Number(form.minQty) || 0,
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Новая позиция" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Banner tone="error">{error.message}</Banner>}
        <Field label="Название" error={error?.field("name")} hint="Так, как вы её ищете: «Блок питания 19V 65W»">
          <Input value={form.name} onChange={set("name")} invalid={!!error?.field("name")} autoFocus />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Артикул" error={error?.field("sku")} hint="Необязательно">
            <Input value={form.sku} onChange={set("sku")} />
          </Field>
          <Field label="Категория">
            <Input value={form.category} onChange={set("category")} placeholder="Питание, экраны, крепёж" />
          </Field>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Единица">
            <Input value={form.unit} onChange={set("unit")} />
          </Field>
          <Field label="Минимальный остаток" hint="Ниже этого — подсветим на складе и в сводке">
            <Input value={form.minQty} onChange={set("minQty")} inputMode="decimal" />
          </Field>
        </div>
        <div className="flex flex-col gap-2 pt-2 sm:flex-row-reverse">
          <Button type="submit" disabled={busy} className="sm:flex-1">
            {busy ? "Сохраняем…" : "Завести"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} className="sm:flex-1">
            Отмена
          </Button>
        </div>
      </form>
    </Modal>
  );
}

type MoveType = "IN" | "WRITE_OFF" | "RETURN" | "INVENTORY";

const MOVE_TITLE: Record<MoveType, string> = {
  IN: "Приход",
  WRITE_OFF: "Списание",
  RETURN: "Возврат на склад",
  INVENTORY: "Инвентаризация",
};

function MoveModal({
  item,
  initial,
  canMove,
  canCount,
  onClose,
  onDone,
}: {
  item: StockItem;
  initial: MoveType;
  canMove: boolean;
  canCount: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [type, setType] = useState<MoveType>(initial);
  const [qty, setQty] = useState("1");
  const [price, setPrice] = useState("");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const options: MoveType[] = [
    ...(canMove ? (["IN", "WRITE_OFF", "RETURN"] as MoveType[]) : (["WRITE_OFF"] as MoveType[])),
    ...(canCount ? (["INVENTORY"] as MoveType[]) : []),
  ];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await stockApi.move({
        stockItemId: item.id,
        type,
        qty: Number(qty.replace(",", ".")) || 0,
        ...(price ? { price: Number(price.replace(",", ".")) } : {}),
        ...(comment ? { comment } : {}),
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`${MOVE_TITLE[type]}: ${item.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Banner>
          Сейчас на складе <b>{item.qty} {item.unit}</b>.
          {type === "INVENTORY"
            ? " Укажите, сколько насчитали по факту — разница попадёт в журнал."
            : ""}
        </Banner>
        {error && <Banner tone="error">{error.message}</Banner>}

        {options.length > 1 && (
          <Field label="Что делаем">
            <Select value={type} onChange={(e) => setType(e.target.value as MoveType)}>
              {options.map((o) => (
                <option key={o} value={o}>
                  {MOVE_TITLE[o]}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={type === "INVENTORY" ? `Насчитано, ${item.unit}` : `Количество, ${item.unit}`}
            error={error?.field("qty")}
          >
            <Input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="decimal" autoFocus />
          </Field>
          {(type === "IN" || type === "RETURN") && (
            <Field label="Цена за единицу, ₽" hint="Пересчитает среднюю себестоимость">
              <Input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
            </Field>
          )}
        </div>

        <Field label="Примечание" hint="Останется в журнале движений навсегда">
          <Input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={type === "WRITE_OFF" ? "Брак, бой, пересорт" : "Поставщик, накладная"}
          />
        </Field>

        <div className="flex flex-col gap-2 pt-2 sm:flex-row-reverse">
          <Button type="submit" disabled={busy} className="sm:flex-1">
            {busy ? "Проводим…" : "Провести"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} className="sm:flex-1">
            Отмена
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function HistoryModal({ item, onClose }: { item: StockItem; onClose: () => void }) {
  const [rows, setRows] = useState<StockMovement[] | null>(null);

  useEffect(() => {
    stockApi
      .movements({ stockItemId: item.id, limit: 50 })
      .then(setRows)
      .catch(() => setRows([]));
  }, [item.id]);

  return (
    <Modal title={`История: ${item.name}`} onClose={onClose}>
      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-ink-dim">Движений по этой позиции ещё не было.</p>
      ) : (
        <div className="max-h-[60vh] overflow-y-auto">
          <List>
            {rows.map((m) => (
              <ListRow
                key={m.id}
                title={
                  <>
                    <span className={m.qty < 0 ? "text-state-off" : "text-state-done"}>
                      {m.qty > 0 ? "+" : ""}
                      {m.qty} {m.item.unit}
                    </span>
                    <Badge>{m.typeLabel}</Badge>
                    {m.order && <span className="font-mono text-[12.5px] text-ink-dim">{m.order.number}</span>}
                  </>
                }
                subtitle={
                  <>
                    {m.user?.fullName ?? "система"}
                    {m.comment ? ` · ${m.comment}` : ""}
                  </>
                }
                meta={<span className="whitespace-nowrap">{formatDateTime(m.createdAt)}</span>}
              />
            ))}
          </List>
        </div>
      )}
    </Modal>
  );
}
