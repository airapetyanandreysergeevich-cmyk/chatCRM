import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import { KEEP_OPTIONS, callsApi, type CallSettings } from "../lib/calls";
import { formatDateTime, plural } from "../lib/format";
import { smsApi, type SmsPhone, SMS_APP_URL } from "../lib/sms";
import { Panel } from "./Panel";
import { Banner, Spinner } from "./ui";
import { Switch } from "../pages/Integrations";

/**
 * «Настройки → Интеграции → Звонки клиентов» (28.10.2026).
 *
 * Тот же телефон, что для SMS, — приложение «FineCRM Телефон» 1.3+. Каждая
 * правка сохраняется сразу, как выключатели SMS. Ниже — что узнал о себе
 * каждый телефон: разрешения, где нашлась запись разговоров или как её
 * включить именно на этой модели.
 */
export function CallsPanel() {
  const [s, setS] = useState<CallSettings | null>(null);
  const [month, setMonth] = useState<{ total: number; withAudio: number } | null>(null);
  const [lastAt, setLastAt] = useState<string | null>(null);
  const [phones, setPhones] = useState<SmsPhone[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<boolean | undefined>(undefined);

  const load = useCallback(() => {
    callsApi
      .settings()
      .then((r) => {
        setS(r.settings);
        setMonth(r.month);
        setLastAt(r.lastAt);
        setOpen((o) => (o === undefined ? r.settings.enabled : o));
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Не удалось загрузить настройки звонков"));
    smsApi
      .phones()
      .then((r) => setPhones(r.phones))
      .catch(() => setPhones([]));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);

  const save = (next: CallSettings) => {
    setBusy(true);
    setError(null);
    setS(next);
    callsApi
      .save(next)
      .then((r) => setS(r.settings))
      .catch((e) => setError(e instanceof ApiError ? e.message : "Не сохранилось"))
      .finally(() => setBusy(false));
  };

  if (!s) return error ? <Banner tone="error">{error}</Banner> : <Spinner />;

  const summary = !s.enabled
    ? "Выключено"
    : `Включено${s.audio ? " · с записями разговоров" : " · без записей"}${month ? ` · за 30 дней ${plural(month.total, "звонок", "звонка", "звонков")}` : ""}`;

  return (
    <Panel
      id="integrations:calls"
      title="Звонки клиентов"
      summary={summary}
      open={open ?? false}
      onOpenChange={setOpen}
      right={
        <Switch
          on={s.enabled}
          label="Звонки включены"
          disabled={busy}
          onChange={(v) => {
            save({ ...s, enabled: v });
            setOpen(v);
          }}
        />
      }
    >
      <div className="mt-3 space-y-5" data-calls-panel>
        {error && <Banner tone="error">{error}</Banner>}
        <p className="text-[13px] text-ink-dim">
          Звонки с телефона мастерской (того же, что отправляет SMS) попадают в историю ремонта заказа этого клиента, а если
          заказа в работе нет — в карточку клиента. Звонки с номеров, которых нет в клиентах, никуда не уходят и остаются на
          телефоне. Разговор записывает встроенная «звонилка» телефона, приложение «FineCRM Телефон» только забирает запись.
        </p>

        <div className="grid gap-5 lg:grid-cols-2">
          <div className="space-y-3">
            <Row
              title="Присылать записи разговоров"
              hint="Слушают сотрудники с правом «Слушает записи звонков» (по умолчанию — управляющий и приёмщик)."
              on={s.audio}
              disabled={busy}
              onChange={(v) => save({ ...s, audio: v })}
              data="audio"
            />
            <Row
              title="Пропущенные звонки"
              hint="Строкой в истории и оповещением мастеру заказа — кому перезвонить."
              on={s.missed}
              disabled={busy}
              onChange={(v) => save({ ...s, missed: v })}
              data="missed"
            />
            <div>
              <span className="mb-1.5 block text-[13px] font-semibold text-ink-soft">Хранить записи</span>
              <div className="flex gap-1.5" data-calls-keep>
                {KEEP_OPTIONS.map((o) => (
                  <button
                    key={o.days}
                    type="button"
                    role="radio"
                    aria-checked={s.keepDays === o.days}
                    disabled={busy}
                    onClick={() => save({ ...s, keepDays: o.days })}
                    data-days={o.days}
                    className={
                      "min-h-[38px] flex-1 rounded-field border px-3 text-[13.5px] font-semibold transition-colors " +
                      (s.keepDays === o.days ? "border-brand bg-brand-tint text-brand-ink" : "border-line text-ink-muted hover:text-ink")
                    }
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[12px] text-ink-dim">
                Старые записи удаляются, сам звонок в истории остаётся. Записи лежат там же, где фотографии заказов, — и
                попадают в резервные копии вместе с ними.
              </p>
            </div>
            {month && (
              <p className="text-[12.5px] text-ink-dim" data-calls-month>
                За 30 дней: {plural(month.total, "звонок", "звонка", "звонков")}, с записью — {month.withAudio}
                {lastAt ? ` · последний ${formatDateTime(lastAt)}` : ""}
              </p>
            )}
          </div>

          <div>
            <span className="mb-1.5 block text-[13px] font-semibold text-ink-soft">Телефоны</span>
            {phones === null ? (
              <Spinner />
            ) : phones.length === 0 ? (
              <p className="text-[13.5px] text-ink-dim">
                Телефон не подключён. Подключите его в панели «SMS клиентам» выше — тот же телефон будет присылать и звонки.
              </p>
            ) : (
              <div className="space-y-1.5">
                {phones.map((p) => (
                  <PhoneCalls key={p.id} p={p} />
                ))}
              </div>
            )}
          </div>
        </div>

        <p className="rounded-card border border-line bg-surface-raised px-3.5 py-2.5 text-[12.5px] text-ink-soft">
          Запись голоса клиента — его персональные данные. Предупредите клиентов, что разговоры могут записываться: например,
          строкой на квитанции («Настройки → Бланки»).
        </p>
      </div>
    </Panel>
  );
}

function Row({ title, hint, on, disabled, onChange, data }: { title: string; hint: string; on: boolean; disabled: boolean; onChange: (v: boolean) => void; data: string }) {
  return (
    <div className="flex items-start gap-3" data-calls-option={data}>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold">{title}</p>
        <p className="text-[12.5px] text-ink-dim">{hint}</p>
      </div>
      <Switch on={on} onChange={onChange} label={title} disabled={disabled} />
    </div>
  );
}

const ok = (v: boolean | null | undefined) => (v === true ? "✓" : v === false ? "нет" : "—");

function PhoneCalls({ p }: { p: SmsPhone }) {
  const old = !p.calls;
  const c = p.calls;
  const found = !!c?.folder;
  return (
    <div className="rounded-card border border-line bg-surface-raised px-3.5 py-2.5" data-calls-phone={p.name}>
      <div className="flex items-center gap-3">
        <span className={"h-2 w-2 shrink-0 rounded-full " + (p.online ? "bg-state-done" : "bg-ink-dim")} />
        <span className="min-w-0 flex-1 text-[14px] font-semibold">{p.name}</span>
        {c?.brand && <span className="shrink-0 text-[12px] text-ink-dim">{c.brand}</span>}
      </div>
      {old ? (
        <p className="mt-1 text-[12.5px] text-state-waiting">
          Приложение {p.appVersion ?? "старой версии"} звонки не присылает — обновите его до 1.3:{" "}
          <a href={SMS_APP_URL} className="font-semibold text-brand-ink hover:underline">
            скачать
          </a>
          .
        </p>
      ) : (
        <>
          <p className="mt-1 text-[12.5px] text-ink-dim">
            журнал звонков {ok(c!.log)} · доступ к записям {ok(c!.audio)}
          </p>
          {found ? (
            <p className="mt-1 text-[12.5px] text-state-done" data-calls-found>
              Записи разговоров находятся: {c!.folder}
              {c!.lastRecordAt ? ` · последняя ${formatDateTime(new Date(c!.lastRecordAt).toISOString())}` : ""}
            </p>
          ) : (
            <p className="mt-1 text-[12.5px] text-state-waiting" data-calls-howto>
              Записей разговоров пока не видно.{c!.howTo ? ` ${c!.howTo}` : " Включите автоматическую запись вызовов в настройках «Телефона» и сделайте пробный звонок."}
            </p>
          )}
        </>
      )}
    </div>
  );
}
