import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Modal } from "./Modal";
import { Button } from "./ui";
import { IconClose, IconFilter } from "./icons";
import { CUSTOMER_COLORS, customerColor } from "../lib/customerColor";
import { summaryApi, type DeviceKindOption } from "../lib/workshop";
import type { ColorFilterValue } from "./ListControls";

/**
 * Фильтры заказов за одной кнопкой.
 *
 * Андрей: «нажал — выскочило меню, выбрал как фильтровать и сортировать и
 * ок». Выбор в окне — черновик: список не дёргается на каждое нажатие и
 * меняется один раз, по «Показать». На кнопке — красный кружок с числом
 * выбранных фильтров; без фильтров кружка нет. Поиск ищет внутри выбранного.
 */

export interface StageOption {
  value: string;
  label: string;
  /** Класс ярлыка своей стадии — выбранная кнопка окрашена в её цвет. */
  pill: string | null;
}

export interface SortOption {
  value: string;
  label: string;
}

export interface OrderFilterState {
  group: string;
  kinds: string[];
  color: ColorFilterValue;
  sort: string;
  /** Аутсорс: "" — все заказы, "1" — все клиенты-аутсорс, иначе id одного из них. */
  outsource: string;
}

/** Сколько фильтров выбрано: стадия, каждый тип техники, метка, аутсорс. Сортировка — не фильтр. */
export const filterCount = (f: OrderFilterState) =>
  (f.group ? 1 : 0) + f.kinds.length + (f.color ? 1 : 0) + (f.outsource ? 1 : 0);

export interface OutsourceClient {
  id: string;
  name: string;
  address: string | null;
}

/** «Сервис Плюс — ул. Мира, 5»: двух партнёров с одним именем различают по адресу. */
export const outsourceLabel = (c: OutsourceClient) => (c.address ? `${c.name} — ${c.address}` : c.name);

/** Клиенты-аутсорс для фильтра. Нет права видеть клиентов — пустой список, раздела в окне нет. */
export function useOutsourceClients(): OutsourceClient[] | null {
  const [list, setList] = useState<OutsourceClient[] | null>(null);
  useEffect(() => {
    api
      .get<{ items: OutsourceClient[] }>("/customers/outsource")
      .then((r) => setList(r.items))
      .catch(() => setList([]));
  }, []);
  return list;
}

const KINDS_FIRST = 12;

const chip = (on: boolean, pill?: string | null) =>
  "inline-flex items-center gap-1.5 rounded-pill border px-3.5 py-1.5 text-[13px] font-semibold transition-colors duration-150 " +
  (on ? (pill ?? "border-brand bg-brand text-white") : "border-line bg-surface-raised text-ink-muted hover:text-ink");

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <p className="mb-2 text-[12px] font-bold uppercase tracking-[0.08em] text-ink-dim">{title}</p>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </section>
  );
}

/** Кнопка «Фильтры» с кружком-счётчиком. */
export function FilterButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={count ? `Фильтры и сортировка, выбрано: ${count}` : "Фильтры и сортировка"}
      className={
        "relative inline-flex min-h-[46px] min-w-[46px] shrink-0 items-center justify-center gap-2 rounded-field border bg-surface-input px-3 sm:px-4 text-[14.5px] font-semibold text-ink transition-colors duration-150 hover:border-line-strong " +
        (count ? "border-brand" : "border-line")
      }
    >
      <IconFilter className="h-[19px] w-[19px]" />
      {/* На телефоне — только значок: ширина нужнее полю поиска. */}
      <span className="hidden sm:inline">Фильтры</span>
      {count > 0 && (
        <span
          data-testid="filter-count"
          className="absolute -right-2 -top-2 flex h-[21px] min-w-[21px] items-center justify-center rounded-full bg-state-off px-1.5 text-[11.5px] font-bold leading-none text-white shadow-raised"
        >
          {count}
        </span>
      )}
    </button>
  );
}

