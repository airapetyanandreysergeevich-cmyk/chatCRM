import { useCallback, useEffect, useState, type FormEvent } from "react";
import { copyable } from "../components/CopyMenu";
import { Modal } from "../components/Modal";
import { IconDownload, IconPlus, IconUpload } from "../components/icons";
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
  SectionLabel,
  Select,
  Spinner,
  StatusGlyph,
} from "../components/ui";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDateTime } from "../lib/format";
import { money } from "../lib/orders";
import { financeApi, type CashKind, type CashList, type CashRegister, type Transaction } from "../lib/workshop";

/**
 * Касса.
 *
 * Ошибочную запись здесь не исправляют и не удаляют — её гасят обратной,
 * и обе остаются в журнале. Это неудобно ровно один раз, зато потом всегда
 * можно объяснить, почему в кассе именно столько.
 *
 * Это учёт для владельца, а не фискальный: онлайн-касса по 54-ФЗ живёт
 * отдельно и по своим правилам.
 */

const PERIODS = [
  { value: 1, label: "Сегодня" },
  { value: 7, label: "Неделя" },
  { value: 30, label: "Месяц" },
  { value: 90, label: "Квартал" },
] as const;

/**
 * Способ оплаты — это вид кассы: наличные падают в кассу «Наличные»,
 * карта — в кассу эквайринга. Поэтому переключатель фильтрует по виду касс,
 * а не по полю движения.
 */
type View = "ALL" | CashKind;
const VIEWS: Array<{ value: View; label: string }> = [
  { value: "ALL", label: "Всё" },
  { value: "CASH", label: "Наличные" },
  { value: "ACQUIRING", label: "Эквайринг" },
  { value: "BANK", label: "Банк" },
];
const VIEW_KEY = "finecrm.finance.view";

function savedView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return VIEWS.some((x) => x.value === v) ? (v as View) : "ALL";
  } catch {
    return "ALL";
  }
}

