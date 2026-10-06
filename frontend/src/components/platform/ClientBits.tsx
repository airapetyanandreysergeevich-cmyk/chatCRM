import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError } from "../../lib/api";
import { customerColor } from "../../lib/customerColor";
import { formatDate, formatDateTime } from "../../lib/format";
import { remember } from "../../lib/listPrefs";
import {
  activityOf,
  bytes,
  isoDate,
  platformApi,
  rub,
  seenLabel,
  type Category,
  type PayState,
  type Payment,
} from "../../lib/platformApi";
import { IconCloud, IconComputer, IconMore } from "../icons";
import { Modal } from "../Modal";
import { Banner, Button, Checkbox, Field, Input, Select } from "../ui";

/**
 * Общие куски панели собственника: метки категории, оплаты и активности,
 * полоска занятого места и окно «Условия и оплата» — одно для облачных и
 * локальных мастерских.
 */

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");

// ---------------------------------------------------------------- вид клиента

/**
 * Облачная — синий значок облака, локальная — бирюзовый компьютер. Различие
 * видно с первого взгляда и в общем списке на обзоре, и в своих разделах.
 */
export function KindMark({ kind, online, size = "md" }: { kind: "cloud" | "local"; online?: boolean; size?: "sm" | "md" }) {
  const Icon = kind === "cloud" ? IconCloud : IconComputer;
  return (
    <span
      title={kind === "cloud" ? "Облачная мастерская" : "Локальная мастерская"}
      className={cx(
        "relative flex shrink-0 items-center justify-center rounded-card",
        size === "md" ? "h-10 w-10 [&>svg]:h-[21px] [&>svg]:w-[21px]" : "h-7 w-7 [&>svg]:h-[16px] [&>svg]:w-[16px]",
        kind === "cloud" ? "bg-brand/10 text-brand-ink" : "bg-state-progress/10 text-state-progress"
      )}
    >
      <Icon />
      {online !== undefined && (
        <span
          className={cx(
            "absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-surface",
            size === "md" ? "h-3.5 w-3.5" : "h-3 w-3",
            online ? "bg-state-done" : "bg-ink-dim/50"
          )}
        />
      )}
    </span>
  );
}

// ---------------------------------------------------------------- категория

export function CategoryChip({ category }: { category: Pick<Category, "name" | "color"> | null | undefined }) {
  if (!category) return <span className="text-[12.5px] text-ink-dim">без категории</span>;
  const c = customerColor(category.color);
  return (
    <span className="inline-flex max-w-[160px] items-center gap-1.5 rounded-pill border border-line px-2 py-0.5 text-[12px] font-semibold text-ink-soft">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: c?.dot ?? "rgb(var(--ink-dim))" }} />
      <span className="truncate">{category.name}</span>
    </span>
  );
}

// ---------------------------------------------------------------- оплата

const PAY_TONE: Record<PayState, string> = {
  paid: "text-state-done",
  soon: "text-state-waiting",
  overdue: "text-state-off",
  none: "text-ink-dim",
  free: "text-ink-dim",
};

/** 20.11.26 — коротко, чтобы строка списка не разъезжалась. */
const dmy = (v: string | null) => (v ? new Date(v).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" }) : "—");

export function PayText({ pay, paidUntil, price }: { pay: PayState; paidUntil: string | null; price: number }) {
  const text =
    pay === "free"
      ? "бесплатно"
      : pay === "none"
        ? `${rub(price)} · срок не задан`
        : pay === "overdue"
          ? `просрочено с ${dmy(paidUntil)}`
          : `оплачено до ${dmy(paidUntil)}`;
  return (
    <span className={cx("whitespace-nowrap text-[12.5px] font-semibold", PAY_TONE[pay])} title={price ? `${rub(price)} в месяц` : undefined}>
      {text}
    </span>
  );
}

// ---------------------------------------------------------------- активность

const SEEN_TONE = {
  online: "bg-state-done",
  day: "bg-brand",
  week: "bg-brand/50",
  month: "bg-ink-dim/60",
  long: "bg-ink-dim/30",
  never: "bg-transparent border border-dashed border-ink-dim",
} as const;

export function Seen({ online, at }: { online: boolean; at: string | null }) {
  const a = activityOf(online, at);
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12.5px]" title={at ? `Последний раз: ${formatDateTime(at)}` : undefined}>
      <span className={cx("h-2 w-2 shrink-0 rounded-full", SEEN_TONE[a])} />
      <span className={a === "online" ? "font-semibold text-state-done" : "text-ink-muted"}>{seenLabel(online, at)}</span>
    </span>
  );
}

// ---------------------------------------------------------------- место

