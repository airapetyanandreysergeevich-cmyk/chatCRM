import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { ApiError } from "../lib/api";
import { LABEL_COLORS, LABEL_ICONS, LabelDot, LabelGlyph } from "../lib/labelIcons";
import { labelsApi, type LabelDef } from "../lib/orders";
import { plural } from "../lib/format";
import { Panel } from "./Panel";
import { Banner, Button, Input } from "./ui";
import { IconChevronDown } from "./icons";

/**
 * «Индивидуальные оповещения» — свои ярлыки заказов мастерской (Андрей,
 * 22.10.2026): название, значок из коллекции и цвет. Слева — ярлыки по
 * порядку, справа — правка выбранного или нового. Заводит владелец или
 * совладелец; ставят на заказы все, кто с ними работает.
 */

type Draft = Omit<LabelDef, "id" | "orders">;
const EMPTY: Draft = { name: "", icon: "phone", color: LABEL_COLORS[0], quickFilter: false, notify: false };

function Tick({ on, onClick, children, hint, testId }: { on: boolean; onClick: () => void; children: React.ReactNode; hint: string; testId: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} onClick={onClick} data-label-flag={testId} className="mt-3 flex items-start gap-2.5 text-left text-[13.5px]">
      <span
        className={
          "mt-[1px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors duration-150 " +
          (on ? "border-brand bg-brand text-white" : "border-line-strong")
        }
      >
        {on && (
          <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.4}>
            <path d="m3.5 8.5 3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      <span>
        {children}
        <span className="block text-[12px] text-ink-dim">{hint}</span>
      </span>
    </button>
  );
}

