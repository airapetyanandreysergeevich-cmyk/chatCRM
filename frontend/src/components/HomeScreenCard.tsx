import { useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import { columnsFor, isShown, panelLabel } from "../lib/dashboard";
import { OVERDUE_KEY, summaryApi, type ColumnKey, type DashboardPrefs } from "../lib/workshop";
import { IconChevronDown } from "./icons";
import { Banner, Card, SectionLabel } from "./ui";

/**
 * «Главный экран» в разделе «Интерфейс»: какие панели показывать и в каком
 * порядке. Сортировка, количество и фильтр техники — у каждой панели в её
 * шестерёнке, прямо на главной.
 *
 * Порядок — стрелками, а не перетаскиванием: на телефоне перетаскивание
 * путается с прокруткой, а стрелка срабатывает всегда с первого раза.
 *
 * Сохраняется сразу, как и шестерёнка: настройки у каждого сотрудника свои и
 * живут на сервере — на телефоне и в программе будет так же.
 */

function Tick({ on }: { on: boolean }) {
  return (
    <span
      className={
        "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors duration-150 " +
        (on ? "border-brand bg-brand text-white" : "border-line-strong")
      }
    >
      {on && (
        <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.4}>
          <path d="m3.5 8.5 3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

function ArrowButton({ up, disabled, onClick, label }: { up: boolean; disabled: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      title={label}
      className="inline-flex h-9 w-9 items-center justify-center rounded-field border border-line bg-surface-input text-ink-muted transition-colors duration-150 hover:border-line-strong hover:text-ink disabled:cursor-default disabled:opacity-30 disabled:hover:border-line disabled:hover:text-ink-muted"
    >
      <IconChevronDown className={"h-4 w-4 " + (up ? "rotate-180" : "")} />
    </button>
  );
}

export function HomeScreenCard() {
  const [prefs, setPrefs] = useState<DashboardPrefs | null>(null);
  const [money, setMoney] = useState(false);
  const [personal, setPersonal] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    summaryApi
      .prefs()
      .then((r) => {
        setPrefs(r.prefs);
        setMoney(r.money);
        setPersonal(r.personal);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Не удалось загрузить настройки главного экрана"));
  }, []);

  const save = (next: DashboardPrefs) => {
    const before = prefs;
    setPrefs(next);
    summaryApi
      .savePrefs(next)
      .then((r) => {
        setPrefs(r.prefs);
        setError(null);
      })
      .catch((e) => {
        setPrefs(before);
        setError(e instanceof ApiError ? e.message : "Не удалось сохранить");
      });
  };

  if (!prefs) {
    return error ? <Banner tone="error">{error}</Banner> : null;
  }

  const columns = columnsFor(prefs, money);

  const toggle = (key: string) =>
    save({
      ...prefs,
      hidden: isShown(prefs, key) ? [...prefs.hidden, key] : prefs.hidden.filter((k) => k !== key),
    });

  // Двигаем среди тех, кого человек видит в списке: «Должники», скрытые от
  // него правами, стоят в порядке на своём месте и не мешают стрелкам.
  const move = (key: ColumnKey, delta: -1 | 1) => {
    const i = columns.indexOf(key);
    const other = columns[i + delta];
    if (!other) return;
    const order = [...prefs.order];
    const a = order.indexOf(key);
    const b = order.indexOf(other);
    [order[a], order[b]] = [order[b], order[a]];
    save({ ...prefs, order });
  };

  const tuned = Object.keys(prefs.panels).length > 0;

  return (
    <Card>
      <SectionLabel>Главный экран</SectionLabel>
      <p className="mt-2 text-[13px] text-ink-dim">
        Какие панели показывать и в каком порядке. Сортировка, сколько карточек показывать и какую технику
        прятать — в шестерёнке на самой панели. Настройки ваши личные: у каждого сотрудника свои, на всех
        устройствах одинаковые.
      </p>

      {error && (
        <div className="mt-3">
          <Banner tone="error">{error}</Banner>
        </div>
      )}
      {!personal && (
        <div className="mt-3">
          <Banner>Вход поддержки: настройки главного экрана сохраняются только у сотрудников мастерской.</Banner>
        </div>
      )}

      <ol className="mt-4 space-y-2 sm:max-w-[560px]">
        {columns.map((key, i) => {
          const on = isShown(prefs, key);
          return (
            <li key={key} className="flex items-center gap-2">
              <span className="w-6 shrink-0 text-right font-mono text-[13px] text-ink-dim">{i + 1}</span>
              <button
                type="button"
                role="checkbox"
                aria-checked={on}
                disabled={!personal}
                onClick={() => toggle(key)}
                className={
                  "flex min-h-[42px] min-w-0 flex-1 items-center gap-2.5 rounded-field border px-3 text-left text-[14px] transition-all duration-150 " +
                  (on
                    ? "border-brand/60 bg-brand-tint text-ink"
                    : "border-line bg-surface-input text-ink-muted hover:border-line-strong hover:text-ink")
                }
              >
                <Tick on={on} />
                <span className="truncate">{panelLabel(key)}</span>
              </button>
              <ArrowButton up label="Выше" disabled={!personal || i === 0} onClick={() => move(key, -1)} />
              <ArrowButton up={false} label="Ниже" disabled={!personal || i === columns.length - 1} onClick={() => move(key, 1)} />
            </li>
          );
        })}
      </ol>

      {money && (
        <div className="mt-4 sm:max-w-[560px]">
          <button
            type="button"
            role="checkbox"
            aria-checked={isShown(prefs, OVERDUE_KEY)}
            disabled={!personal}
            onClick={() => toggle(OVERDUE_KEY)}
            className={
              "flex min-h-[42px] w-full items-center gap-2.5 rounded-field border px-3 text-left text-[14px] transition-all duration-150 " +
              (isShown(prefs, OVERDUE_KEY)
                ? "border-brand/60 bg-brand-tint text-ink"
                : "border-line bg-surface-input text-ink-muted hover:border-line-strong hover:text-ink")
            }
          >
            <Tick on={isShown(prefs, OVERDUE_KEY)} />
            {panelLabel(OVERDUE_KEY)} над панелями
          </button>
          <p className="mt-1.5 text-[12.5px] text-ink-dim">
            Появляется, только когда клиент не заплатил к обещанной дате.
          </p>
        </div>
      )}

      {tuned && personal && (
        <button
          type="button"
          onClick={() => save({ ...prefs, panels: {} })}
          className="mt-4 text-[13px] font-semibold text-ink-muted hover:text-ink hover:underline"
        >
          Сбросить сортировку и фильтры всех панелей
        </button>
      )}
    </Card>
  );
}