export function UsageBar({ used, limit, label }: { used: number; limit: number; label?: ReactNode }) {
  const share = limit > 0 ? used / limit : 0;
  const tone = share >= 1 ? "bg-state-off" : share >= 0.9 ? "bg-state-waiting" : "bg-brand";
  return (
    <span className="flex min-w-[120px] flex-col gap-1">
      <span className="flex justify-between gap-2 whitespace-nowrap text-[12px] text-ink-muted">
        <span>{label ?? bytes(used)}</span>
        <span className="text-ink-dim">{limit > 0 ? `из ${bytes(limit)}` : "без лимита"}</span>
      </span>
      <span className="h-1.5 overflow-hidden rounded-full bg-surface-raised">
        <span className={cx("block h-full rounded-full", tone)} style={{ width: `${Math.min(100, Math.max(limit > 0 && used > 0 ? 2 : 0, share * 100))}%` }} />
      </span>
    </span>
  );
}

// ---------------------------------------------------------------- фильтры

export function Chips<T extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: ReadonlyArray<{ id: T; label: string; n?: number }>;
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1.5">
      {items.map((p) => (
        <button
          key={p.id}
          type="button"
          role="radio"
          aria-checked={value === p.id}
          onClick={() => onChange(p.id)}
          className={cx(
            "rounded-pill px-3 py-1.5 text-[13px] font-semibold transition-colors duration-150",
            value === p.id ? "bg-brand text-white" : "border border-line bg-surface-raised text-ink-muted hover:text-ink"
          )}
        >
          {p.label}
          {p.n !== undefined && <span className={cx("ml-1.5 tabular-nums", value === p.id ? "text-white/80" : "text-ink-dim")}>{p.n}</span>}
        </button>
      ))}
    </div>
  );
}

/** Выпадающий фильтр с подписью — в одну строку с сортировкой. */
export function FilterSelect({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="relative inline-flex min-h-[46px] w-full items-center rounded-field border border-line bg-surface-input sm:w-auto">
      <span className="pointer-events-none pl-3.5 text-[13px] font-semibold text-ink-dim">{label}:</span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-h-[44px] min-w-0 flex-1 cursor-pointer appearance-none bg-transparent pl-1.5 pr-8 text-[14.5px] font-semibold text-ink outline-none"
      >
        {children}
      </select>
      <svg viewBox="0 0 24 24" className="pointer-events-none absolute right-3 h-4 w-4 text-ink-dim" fill="none" stroke="currentColor" strokeWidth={2}>
        <path d="m6 9 6 6 6-6" />
      </svg>
    </label>
  );
}

// ---------------------------------------------------------------- условия и оплата

export interface ClientTarget {
  kind: "cloud" | "local";
  id: string;
  name: string;
  categoryId: string | null;
  ownPrice: number | null;
  price: number;
  paidUntil: string | null;
  /** Только у облачной. */
  limits?: { maxUsers: number; maxStorageMb: number; plateOcr: boolean; customLimits: boolean };
}

const MONTHS = [1, 3, 6, 12];

/**
 * Окно клиента: категория, своя цена, лимиты и оплата.
 *
 * Оплата отмечается вручную: «получил 1 500 ₽ за месяц» — и срок сам
 * продлевается от прежнего, если тот ещё не кончился, иначе от сегодня.
 * Ошибочную оплату можно убрать — срок вернётся к прежнему.
 */
