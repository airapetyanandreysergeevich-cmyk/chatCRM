import { useEffect, useState, type FormEvent } from "react";
import { ApiError } from "../lib/api";
import { plural } from "../lib/format";
import { quickPicksApi, type QuickPick, type QuickPickField } from "../lib/quickPicks";
import { IconAdd, IconDelete, IconEdit } from "./icons";
import { Modal } from "./Modal";
import { Banner, Button, Input } from "./ui";

/**
 * Правка кнопок быстрого заполнения — окно под шестерёнкой на бланке.
 *
 * Правка сохраняется сразу, по одной кнопке, без общего «Сохранить»: окно
 * со списком из десяти строк, где забытое «Сохранить» отменяет полчаса
 * работы, хуже, чем окно, где каждое действие уже сделано.
 *
 * Порядок здесь тот же, что на бланке, — по частоте. Число справа объясняет
 * его: «почему Батарея первая» — потому что её отметили триста раз.
 */

const TITLES: Record<QuickPickField, string> = {
  completeness: "Кнопки комплектности",
  appearance: "Кнопки внешнего состояния",
};

export function QuickPickEditor({
  field,
  onClose,
  onChanged,
}: {
  field: QuickPickField;
  onClose: () => void;
  /** Список изменился — бланк перерисует кнопки, не закрывая окна. */
  onChanged: (list: QuickPick[]) => void;
}) {
  const [list, setList] = useState<QuickPick[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; label: string } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    const next = await quickPicksApi.list(field);
    setList(next);
    onChanged(next);
  };

  useEffect(() => {
    quickPicksApi
      .list(field)
      .then(setList)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить кнопки"));
  }, [field]);

  /** Одна обёртка на все действия: занятость, текст ошибки, свежий список. */
  async function act(run: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await run();
      await refresh();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не получилось, попробуйте ещё раз");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    const label = draft.trim();
    if (!label) return;
    if (await act(() => quickPicksApi.add(field, label))) setDraft("");
  }

  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    if (await act(() => quickPicksApi.rename(field, editing.id, editing.label.trim()))) setEditing(null);
  }

  return (
    <Modal title={TITLES[field]} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-[13px] text-ink-dim">
          Кнопки стоят по частоте: чем чаще пункт попадает в заказ, тем он левее. Новый порядок
          видно на следующем бланке — на открытом кнопки не прыгают из-под пальца.
        </p>

        {error && <Banner tone="error">{error}</Banner>}

        {!list ? (
          <p className="text-[13px] text-ink-dim">Загружаем…</p>
        ) : (
          <ul className="space-y-1.5">
            {list.map((q) => (
              <li key={q.id} className="rounded-field border border-line bg-surface-raised px-3 py-2">
                {editing?.id === q.id ? (
                  <form onSubmit={saveEdit} className="flex flex-wrap items-center gap-2">
                    <Input
                      value={editing.label}
                      onChange={(e) => setEditing({ id: q.id, label: e.target.value })}
                      autoFocus
                      className="min-w-0 flex-1"
                    />
                    <Button type="submit" disabled={busy || !editing.label.trim()}>
                      Сохранить
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                      Отмена
                    </Button>
                  </form>
                ) : removing === q.id ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 flex-1 text-[14px]">
                      Убрать «{q.label}»? В принятых заказах пункт останется.
                    </span>
                    <Button
                      type="button"
                      variant="danger"
                      disabled={busy}
                      onClick={() => void act(() => quickPicksApi.remove(field, q.id)).then(() => setRemoving(null))}
                    >
                      Убрать
                    </Button>
                    <Button type="button" variant="ghost" onClick={() => setRemoving(null)}>
                      Оставить
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{q.label}</span>
                    <span className="shrink-0 text-[12px] text-ink-dim">
                      {q.uses > 0 ? plural(q.uses, "раз", "раза", "раз") : "не отмечали"}
                    </span>
                    {q.locked ? (
                      <span
                        className="shrink-0 rounded-pill bg-surface px-2 py-0.5 text-[11.5px] text-ink-muted"
                        title="По этой кнопке ставится флаг гарантии — её нельзя переименовать или убрать"
                      >
                        флаг гарантии
                      </span>
                    ) : (
                      <>
                        <button
                          type="button"
                          aria-label={`Переименовать «${q.label}»`}
                          onClick={() => {
                            setRemoving(null);
                            setEditing({ id: q.id, label: q.label });
                          }}
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] text-ink-dim transition-colors hover:bg-surface-hover hover:text-ink [&>svg]:h-[16px] [&>svg]:w-[16px]"
                        >
                          <IconEdit />
                        </button>
                        <button
                          type="button"
                          aria-label={`Убрать «${q.label}»`}
                          onClick={() => {
                            setEditing(null);
                            setRemoving(q.id);
                          }}
                          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] text-ink-dim transition-colors hover:bg-state-off/15 hover:text-state-off [&>svg]:h-[16px] [&>svg]:w-[16px]"
                        >
                          <IconDelete />
                        </button>
                      </>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        <form onSubmit={add} className="flex gap-2 border-t border-line pt-4">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Новая кнопка, например «Сим-лоток»"
            className="min-w-0 flex-1"
          />
          <Button type="submit" icon={<IconAdd />} disabled={busy || !draft.trim()}>
            Добавить
          </Button>
        </form>

        <div className="flex justify-end">
          <Button type="button" variant="secondary" onClick={onClose}>
            Готово
          </Button>
        </div>
      </div>
    </Modal>
  );
}
