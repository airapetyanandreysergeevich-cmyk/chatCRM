import { Panel } from "../components/Panel";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { PrinterPicker } from "../components/PrinterPicker";
import { Banner, Button, PageHeader, Spinner } from "../components/ui";
import { ApiError } from "../lib/api";
import { formatDateTime } from "../lib/format";
import {
  printBridge,
  printingApi,
  targetLabel,
  type IntakeMode,
  type PrintingOverview,
  type Target,
  type TargetView,
} from "../lib/printing";

/**
 * «Настройки → Периферия»: принтеры.
 *
 * Печатает компьютер мастерской с программой FineCRM, а нажать «Печать»
 * можно откуда угодно — с телефона тоже. Общий принтер назначает
 * администратор, свой — любой сотрудник для себя.
 */

const INTAKE: Array<{ id: IntakeMode; label: string; hint: string }> = [
  { id: "ask", label: "Спрашивать", hint: "после «Принять в ремонт» — окно «Распечатать квитанцию?»" },
  { id: "auto", label: "Печатать сразу", hint: "квитанция уходит на принтер без вопросов" },
  { id: "off", label: "Не предлагать", hint: "печать только кнопкой «Квитанция» в заказе" },
];

function Row({ title, hint, children, actions }: { title: string; hint: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-t border-line py-4 first:border-t-0 first:pt-0 last:pb-0 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold">{title}</p>
        <p className="mt-0.5 text-[13px] text-ink-dim">{hint}</p>
        <div className="mt-2">{children}</div>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

function Assigned({ t, empty }: { t: TargetView | null; empty: string }) {
  if (!t) return <span className="text-[14px] text-ink-muted">{empty}</span>;
  return (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[14px]">
      <span className={"h-2 w-2 shrink-0 rounded-full " + (t.online ? "bg-state-done" : "bg-ink-dim")} />
      <span className="font-semibold">{targetLabel(t)}</span>
      <span className="text-ink-dim">
        {t.copies === 2 ? "2 копии" : "1 копия"}
        {t.stationGone
          ? " · компьютер убран — назначьте заново"
          : t.printerGone
            ? " · Windows больше не видит этот принтер"
            : t.online
              ? ""
              : " · компьютер не на связи"}
      </span>
    </span>
  );
}

export default function PeripheralsPage() {
  const [data, setData] = useState<PrintingOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [picking, setPicking] = useState<"workshop" | "mine" | null>(null);
  const here = !!printBridge();
  const [thisPc, setThisPc] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await printingApi.overview());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить принтеры");
    }
  }, []);

  useEffect(() => {
    void load();
    // Пока страница открыта, компьютеры могут появиться и пропасть.
    const t = setInterval(() => void load(), 20_000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    void printBridge()
      ?.info()
      .then((i) => i.ok && setThisPc(i.name ?? null))
      .catch(() => undefined);
  }, []);

  async function act(fn: () => Promise<unknown>, message: string) {
    setError(null);
    try {
      await fn();
      await load();
      setNotice(message);
      setTimeout(() => setNotice(null), 4000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не получилось");
    }
  }

  if (!data) return error ? <Banner tone="error">{error}</Banner> : <Spinner label="Ищем принтеры" />;

  const saveTarget = async (t: Target) => {
    if (picking === "workshop") await printingApi.setWorkshop(t);
    else await printingApi.setMine({ documents: t });
    setPicking(null);
    await load();
    setNotice(picking === "workshop" ? "Принтер мастерской назначен" : "Свой принтер выбран");
    setTimeout(() => setNotice(null), 4000);
  };

  return (
    <div className="space-y-5">
      <Link to="/settings" className="text-[13.5px] font-semibold text-ink-muted hover:text-ink">
        ‹ Настройки
      </Link>

      <PageHeader
        eyebrow="Настройки"
        title="Периферия"
        subtitle="Печатает компьютер мастерской с программой FineCRM — а нажать «Печать» можно с любого телефона и компьютера."
      />

      {notice && <Banner>{notice}</Banner>}
      {error && <Banner tone="error">{error}</Banner>}

      {here && thisPc && (
        <Banner>
          Этот компьютер — «{thisPc}» — печатает задания мастерской на свои принтеры, пока открыта программа FineCRM и
          выполнен вход.
        </Banner>
      )}
      {data.stations.length === 0 && (
        <Banner tone="warning">
          Принтеров пока нет. Запустите программу FineCRM для Windows (версия 0.1.30 или новее) на компьютере, к которому
          подключён принтер, и войдите в неё — принтеры этого компьютера появятся здесь в течение минуты.
        </Banner>
      )}

      <Panel id="peripherals:Принтеры" title="Принтеры">
        <div className="mt-4">
          <Row
            title="Принтер для документов"
            hint="Квитанции и акты, A4. Общий для всех сотрудников по умолчанию."
            actions={
              data.canManage && (
                <>
                  <Button type="button" variant="secondary" onClick={() => setPicking("workshop")}>
                    {data.workshop ? "Изменить" : "Назначить"}
                  </Button>
                  {data.workshop && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => void act(() => printingApi.setWorkshop(null), "Принтер мастерской снят")}
                    >
                      Снять
                    </Button>
                  )}
                </>
              )
            }
          >
            <Assigned t={data.workshop} empty={data.canManage ? "Не назначен" : "Не назначен — его назначает администратор"} />
          </Row>

          {data.personal && (
            <Row
              title="Мой принтер"
              hint="Только для вас: например, принтер у вашего рабочего места. Остальным это не меняет ничего."
              actions={
                <>
                  <Button type="button" variant="secondary" onClick={() => setPicking("mine")}>
                    {data.mine ? "Изменить" : "Выбрать свой"}
                  </Button>
                  {data.mine && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => void act(() => printingApi.setMine({ documents: null }), "Печатаете на принтер мастерской")}
                    >
                      Вернуть общий
                    </Button>
                  )}
                </>
              }
            >
              <Assigned t={data.mine} empty="Общий принтер мастерской" />
            </Row>
          )}

          <Row title="Принтер этикеток" hint="Наклейки на технику со штрихкодом заказа.">
            <span className="text-[14px] text-ink-dim">Появится позже</span>
          </Row>
        </div>
      </Panel>

      {data.personal && (
        <Panel id="peripherals:После приёма техники" title="После приёма техники">
          <p className="mt-2 text-[13px] text-ink-dim">Ваша настройка: что делать с квитанцией, когда заказ принят.</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            {INTAKE.map((m) => (
              <button
                key={m.id}
                type="button"
                aria-pressed={data.intake === m.id}
                onClick={() => void act(() => printingApi.setMine({ intake: m.id }), "Сохранено")}
                className={
                  "rounded-card border px-4 py-3 text-left transition-colors duration-150 " +
                  (data.intake === m.id ? "border-brand bg-brand-tint" : "border-line bg-surface-raised hover:border-line-strong")
                }
              >
                <span className={"block text-[14px] font-semibold " + (data.intake === m.id ? "text-brand-ink" : "")}>
                  {m.label}
                </span>
                <span className="mt-0.5 block text-[12.5px] text-ink-dim">{m.hint}</span>
              </button>
            ))}
          </div>
        </Panel>
      )}

      {data.stations.length > 0 && (
        <Panel id="peripherals:Компьютеры с принтерами" title="Компьютеры с принтерами">
          <div className="mt-3">
            {data.stations.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-3 border-t border-line py-3 first:border-t-0">
                <span className={"h-2 w-2 shrink-0 rounded-full " + (s.online ? "bg-state-done" : "bg-ink-dim")} />
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-semibold">
                    {s.name}
                    {thisPc === s.name && here && <span className="font-normal text-ink-dim"> — этот компьютер</span>}
                  </p>
                  <p className="text-[12.5px] text-ink-dim">
                    {s.online ? "на связи" : `не на связи · был ${formatDateTime(s.lastSeenAt)}`} ·{" "}
                    {s.printers.length ? s.printers.map((p) => p.displayName).join(", ") : "принтеров нет"}
                  </p>
                </div>
                {data.canManage && !s.online && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => void act(() => printingApi.removeStation(s.id), `«${s.name}» убран из списка`)}
                  >
                    Убрать
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {picking && (
        <PrinterPicker
          title={picking === "workshop" ? "Принтер для документов" : "Мой принтер"}
          stations={data.stations}
          current={picking === "workshop" ? data.workshop : data.mine}
          onSave={saveTarget}
          onReload={() => void load()}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}