/** Выбранные фильтры строкой под поиском: видно, в чём ищем, и снимается одним нажатием. */
export function ActiveFilters({
  value,
  stages,
  sorts,
  kindLabel,
  outsource,
  onChange,
}: {
  value: OrderFilterState;
  stages: StageOption[];
  sorts: SortOption[];
  kindLabel: (key: string) => string;
  outsource: OutsourceClient[] | null;
  onChange: (next: OrderFilterState) => void;
}) {
  const stage = stages.find((s) => s.value === value.group && s.value);
  const color = value.color === "none" ? "Без метки" : customerColor(value.color)?.label;
  const sort = value.sort !== "default" ? sorts.find((s) => s.value === value.sort)?.label : null;
  const partner = value.outsource && value.outsource !== "1" ? outsource?.find((c) => c.id === value.outsource) : null;
  if (!stage && !value.kinds.length && !value.color && !sort && !value.outsource) return null;

  const Chip = ({ label, cls, onRemove }: { label: string; cls?: string | null; onRemove: () => void }) => (
    <button type="button" onClick={onRemove} className={chip(true, cls) + " pr-2.5"} title="Снять">
      {label}
      <IconClose className="h-[14px] w-[14px] opacity-70" />
    </button>
  );

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {stage && <Chip label={stage.label} cls={stage.pill} onRemove={() => onChange({ ...value, group: "" })} />}
      {value.kinds.map((k) => (
        <Chip key={k} label={kindLabel(k)} onRemove={() => onChange({ ...value, kinds: value.kinds.filter((x) => x !== k) })} />
      ))}
      {value.color && (
        <Chip label={`Метка: ${color ?? value.color}`} onRemove={() => onChange({ ...value, color: "" })} />
      )}
      {value.outsource && (
        <Chip
          label={value.outsource === "1" ? "Аутсорс: все" : `Аутсорс: ${partner ? partner.name : "выбранный"}`}
          onRemove={() => onChange({ ...value, outsource: "" })}
        />
      )}
      {sort && <span className="ml-1 text-[13px] text-ink-dim">Сортировка: {sort}</span>}
    </div>
  );
}

