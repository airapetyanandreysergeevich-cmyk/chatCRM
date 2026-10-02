import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Banner, Button, Card, Field, Input, PageHeader, SectionLabel, Spinner, Textarea } from "../components/ui";
import { ApiError } from "../lib/api";
import { smsApi, smsCounter, type GatewayDevice, type OnReady, type SmsSettings } from "../lib/sms";

/**
 * «Настройки → Интеграции»: внешние сервисы мастерской. Пока один — SMS
 * клиентам через SemySMS (телефон на Android с их приложением отправляет SMS
 * со своей SIM-карты).
 */

const ON_READY: Array<{ id: OnReady; label: string; hint: string }> = [
  { id: "ask", label: "Спрашивать", hint: "после «Готов к выдаче» — окно с готовым текстом, можно поправить" },
  { id: "auto", label: "Отправлять сразу", hint: "SMS уходит клиенту сама, без вопросов" },
  { id: "off", label: "Не предлагать", hint: "только кнопкой «SMS» в заказе" },
];

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={
        "relative inline-flex h-[30px] w-[52px] shrink-0 items-center rounded-full transition-colors duration-150 " +
        (on ? "bg-brand" : "bg-line-strong")
      }
    >
      <span
        className={
          "inline-block h-[24px] w-[24px] rounded-full bg-white shadow transition-transform duration-150 " +
          (on ? "translate-x-[25px]" : "translate-x-[3px]")
        }
      />
    </button>
  );
}

export default function IntegrationsPage() {
  const [saved, setSaved] = useState<SmsSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    smsApi
      .settings()
      .then(setSaved)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить настройки"));
  }, []);

  return (
    <div className="space-y-5">
      <Link to="/settings" className="text-[13.5px] font-semibold text-ink-muted hover:text-ink">
        ‹ Настройки
      </Link>
      <PageHeader eyebrow="Настройки" title="Интеграции" subtitle="Внешние сервисы, которые работают вместе с FineCRM." />
      {error && <Banner tone="error">{error}</Banner>}
      {!saved && !error && <Spinner />}
      {saved && <SmsCard saved={saved} onSaved={setSaved} />}
    </div>
  );
}