export function LabelsCard() {
  const { hash } = useLocation();
  const [items, setItems] = useState<LabelDef[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = () =>
    labelsApi
      .list()
      .then((r) => {
        setItems(r.items);
        setCanManage(r.canManage);
        return r.items;
      })
      .catch((e) => {
        setError(e instanceof ApiError ? e.message : "Не удалось загрузить ярлыки");
        return [] as LabelDef[];
      });

  useEffect(() => {
    void load().then((list) => {
      if (list.length) pick(list[0]);
      else startNew();
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function pick(l: LabelDef) {
    setSelected(l.id);
    setDraft({ name: l.name, icon: l.icon, color: l.color, quickFilter: l.quickFilter, notify: l.notify });
    setConfirmDelete(false);
    setError(null);
  }
  function startNew() {
    setSelected("new");
    setDraft(EMPTY);
    setConfirmDelete(false);
    setError(null);
  }

  async function save() {
    if (!draft.name.trim()) return setError("Назовите ярлык");
    setBusy(true);
    setError(null);
    try {
      if (selected === "new") {
        const created = await labelsApi.create({ ...draft, name: draft.name.trim() });
        await load();
        setSelected(created.id);
        setNotice(`Ярлык «${created.name}» заведён — его можно ставить на заказы`);
      } else if (selected) {
        await labelsApi.update(selected, { ...draft, name: draft.name.trim() });
        await load();
        setNotice("Сохранено");
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!selected || selected === "new") return;
    setBusy(true);
    try {
      const r = await labelsApi.remove(selected);
      const list = await load();
      setNotice(r.marks ? `Ярлык удалён и снят с ${plural(r.marks, "заказа", "заказов", "заказов")}` : "Ярлык удалён");
      if (list.length) pick(list[0]);
      else startNew();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Не удалось удалить");
    } finally {
      setBusy(false);
    }
  }

  async function move(id: string, delta: -1 | 1) {
    if (!items) return;
    const i = items.findIndex((x) => x.id === id);
    const j = i + delta;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    setItems(next);
    try {
      await labelsApi.reorder(next.map((x) => x.id));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Не удалось поменять порядок");
      void load();
    }
  }

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  if (!items || !canManage) return null;

  return (
    <div id="labels" className="scroll-mt-20">
      <Panel
        id="interface:Индивидуальные оповещения"
        title="Индивидуальные оповещения"
        summary={items.length ? `Ярлыков: ${items.length}` : "Своих ярлыков пока нет"}
        defaultOpen={hash === "#labels"}
      >
        <p className="mt-2 text-[13px] text-ink-dim">
          Свои ярлыки заказов: значок в цветном кружке рядом со статусом — «Требуется звонок клиенту», «Ждём оплату». Ставят и снимают
          все, кто работает с заказом; кто и когда — видно в истории ремонта.
        </p>
        {error && (
          <div className="mt-3">
            <Banner tone="error">{error}</Banner>
          </div>
        )}
        {notice && (
          <div className="mt-3" data-labels-notice>
            <Banner>{notice}</Banner>
          </div>
        )}

        <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <div className="space-y-2" data-labels-list>
            {items.map((l, i) => (
              <div
                key={l.id}
                className={
                  "flex items-center gap-2.5 rounded-field border px-3 py-2 " +
                  (selected === l.id ? "border-brand/70 bg-brand-tint" : "border-line bg-surface-input")
                }
              >
                <button type="button" onClick={() => pick(l)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left" data-label-row={l.name}>
                  <LabelDot icon={l.icon} color={l.color} size="md" />
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] font-semibold">{l.name}</span>
                    <span className="block text-[12px] text-ink-dim">
                      {[l.quickFilter && "в фильтрах", l.notify && "оповещает", l.orders ? plural(l.orders, "заказ", "заказа", "заказов") : "не стоит"]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  aria-label="Выше"
                  disabled={i === 0}
                  onClick={() => void move(l.id, -1)}
                  className="flex h-8 w-8 items-center justify-center rounded-field border border-line text-ink-muted hover:text-ink disabled:opacity-30"
                >
                  <IconChevronDown className="h-4 w-4 rotate-180" />
                </button>
                <button
                  type="button"
                  aria-label="Ниже"
                  disabled={i === items.length - 1}
                  onClick={() => void move(l.id, 1)}
                  className="flex h-8 w-8 items-center justify-center rounded-field border border-line text-ink-muted hover:text-ink disabled:opacity-30"
                >
                  <IconChevronDown className="h-4 w-4" />
                </button>
              </div>
            ))}
            <Button variant="secondary" className="w-full" onClick={startNew} data-label-new>
              + Новый ярлык
            </Button>
          </div>

          <div data-label-editor>
            <label className="block">
              <span className="mb-1.5 block text-[12.5px] font-semibold text-ink-soft">Название</span>
              <Input
                value={draft.name}
                maxLength={60}
                placeholder="Требуется звонок клиенту"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                data-label-name
              />
            </label>
            <p className="mb-1.5 mt-4 text-[12.5px] font-semibold text-ink-soft">Значок</p>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(38px,1fr))] gap-1.5" role="radiogroup" aria-label="Значок">
              {Object.entries(LABEL_ICONS).map(([key, v]) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={draft.icon === key}
                  title={v.title}
                  data-label-icon={key}
                  onClick={() => setDraft({ ...draft, icon: key })}
                  className={
                    "flex h-[38px] items-center justify-center rounded-[10px] border transition-colors duration-100 [&>svg]:h-[18px] [&>svg]:w-[18px] " +
                    (draft.icon === key ? "border-brand bg-brand-tint text-ink ring-2 ring-brand/40" : "border-line bg-surface-input text-ink-soft hover:border-line-strong")
                  }
                >
                  <LabelGlyph icon={key} />
                </button>
              ))}
            </div>
            <p className="mb-1.5 mt-4 text-[12.5px] font-semibold text-ink-soft">Цвет</p>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Цвет">
              {LABEL_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={draft.color === c}
                  aria-label={c}
                  data-label-color={c}
                  onClick={() => setDraft({ ...draft, color: c })}
                  className={"h-8 w-8 rounded-full " + (draft.color === c ? "ring-2 ring-ink ring-offset-2 ring-offset-surface" : "")}
                  style={{ background: c }}
                />
              ))}
            </div>
            <p className="mb-1.5 mt-4 text-[12.5px] font-semibold text-ink-soft">Как выглядит</p>
            <div className="flex items-center gap-3">
              <LabelDot icon={draft.icon} color={draft.color} size="lg" />
              <LabelDot icon={draft.icon} color={draft.color} size="md" />
              <LabelDot icon={draft.icon} color={draft.color} size="sm" />
              <span className="truncate text-[13.5px] text-ink-soft">{draft.name || "Название ярлыка"}</span>
            </div>
            <Tick
              on={draft.quickFilter}
              onClick={() => setDraft({ ...draft, quickFilter: !draft.quickFilter })}
              hint="Кнопка с числом заказов рядом с «Без мастера» на главной-таблице"
              testId="quick"
            >
              Кнопкой в быстрых фильтрах главной
            </Tick>
            <Tick
              on={draft.notify}
              onClick={() => setDraft({ ...draft, notify: !draft.notify })}
              hint="В колокольчик и на телефон: мастеру заказа и ролям, отмеченным в «Оповещениях» у «Поставлен ярлык»"
              testId="notify"
            >
              Оповещать, когда ставят этот ярлык
            </Tick>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button disabled={busy || !draft.name.trim()} onClick={() => void save()} data-label-save>
                {selected === "new" ? "Завести ярлык" : "Сохранить"}
              </Button>
              {selected && selected !== "new" && !confirmDelete && (
                <Button variant="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
                  Удалить
                </Button>
              )}
              {confirmDelete && (
                <Button variant="danger" disabled={busy} onClick={() => void remove()} data-label-delete>
                  Удалить и снять с заказов
                </Button>
              )}
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}