/** Окно выбора. Применяется целиком по «Показать». */
export function OrderFiltersModal({
  value,
  stages,
  sorts,
  kinds,
  outsource,
  onApply,
  onClose,
}: {
  value: OrderFilterState;
  stages: StageOption[];
  sorts: SortOption[];
  kinds: DeviceKindOption[] | null;
  /** Клиенты-аутсорс; пусто — раздела нет. */
  outsource: OutsourceClient[] | null;
  onApply: (next: OrderFilterState) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<OrderFilterState>(value);
  const [allKinds, setAllKinds] = useState(false);

  const kindList = kinds ?? [];
  // Выбранный тип, которого нет среди первых, всё равно виден — иначе его не снять.
  const shown = allKinds
    ? kindList
    : kindList.filter((k, i) => i < KINDS_FIRST || draft.kinds.includes(k.key));
  const toggleKind = (key: string) =>
    setDraft((d) => ({ ...d, kinds: d.kinds.includes(key) ? d.kinds.filter((k) => k !== key) : [...d.kinds, key] }));

  return (
    <Modal title="Фильтры и сортировка" onClose={onClose}>
      <div className="space-y-5">
        <Section title="Стадия">
          {stages.map((s) => (
            <button
              key={s.value || "all"}
              type="button"
              aria-pressed={draft.group === s.value}
              onClick={() => setDraft((d) => ({ ...d, group: s.value }))}
              className={chip(draft.group === s.value, s.pill)}
            >
              {s.label}
            </button>
          ))}
        </Section>

        <Section title="Тип техники">
          <button
            type="button"
            aria-pressed={draft.kinds.length === 0}
            onClick={() => setDraft((d) => ({ ...d, kinds: [] }))}
            className={chip(draft.kinds.length === 0)}
          >
            Любой
          </button>
          {kinds === null && <span className="self-center text-[13px] text-ink-dim">загружаем…</span>}
          {shown.map((k) => (
            <button
              key={k.key}
              type="button"
              aria-pressed={draft.kinds.includes(k.key)}
              onClick={() => toggleKind(k.key)}
              className={chip(draft.kinds.includes(k.key))}
            >
              {k.label}
              <span className="text-[11.5px] font-medium opacity-70">{k.count}</span>
            </button>
          ))}
          {!allKinds && kindList.length > shown.length && (
            <button type="button" onClick={() => setAllKinds(true)} className="px-2 text-[13px] font-semibold text-brand hover:text-brand-ink">
              ещё {kindList.length - shown.length}
            </button>
          )}
        </Section>

        <Section title="Метка клиента">
          {[
            { value: "" as ColorFilterValue, label: "Все клиенты", dot: undefined as string | null | undefined },
            ...CUSTOMER_COLORS.map((c) => ({ value: c.key as ColorFilterValue, label: c.label, dot: c.dot as string | null | undefined })),
            { value: "none" as ColorFilterValue, label: "Без метки", dot: null as string | null | undefined },
          ].map((c) => (
            <button
              key={c.value || "all"}
              type="button"
              aria-pressed={draft.color === c.value}
              onClick={() => setDraft((d) => ({ ...d, color: c.value }))}
              className={chip(draft.color === c.value)}
            >
              {c.dot !== undefined &&
                (c.dot ? (
                  <span className="h-[11px] w-[11px] rounded-full" style={{ backgroundColor: c.dot }} />
                ) : (
                  <span className="h-[11px] w-[11px] rounded-full border border-dashed border-current" />
                ))}
              {c.label}
            </button>
          ))}
        </Section>

        {(outsource?.length ?? 0) > 0 && (
          <Section title="Аутсорс">
            <button type="button" aria-pressed={!draft.outsource} onClick={() => setDraft((d) => ({ ...d, outsource: "" }))} className={chip(!draft.outsource)}>
              Все заказы
            </button>
            <button
              type="button"
              aria-pressed={draft.outsource === "1"}
              onClick={() => setDraft((d) => ({ ...d, outsource: "1" }))}
              className={chip(draft.outsource === "1")}
            >
              Все аутсорс
            </button>
            <select
              aria-label="Аутсорс: конкретный"
              value={draft.outsource && draft.outsource !== "1" ? draft.outsource : ""}
              onChange={(e) => setDraft((d) => ({ ...d, outsource: e.target.value }))}
              className={
                "min-h-[34px] w-full max-w-full rounded-pill border bg-surface-raised px-3.5 py-1.5 text-[13px] font-semibold outline-none transition-colors focus:border-brand sm:w-auto sm:max-w-[360px] " +
                (draft.outsource && draft.outsource !== "1" ? "border-brand text-brand-ink" : "border-line text-ink-muted")
              }
            >
              <option value="">Конкретный…</option>
              {outsource!.map((c) => (
                <option key={c.id} value={c.id}>
                  {outsourceLabel(c)}
                </option>
              ))}
            </select>
          </Section>
        )}

        <Section title="Сортировка">
          {sorts.map((s) => (
            <button
              key={s.value}
              type="button"
              aria-pressed={draft.sort === s.value}
              onClick={() => setDraft((d) => ({ ...d, sort: s.value }))}
              className={chip(draft.sort === s.value)}
            >
              {s.label}
            </button>
          ))}
        </Section>

        {/* На телефоне кнопки прилипают к низу листа: длинный список типов
            не должен прятать «Показать». */}
        <div className="sticky -bottom-5 -mx-5 -mb-5 flex flex-col gap-2 border-t border-line bg-surface px-5 pb-5 pt-4 sm:static sm:mx-0 sm:mb-0 sm:flex-row-reverse sm:px-0 sm:pb-0">
          <Button type="button" onClick={() => onApply(draft)} className="sm:flex-1">
            Показать
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setDraft({ group: "", kinds: [], color: "", sort: "default", outsource: "" })}
            className="sm:flex-1"
          >
            Сбросить всё
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Типы техники мастерской — для окна и для подписей выбранных. Один запрос на страницу. */
export function useDeviceKinds(): DeviceKindOption[] | null {
  const [kinds, setKinds] = useState<DeviceKindOption[] | null>(null);
  useEffect(() => {
    summaryApi
      .kinds()
      .then((r) => setKinds(r.kinds.filter((k) => k.key)))
      .catch(() => setKinds([]));
  }, []);
  return kinds;
}