function SmsCard({ saved, onSaved }: { saved: SmsSettings; onSaved: (s: SmsSettings) => void }) {
  const [enabled, setEnabled] = useState(saved.enabled);
  const [replacing, setReplacing] = useState(!saved.hasToken);
  const [token, setToken] = useState("");
  const [device, setDevice] = useState(saved.device);
  const [deviceName, setDeviceName] = useState<string | null>(saved.deviceName);
  const [onReady, setOnReady] = useState<OnReady>(saved.onReady);
  const [ready, setReady] = useState(saved.templates.ready);
  const [devices, setDevices] = useState<GatewayDevice[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testPhone, setTestPhone] = useState("");

  const say = (text: string) => {
    setNotice(text);
    setTimeout(() => setNotice(null), 5000);
  };

  async function act(name: string, fn: () => Promise<void>) {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не получилось");
    } finally {
      setBusy(null);
    }
  }

  const loadDevices = () =>
    act("devices", async () => {
      const r = await smsApi.devices(replacing && token.trim() ? token.trim() : undefined);
      setDevices(r.devices);
      if (!r.devices.length) setError("В SemySMS нет ни одного телефона — установите их приложение и добавьте телефон в личном кабинете");
    });

  const save = () =>
    act("save", async () => {
      const next = await smsApi.save({
        enabled,
        ...(replacing && token.trim() ? { token: token.trim() } : {}),
        device,
        deviceName,
        onReady,
        templates: { ready },
      });
      onSaved(next);
      setToken("");
      setReplacing(!next.hasToken);
      say(next.enabled ? "Сохранено. SMS включены" : "Сохранено");
    });

  const test = () =>
    act("test", async () => {
      const r = await smsApi.test(testPhone);
      if (r.status === "FAILED") setError(r.error ?? "SMS не отправлена");
      else say("Тестовая SMS передана телефону-шлюзу — придёт через несколько секунд");
    });

  const dirty =
    enabled !== saved.enabled ||
    (replacing && !!token.trim()) ||
    device !== saved.device ||
    onReady !== saved.onReady ||
    ready !== saved.templates.ready;

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <SectionLabel>SMS клиентам · SemySMS</SectionLabel>
          <p className="mt-2 max-w-[640px] text-[13.5px] text-ink-dim">
            SMS уходят с SIM-карты вашего телефона на Android по тарифу оператора: на телефоне стоит приложение
            SemySMS, оно и отправляет. Регистрация и токен — на{" "}
            <a href="https://semysms.net/" target="_blank" rel="noreferrer" className="font-semibold text-brand hover:text-brand-ink">
              semysms.net
            </a>
            , раздел API в личном кабинете.
          </p>
        </div>
        <Switch on={enabled} onChange={setEnabled} label="SMS включены" />
      </div>

      {notice && <div className="mt-4"><Banner>{notice}</Banner></div>}
      {error && <div className="mt-4"><Banner tone="error">{error}</Banner></div>}

      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <div className="space-y-4">
          <Field label="Токен API" hint={replacing ? "Скопируйте из личного кабинета SemySMS → API" : "После сохранения токен не показывается целиком"}>
            {replacing ? (
              <Input
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="например, 7c1d…e04f"
              />
            ) : (
              <div className="flex items-center gap-2">
                <span className="flex min-h-[46px] flex-1 items-center rounded-field border border-line bg-surface-input px-3.5 font-mono text-[14.5px]">
                  {saved.tokenHint}
                </span>
                <Button type="button" variant="secondary" onClick={() => setReplacing(true)}>
                  Заменить
                </Button>
              </div>
            )}
          </Field>

          <div>
            <span className="mb-1.5 block text-[13px] font-semibold text-ink-soft">Телефон-шлюз</span>
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 text-[14px]">
                {device === "active" ? "Любой включённый телефон" : (deviceName ?? `Телефон ${device}`)}
              </span>
              <Button
                type="button"
                variant="secondary"
                disabled={busy === "devices" || (!saved.hasToken && !token.trim())}
                onClick={() => void loadDevices()}
              >
                {busy === "devices" ? "Проверяем…" : "Проверить подключение"}
              </Button>
            </div>
            {devices && devices.length > 0 && (
              <div className="mt-2.5 space-y-1.5">
                {[{ id: "active", name: "Любой включённый", online: true, battery: null, lastActive: null } as GatewayDevice, ...devices].map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    aria-pressed={device === d.id}
                    onClick={() => {
                      setDevice(d.id);
                      setDeviceName(d.id === "active" ? null : d.name);
                    }}
                    className={
                      "flex w-full items-center gap-3 rounded-field border px-3.5 py-2.5 text-left transition-colors duration-150 " +
                      (device === d.id ? "border-brand bg-brand-tint" : "border-line bg-surface-raised hover:border-line-strong")
                    }
                  >
                    <span className={"h-2 w-2 shrink-0 rounded-full " + (d.online ? "bg-state-done" : "bg-ink-dim")} />
                    <span className="min-w-0 flex-1 text-[14px] font-semibold">{d.name}</span>
                    {d.id !== "active" && (
                      <span className="text-[12.5px] text-ink-dim">
                        {d.online ? "на связи" : "не на связи"}
                        {d.battery !== null ? ` · батарея ${d.battery}%` : ""}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div>
            <span className="mb-1.5 block text-[13px] font-semibold text-ink-soft">Когда заказ готов к выдаче</span>
            <div className="grid gap-2 sm:grid-cols-3">
              {ON_READY.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={onReady === m.id}
                  onClick={() => setOnReady(m.id)}
                  className={
                    "rounded-card border px-3.5 py-2.5 text-left transition-colors duration-150 " +
                    (onReady === m.id ? "border-brand bg-brand-tint" : "border-line bg-surface-raised hover:border-line-strong")
                  }
                >
                  <span className={"block text-[14px] font-semibold " + (onReady === m.id ? "text-brand-ink" : "")}>{m.label}</span>
                  <span className="mt-0.5 block text-[12px] text-ink-dim">{m.hint}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <Field label="Текст «Готов к выдаче»" hint={smsCounter(ready)}>
            <Textarea value={ready} maxLength={1000} onChange={(e) => setReady(e.target.value)} />
          </Field>
          <div className="-mt-2 flex flex-wrap items-center gap-1.5">
            {saved.placeholders.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setReady((t) => (t.endsWith(" ") || !t ? t : t + " ") + p)}
                className="rounded-pill border border-line bg-surface-raised px-2.5 py-1 font-mono text-[12px] text-ink-muted hover:text-ink"
              >
                {p}
              </button>
            ))}
            {ready !== saved.defaults.ready && (
              <button type="button" onClick={() => setReady(saved.defaults.ready)} className="px-2 text-[12.5px] font-semibold text-brand hover:text-brand-ink">
                Вернуть стандартный
              </button>
            )}
          </div>
          <p className="text-[12.5px] text-ink-dim">
            Подставится: {"{клиент}"} — имя клиента, {"{техника}"} — «ноутбук Lenovo G580», {"{номер}"} — номер заказа,{" "}
            {"{сумма}"} — сколько осталось заплатить, {"{мастерская}"} — название с бланков. Одна SMS на русском — 70
            знаков; длиннее склеивается из частей, каждая оплачивается отдельно.
          </p>

          <div className="rounded-card border border-line bg-surface-raised p-3.5">
            <span className="mb-1.5 block text-[13px] font-semibold text-ink-soft">Проверка</span>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                inputMode="tel"
                value={testPhone}
                onChange={(e) => setTestPhone(e.target.value)}
                placeholder="Ваш номер: +7 921 123-45-67"
              />
              <Button
                type="button"
                variant="secondary"
                disabled={busy === "test" || !saved.hasToken || testPhone.replace(/\D/g, "").length < 10}
                onClick={() => void test()}
                className="shrink-0"
              >
                {busy === "test" ? "Отправляем…" : "Тестовая SMS"}
              </Button>
            </div>
            <p className="mt-1.5 text-[12px] text-ink-dim">По сохранённым настройкам — сначала сохраните токен.</p>
          </div>
        </div>
      </div>

      <div className="mt-5 flex flex-col gap-2 border-t border-line pt-4 sm:flex-row-reverse">
        <Button type="button" disabled={busy === "save" || !dirty} onClick={() => void save()} className="sm:min-w-[200px]">
          {busy === "save" ? "Сохраняем…" : dirty ? "Сохранить" : "Всё сохранено"}
        </Button>
      </div>
    </Card>
  );
}