export function ClientModal({
  target,
  categories,
  canEdit,
  onClose,
  onChanged,
}: {
  target: ClientTarget;
  categories: Category[];
  canEdit: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [categoryId, setCategoryId] = useState(target.categoryId ?? "");
  const [ownPrice, setOwnPrice] = useState(target.ownPrice === null ? "" : String(target.ownPrice));
  const [paidUntil, setPaidUntil] = useState(isoDate(target.paidUntil));
  // Место — в гигабайтах, как о нём думают; сравниваем строками, чтобы
  // округление 5000 МБ → «4.9 ГБ» не выглядело правкой.
  const gb = (mb: number) => String(Math.round((mb / 1024) * 10) / 10);
  const initial = target.limits
    ? { users: String(target.limits.maxUsers), storage: gb(target.limits.maxStorageMb), ocr: target.limits.plateOcr }
    : null;
  const [maxUsers, setMaxUsers] = useState(initial?.users ?? "");
  const [storageGb, setStorageGb] = useState(initial?.storage ?? "");
  const [plateOcr, setPlateOcr] = useState(initial?.ocr ?? true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const cat = categories.find((c) => c.id === categoryId);
  const catPrice = cat ? (target.kind === "cloud" ? cat.cloudPrice : cat.remotePrice) : 0;
  const price = ownPrice.trim() === "" ? catPrice : Number(ownPrice) || 0;

  // Лимиты «как в категории» — видно, отличаются ли они от неё.
  const limitsDiffer =
    !!target.limits && !!cat && (maxUsers !== String(cat.maxUsers) || storageGb !== gb(cat.maxStorageMb) || plateOcr !== cat.plateOcr);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const body: Record<string, unknown> = {
        price: ownPrice.trim() === "" ? null : Math.max(0, Math.round(Number(ownPrice) || 0)),
        paidUntil: paidUntil || null,
      };
      if (categoryId && categoryId !== target.categoryId) body.categoryId = categoryId;
      if (target.limits) {
        const users = Math.round(Number(maxUsers));
        const storage = Math.round(Number(storageGb.replace(",", ".")) * 1024);
        if (!(users >= 1)) throw new Error("Сотрудников — хотя бы один");
        if (!(storage >= 0)) throw new Error("Место — число гигабайт, 0 — без лимита");
        const changed = maxUsers !== initial?.users || storageGb !== initial?.storage || plateOcr !== initial?.ocr;
        if (changed) {
          // Место не трогали — шлём прежнее число мегабайт, а не округлённое.
          Object.assign(body, {
            maxUsers: users,
            maxStorageMb: storageGb === initial?.storage ? target.limits.maxStorageMb : storage,
            plateOcr,
          });
        }
      }
      if (target.kind === "cloud") await platformApi.patchTenant(target.id, body);
      else await platformApi.patchBox(target.id, body);
      setSaved(true);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  async function resetLimits() {
    if (!cat) return;
    setBusy(true);
    try {
      await platformApi.patchTenant(target.id, { customLimits: false });
      setMaxUsers(String(cat.maxUsers));
      setStorageGb(gb(cat.maxStorageMb));
      setPlateOcr(cat.plateOcr);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={target.name} onClose={onClose} wide>
      <div className="grid gap-5 md:grid-cols-2 [&>*]:min-w-0">
        <form onSubmit={save} className="space-y-4">
          <h3 className="text-[15px] font-bold">Условия</h3>
          {error && <Banner tone="error">{error}</Banner>}
          {saved && <Banner>Сохранено.</Banner>}
          <Field label="Категория">
            <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} disabled={!canEdit}>
              {!categoryId && <option value="">— без категории —</option>}
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={target.kind === "cloud" ? "Цена облака, ₽ в месяц" : "Цена доступа из интернета, ₽ в месяц"}
            hint={`Пусто — по категории: ${rub(catPrice)}. 0 — бесплатно`}
          >
            <Input
              inputMode="numeric"
              value={ownPrice}
              onChange={(e) => setOwnPrice(e.target.value.replace(/[^\d]/g, ""))}
              placeholder={String(catPrice)}
              disabled={!canEdit}
            />
          </Field>
          <Field label="Оплачено до" hint="Ставится сам, когда отмечаете оплату">
            <Input type="date" value={paidUntil} onChange={(e) => setPaidUntil(e.target.value)} disabled={!canEdit} />
          </Field>

          {target.limits && (
            <div className="space-y-3 rounded-field border border-line p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[13px] font-semibold text-ink-soft">
                  Лимиты {target.limits.customLimits || limitsDiffer ? "— свои" : "— как в категории"}
                </span>
                {canEdit && (target.limits.customLimits || limitsDiffer) && cat && (
                  <button type="button" onClick={() => void resetLimits()} className="text-[12.5px] font-semibold text-brand-ink hover:underline">
                    Вернуть как в категории
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Сотрудников">
                  <Input inputMode="numeric" value={maxUsers} onChange={(e) => setMaxUsers(e.target.value.replace(/[^\d]/g, ""))} disabled={!canEdit} />
                </Field>
                <Field label="Место для фото, ГБ" hint="0 — без лимита">
                  <Input inputMode="decimal" value={storageGb} onChange={(e) => setStorageGb(e.target.value.replace(/[^\d.,]/g, ""))} disabled={!canEdit} />
                </Field>
              </div>
              <Checkbox checked={plateOcr} onChange={setPlateOcr} disabled={!canEdit} label="Распознавание шильдиков камерой" />
            </div>
          )}

          {canEdit && (
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "Сохраняем…" : "Сохранить условия"}
            </Button>
          )}
        </form>

        <PaymentsPanel target={target} price={price} canEdit={canEdit} onChanged={(until) => { setPaidUntil(isoDate(until)); onChanged(); }} />
      </div>
    </Modal>
  );
}

function PaymentsPanel({
  target,
  price,
  canEdit,
  onChanged,
}: {
  target: ClientTarget;
  price: number;
  canEdit: boolean;
  onChanged: (paidUntil: string | null) => void;
}) {
  const [rows, setRows] = useState<Payment[] | null>(null);
  const [months, setMonths] = useState(1);
  const [amount, setAmount] = useState(String(price));
  const [amountTouched, setAmountTouched] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const q = target.kind === "cloud" ? { tenantId: target.id } : { boxId: target.id };
  const load = () =>
    platformApi
      .payments(q)
      .then(setRows)
      .catch(() => setRows([]));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.id]);
  useEffect(() => {
    if (!amountTouched) setAmount(String(price * months));
  }, [price, months, amountTouched]);

  async function pay(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await platformApi.pay({ ...q, amount: Math.round(Number(amount) || 0), months, note: note.trim() || undefined });
      setNote("");
      setAmountTouched(false);
      await load();
      onChanged(p.paidUntil);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось отметить оплату");
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: Payment) {
    setBusy(true);
    try {
      await platformApi.removePayment(p.id);
      const next = await platformApi.payments(q);
      setRows(next);
      // Срок откатился к прежнему — сервер это сделал, показываем свежий.
      onChanged(next[0]?.paidUntil ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось убрать оплату");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <h3 className="text-[15px] font-bold">Оплата</h3>
      {canEdit && (
        <form onSubmit={pay} className="space-y-3 rounded-field border border-line p-3">
          {error && <Banner tone="error">{error}</Banner>}
          <div>
            <span className="text-[13px] font-semibold text-ink-soft">Продлить на</span>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {MONTHS.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMonths(m)}
                  aria-pressed={months === m}
                  className={cx(
                    "rounded-pill px-3 py-1.5 text-[13px] font-semibold",
                    months === m ? "bg-brand text-white" : "border border-line bg-surface-raised text-ink-muted hover:text-ink"
                  )}
                >
                  {m === 12 ? "год" : `${m} мес`}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Получено, ₽">
              <Input
                inputMode="numeric"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value.replace(/[^\d]/g, ""));
                  setAmountTouched(true);
                }}
              />
            </Field>
            <Field label="Заметка">
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="перевод на карту" />
            </Field>
          </div>
          <Button type="submit" disabled={busy} className="w-full">
            Отметить оплату
          </Button>
        </form>
      )}
      {rows === null ? null : rows.length === 0 ? (
        <p className="text-[13px] text-ink-dim">Оплат пока не было.</p>
      ) : (
        <ul className="divide-y divide-line rounded-field border border-line">
          {rows.map((p, i) => (
            <li key={p.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  {rub(p.amount)}
                  {p.months ? <span className="font-normal text-ink-dim"> · {p.months === 12 ? "год" : `${p.months} мес`}</span> : null}
                </p>
                <p className="truncate text-[12px] text-ink-dim">
                  {formatDate(p.createdAt)} · до {formatDate(p.paidUntil)}
                  {p.note ? ` · ${p.note}` : ""}
                </p>
              </div>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => void remove(p)}
                  disabled={busy}
                  className="text-[12.5px] font-semibold text-ink-dim hover:text-state-off"
                  title={i === 0 ? "Убрать оплату — срок вернётся к прежнему" : "Убрать из истории — срок не изменится"}
                >
                  Убрать
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- мелочи

/** Выбор фильтра, запомненный на устройстве. Хранилище недоступно — не беда. */
export function usePref<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const v = localStorage.getItem(key);
      return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
    } catch {
      return fallback;
    }
  });
  return [
    value,
    (v: T) => {
      setValue(v);
      remember(key, v === fallback ? "" : v);
    },
  ];
}

/** Меню «⋯» у строки: редкие действия, которым не место на виду. */
export function RowMenu({ items }: { items: Array<{ label: string; onClick: () => void; danger?: boolean } | false | null> }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const list = items.filter(Boolean) as Array<{ label: string; onClick: () => void; danger?: boolean }>;
  return (
    <div ref={box} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-label="Ещё действия"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-[34px] w-[34px] items-center justify-center rounded-field border border-line bg-surface-raised text-ink-muted hover:text-ink [&>svg]:h-[18px] [&>svg]:w-[18px]"
      >
        <IconMore />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-[38px] z-30 min-w-[210px] overflow-hidden rounded-card border border-line-strong bg-surface-raised py-1 shadow-raised">
          {list.map((i) => (
            <button
              key={i.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                i.onClick();
              }}
              className={cx(
                "block w-full px-3.5 py-2 text-left text-[13.5px] font-semibold hover:bg-surface",
                i.danger ? "text-state-off" : "text-ink-soft"
              )}
            >
              {i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Поиск: регистр и ё не важны. */
export const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е");