/** Переключатель-«пилюли»: тот же вид, что у периода ниже. */
function Pills<T extends string | number>({
  items,
  value,
  onChange,
  label,
}: {
  items: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {items.map((p) => (
        <button
          key={p.value}
          type="button"
          role="radio"
          aria-checked={value === p.value}
          onClick={() => onChange(p.value)}
          className={
            "rounded-pill px-3.5 py-1.5 text-[13px] font-semibold transition-colors duration-150 " +
            (value === p.value
              ? "bg-brand text-white"
              : "border border-line bg-surface-raised text-ink-muted hover:text-ink")
          }
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

export default function Finance() {
  const { can } = useAuth();
  const [data, setData] = useState<CashList | null>(null);
  const [registers, setRegisters] = useState<CashRegister[]>([]);
  const [days, setDays] = useState(30);
  const [view, setViewState] = useState<View>(savedView);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<"IN" | "OUT" | null>(null);
  const [reversing, setReversing] = useState<Transaction | null>(null);

  const canManage = can("finance.manage");
  const canPay = can("finance.payment", "finance.manage");

  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* не запомнится — не беда */
    }
  };

  const load = useCallback(async () => {
    try {
      const [list, regs] = await Promise.all([
        financeApi.list({ days, ...(view !== "ALL" ? { kind: view } : {}) }),
        financeApi.registers(),
      ]);
      // Ответ на прежний выбор, пришедший позже нового, не показываем.
      if (list.totals.kind !== undefined && (list.totals.kind ?? "ALL") !== view) return;
      setData(list);
      setRegisters(regs);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить кассу");
    }
  }, [days, view]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Banner tone="error">{error}</Banner>;

  // «Банк» — только там, где такая касса заведена: у большинства её нет, и
  // пустая кнопка лишь путала бы.
  const views = VIEWS.filter((v) => v.value !== "BANK" || view === "BANK" || registers.some((r) => r.kind === "BANK"));
  const shown = view === "ALL" ? registers : registers.filter((r) => r.kind === view);
  const cash = shown.reduce((n, r) => n + r.balance, 0);
  const viewLabel = VIEWS.find((v) => v.value === view)?.label ?? "";
  const scope = view === "ALL" ? "" : ` · ${viewLabel.toLowerCase()}`;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Мастерская"
        title="Касса"
        subtitle="Приход, расход и остаток. Ошибку не стирают — гасят обратной записью."
        actions={
          <div className="flex gap-2">
            {canPay && (
              <Button icon={<IconDownload />} onClick={() => setAdding("IN")}>
                Приход
              </Button>
            )}
            {canManage && (
              <Button variant="secondary" icon={<IconUpload />} onClick={() => setAdding("OUT")}>
                Расход
              </Button>
            )}
          </div>
        }
      />

      <Pills items={views} value={view} onChange={setView} label="Какие деньги показывать" />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="p-4">
          <p className="text-[28px] font-extrabold leading-none tracking-tight">{money(cash)}</p>
          <p className="mt-2.5 text-[14px] font-semibold">
            {view === "ALL" ? "Сейчас в кассах" : view === "CASH" ? "Наличных сейчас" : `Сейчас · ${viewLabel.toLowerCase()}`}
          </p>
          <p className="mt-0.5 text-[12.5px] text-ink-dim">
            {shown.length
              ? shown.map((r) => r.name).join(", ")
              : registers.length
                ? "касс такого вида нет"
                : "касса ещё не заведена"}
          </p>
        </Card>
        {data && (
          <>
            <Card className="p-4">
              <p className="text-[28px] font-extrabold leading-none tracking-tight text-state-done">
                {money(data.totals.todayIncome)}
              </p>
              <p className="mt-2.5 text-[14px] font-semibold">Принято сегодня</p>
              <p className="mt-0.5 text-[12.5px] text-ink-dim">от клиентов и прочее{scope}</p>
            </Card>
            <Card className="p-4">
              <p className="text-[28px] font-extrabold leading-none tracking-tight">
                {money(data.totals.income)}
              </p>
              <p className="mt-2.5 text-[14px] font-semibold">Приход за период</p>
              <p className="mt-0.5 text-[12.5px] text-ink-dim">
                {PERIODS.find((p) => p.value === days)?.label}
                {scope}
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-[28px] font-extrabold leading-none tracking-tight text-state-off">
                {money(data.totals.expense)}
              </p>
              <p className="mt-2.5 text-[14px] font-semibold">Расход за период</p>
              <p className="mt-0.5 text-[12.5px] text-ink-dim">закупки, зарплата, аренда{scope}</p>
            </Card>
          </>
        )}
      </div>

      <Card className="p-3.5">
        <Pills items={PERIODS} value={days} onChange={setDays} label="Период" />
      </Card>

      {!data ? (
        <Spinner />
      ) : data.items.length === 0 ? (
        view !== "ALL" ? (
          <EmptyState icon={<IconPlus />} title={`${viewLabel}: движений за период нет`}>
            Здесь только движения касс вида «{viewLabel}». Всё вместе — на «Всё».
          </EmptyState>
        ) : (
          <EmptyState icon={<IconPlus />} title="Движений за период нет">
            Оплата за выданный ремонт и любой расход мастерской попадают сюда. Начните с первого прихода —
            дальше остаток считается сам.
          </EmptyState>
        )
      ) : (
        <div className="space-y-2.5">
          <SectionLabel>{view === "ALL" ? "Движение денег" : `Движение денег · ${viewLabel.toLowerCase()}`}</SectionLabel>
          <List>
            {data.items.map((t) => {
              const income = t.direction === "IN";
              return (
                <ListRow
                  key={t.id}
                  glyph={
                    <StatusGlyph
                      tone={income ? "done" : "cancelled"}
                      title={income ? "Приход" : "Расход"}
                      icon={income ? <IconDownload /> : <IconUpload />}
                    />
                  }
                  title={
                    <>
                      <span className={income ? "text-state-done" : "text-state-off"}>
                        {income ? "+" : "−"}
                        {money(t.amount)}
                      </span>
                      <span className="truncate text-ink-soft">{t.category?.name ?? "без статьи"}</span>
                      {t.order && (
                        <span {...copyable("order", t.order.number)}>
                          <Badge>заказ {t.order.number}</Badge>
                        </span>
                      )}
                    </>
                  }
                  subtitle={
                    <>
                      {t.register.name}
                      {t.user ? ` · ${t.user.fullName}` : ""}
                      {t.comment ? ` · ${t.comment}` : ""}
                    </>
                  }
                  meta={<span className="whitespace-nowrap lg:w-[132px] lg:text-right">{formatDateTime(t.createdAt)}</span>}
                  actions={
                    canManage && !t.comment?.startsWith("Сторно") ? (
                      <Button
                        variant="ghost"
                        className="min-h-[34px] px-3 text-[13px]"
                        onClick={() => setReversing(t)}
                        title="Погасить обратной записью"
                      >
                        Сторно
                      </Button>
                    ) : undefined
                  }
                />
              );
            })}
          </List>
        </div>
      )}

      {adding && (
        <TxModal
          direction={adding}
          registers={registers}
          onClose={() => setAdding(null)}
          onDone={() => {
            setAdding(null);
            void load();
          }}
        />
      )}

      {reversing && (
        <ReverseModal
          tx={reversing}
          onClose={() => setReversing(null)}
          onDone={() => {
            setReversing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ окна

const CATEGORIES: Record<"IN" | "OUT", string[]> = {
  IN: ["Оплата ремонта", "Предоплата", "Продажа товара", "Прочий приход"],
  OUT: ["Закупка запчастей", "Зарплата", "Аренда", "Хозрасходы", "Прочий расход"],
};

function TxModal({
  direction,
  registers,
  onClose,
  onDone,
}: {
  direction: "IN" | "OUT";
  registers: CashRegister[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState(CATEGORIES[direction][0]);
  const [registerId, setRegisterId] = useState(registers[0]?.id ?? "");
  const [comment, setComment] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await financeApi.add({
        direction,
        amount: Number(amount.replace(",", ".")) || 0,
        ...(registerId ? { cashRegisterId: registerId } : {}),
        category,
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
    <Modal title={direction === "IN" ? "Приход в кассу" : "Расход из кассы"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Banner tone="error">{error.message}</Banner>}

        <Field label="Сумма, ₽" error={error?.field("amount")}>
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" autoFocus />
        </Field>

        <Field label="Статья" hint="Новую статью можно просто вписать — она сохранится">
          <Input value={category} onChange={(e) => setCategory(e.target.value)} list="fin-categories" />
          <datalist id="fin-categories">
            {CATEGORIES[direction].map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Field>

        {registers.length > 1 && (
          <Field label="Касса">
            <Select value={registerId} onChange={(e) => setRegisterId(e.target.value)}>
              {registers.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field label="Комментарий">
          <Input value={comment} onChange={(e) => setComment(e.target.value)} />
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

function ReverseModal({ tx, onClose, onDone }: { tx: Transaction; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await financeApi.reverse(tx.id, reason);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Погасить запись" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Banner>
          Запись на {money(tx.amount)} останется в журнале, рядом появится обратная на ту же сумму. Так видно
          и ошибку, и то, что её исправили.
        </Banner>
        {error && <Banner tone="error">{error.message}</Banner>}
        <Field label="Что исправляем" error={error?.field("reason")}>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Пробили дважды, ошиблись суммой"
            autoFocus
          />
        </Field>
        <div className="flex flex-col gap-2 pt-2 sm:flex-row-reverse">
          <Button type="submit" disabled={busy} className="sm:flex-1">
            {busy ? "Гасим…" : "Погасить"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} className="sm:flex-1">
            Отмена
          </Button>
        </div>
      </form>
    </Modal>
  );
}
