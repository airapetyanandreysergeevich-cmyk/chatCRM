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
  /** Выбранные стадии. Пусто — все (фильтра нет). */
  stages: string[];
  /** Только эти типы техники. */
  kinds: string[];
  /** Все типы, кроме этих: «Все» нажали и сняли лишние. */
  kindsNot: string[];
  color: ColorFilterValue;
  sort: string;
  /** Аутсорс: "" — все заказы, "1" — все клиенты-аутсорс, иначе id одного из них. */
  outsource: string;
}

/** Сколько фильтров выбрано: каждая стадия, каждый тип техники, метка, аутсорс. Сортировка — не фильтр. */
export const filterCount = (f: OrderFilterState) =>
  f.stages.length + f.kinds.length + f.kindsNot.length + (f.color ? 1 : 0) + (f.outsource ? 1 : 0);

export const EMPTY_FILTERS: OrderFilterState = { stages: [], kinds: [], kindsNot: [], color: "", sort: "default", outsource: "" };

/**
 * Выбор из набора с кнопкой «Все».
 *
 * Андрей: «при нажатии на кнопку Все выделялись все пункты, и можно было
 * отключать определённые». Поэтому без фильтра подсвечено всё, нажатие на
 * пункт его снимает, «Все» — выделяет всё или, если и так всё, снимает всё,
 * чтобы выбрать один-два. Ничего не выбрано — это то же, что всё.
 */
export function toggleInSet(all: string[], selected: string[], key: string): string[] {
  const current = selected.length ? selected : all;
  const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
  return next.length === 0 || all.every((k) => next.includes(k)) ? [] : all.filter((k) => next.includes(k));
}

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
  const picked = stages.filter((s) => s.value && value.stages.includes(s.value));
  const color = value.color === "none" ? "Без метки" : customerColor(value.color)?.label;
  const sort = value.sort !== "default" ? sorts.find((s) => s.value === value.sort)?.label : null;
  const partner = value.outsource && value.outsource !== "1" ? outsource?.find((c) => c.id === value.outsource) : null;
  if (!picked.length && !value.kinds.length && !value.kindsNot.length && !value.color && !sort && !value.outsource) return null;

  const Chip = ({ label, cls, onRemove }: { label: string; cls?: string | null; onRemove: () => void }) => (
    <button type="button" onClick={onRemove} className={chip(true, cls) + " pr-2.5"} title="Снять">
      {label}
      <IconClose className="h-[14px] w-[14px] opacity-70" />
    </button>
  );

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {picked.map((s) => (
        <Chip key={s.value} label={s.label} cls={s.pill} onRemove={() => onChange({ ...value, stages: value.stages.filter((x) => x !== s.value) })} />
      ))}
      {value.kinds.map((k) => (
        <Chip key={k} label={kindLabel(k)} onRemove={() => onChange({ ...value, kinds: value.kinds.filter((x) => x !== k) })} />
      ))}
      {value.kindsNot.map((k) => (
        <Chip key={"not" + k} label={`Кроме: ${kindLabel(k)}`} onRemove={() => onChange({ ...value, kindsNot: value.kindsNot.filter((x) => x !== k) })} />
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
  const stageKeys = stages.filter((s) => s.value).map((s) => s.value);
  const stageOn = (key: string) => !draft.stages.length || draft.stages.includes(key);
  const allKeys = kindList.map((k) => k.key);
  // Тип выбран: «только эти» — он в списке; «все, кроме» — его нет среди снятых.
  const kindOn = (key: string) => (draft.kinds.length ? draft.kinds.includes(key) : !draft.kindsNot.includes(key));
  const kindsAll = !draft.kinds.length && !draft.kindsNot.length;
  const toggleKind = (key: string) =>
    setDraft((d) => {
      const on = allKeys.filter((k) => (d.kinds.length ? d.kinds.includes(k) : !d.kindsNot.includes(k)));
      const flipped = on.includes(key) ? on.filter((k) => k !== key) : [...on, key];
      const next = allKeys.filter((k) => flipped.includes(k));
      if (!next.length || next.length === allKeys.length) return { ...d, kinds: [], kindsNot: [] };
      // Короче записать: «только эти» или «все, кроме». «Кроме» не потеряет
      // типы, которых сегодня ещё нет, — новый тип попадёт в список сам.
      const off = allKeys.filter((k) => !next.includes(k));
      return next.length <= off.length ? { ...d, kinds: next, kindsNot: [] } : { ...d, kinds: [], kindsNot: off };
    });

  return (
    <Modal title="Фильтры и сортировка" onClose={onClose}>
      <div className="space-y-5">
        <Section title="Стадия">
          {stages.map((s) =>
            s.value ? (
              <button
                key={s.value}
                type="button"
                aria-pressed={stageOn(s.value)}
                onClick={() => setDraft((d) => ({ ...d, stages: toggleInSet(stageKeys, d.stages, s.value) }))}
                className={chip(stageOn(s.value), s.pill)}
              >
                {s.label}
              </button>
            ) : (
              <button
                key="all"
                type="button"
                aria-pressed={!draft.stages.length}
                // Всё выделено — снять всё, чтобы выбрать одну-две; иначе выделить всё.
                onClick={() => setDraft((d) => ({ ...d, stages: d.stages.length ? [] : ["__none__"] }))}
                className={chip(!draft.stages.length)}
              >
                {s.label}
              </button>
            )
          )}
        </Section>

        <Section title="Тип техники">
          <button
            type="button"
            aria-pressed={kindsAll}
            onClick={() => setDraft((d) => (kindsAll ? { ...d, kinds: ["__none__"], kindsNot: [] } : { ...d, kinds: [], kindsNot: [] }))}
            className={chip(kindsAll)}
          >
            Все
          </button>
          {kinds === null && <span className="self-center text-[13px] text-ink-dim">загружаем…</span>}
          {shown.map((k) => (
            <button
              key={k.key}
              type="button"
              aria-pressed={kindOn(k.key)}
              onClick={() => toggleKind(k.key)}
              className={chip(kindOn(k.key))}
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
          <Button type="button" onClick={() => onApply(cleanFilters(draft))} className="sm:flex-1">
            Показать
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => setDraft(EMPTY_FILTERS)}
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

/**
 * «Ничего не выбрано» (после «Все», снявшего всё) — внутренняя пометка окна.
 * Наружу уходит как «все»: показать пустой список никто не просил.
 */
export function cleanFilters(f: OrderFilterState): OrderFilterState {
  const real = (list: string[]) => list.filter((k) => k !== "__none__");
  return { ...f, stages: real(f.stages), kinds: real(f.kinds), kindsNot: real(f.kindsNot) };
}

/** Запомненные фильтры сотрудника на этом устройстве. Хранилище недоступно — просто не помним. */
export function recallFilters(key: string): OrderFilterState | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<OrderFilterState>;
    const list = (x: unknown) => (Array.isArray(x) ? x.filter((k): k is string => typeof k === "string" && !!k).slice(0, 40) : []);
    return {
      stages: list(v.stages),
      kinds: list(v.kinds),
      kindsNot: list(v.kindsNot),
      color: (typeof v.color === "string" ? v.color : "") as OrderFilterState["color"],
      sort: typeof v.sort === "string" && v.sort ? v.sort : "default",
      outsource: typeof v.outsource === "string" ? v.outsource : "",
    };
  } catch {
    return null;
  }
}

export function rememberFilters(key: string, f: OrderFilterState) {
  try {
    if (filterCount(f) === 0 && f.sort === "default") localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(f));
  } catch {
    /* не запомнили — не беда */
  }
}
