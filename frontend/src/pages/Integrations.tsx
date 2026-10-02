import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import qrcode from "qrcode-generator";
import { Modal } from "../components/Modal";
import { Panel } from "../components/Panel";
import { Banner, Button, Field, Input, PageHeader, Spinner, Textarea } from "../components/ui";
import { ApiError } from "../lib/api";
import { BASE } from "../lib/basePath";
import { formatDateTime } from "../lib/format";
import {
  SMS_APP_URL,
  smsApi,
  smsCounter,
  type GatewayDevice,
  type OnReady,
  type PairCode,
  type Provider,
  type SmsPhone,
  type SmsSettings,
} from "../lib/sms";

/**
 * «Настройки → Интеграции»: внешние сервисы мастерской. Пока одна панель —
 * SMS клиентам: со своего телефона (приложение «FineCRM SMS») или через
 * SemySMS. Выключили SMS — панель сворачивается в строку.
 */

const ON_READY: Array<{ id: OnReady; label: string; hint: string }> = [
  { id: "ask", label: "Спрашивать", hint: "после «Готов к выдаче» — окно с готовым текстом, можно поправить" },
  { id: "auto", label: "Отправлять сразу", hint: "SMS уходит клиенту сама, без вопросов" },
  { id: "off", label: "Не предлагать", hint: "только кнопкой «SMS» в заказе" },
];

const PROVIDERS: Array<{ id: Provider; label: string; hint: string }> = [
  {
    id: "phone",
    label: "Свой телефон",
    hint: "Android с приложением FineCRM SMS. Без сторонних сервисов, платите только оператору за SIM-карту",
  },
  { id: "semysms", label: "SemySMS", hint: "Их приложение на телефоне и их сервис — нужен токен из личного кабинета" },
];

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={
        "relative inline-flex h-[30px] w-[52px] shrink-0 items-center rounded-full transition-colors duration-150 disabled:opacity-50 " +
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
      {saved && <SmsPanel saved={saved} onSaved={setSaved} />}
    </div>
  );
}

const box = (on: boolean) =>
  "rounded-card border px-3.5 py-2.5 text-left transition-colors duration-150 " +
  (on ? "border-brand bg-brand-tint" : "border-line bg-surface-raised hover:border-line-strong");

function SmsPanel({ saved, onSaved }: { saved: SmsSettings; onSaved: (s: SmsSettings) => void }) {
  const [enabled, setEnabled] = useState(saved.enabled);
  const [expanded, setExpanded] = useState(saved.enabled);
  const [provider, setProvider] = useState<Provider>(saved.provider);
  const [replacing, setReplacing] = useState(!saved.hasToken);
  const [token, setToken] = useState("");
  const [device, setDevice] = useState(saved.device);
  const [deviceName, setDeviceName] = useState<string | null>(saved.deviceName);
  const [onReady, setOnReady] = useState<OnReady>(saved.onReady);
  const [ready, setReady] = useState(saved.templates.ready);
  const [devices, setDevices] = useState<GatewayDevice[] | null>(null);
  const [phones, setPhones] = useState<SmsPhone[] | null>(null);
  const [pairing, setPairing] = useState(false);
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

  const loadPhones = useCallback(() => smsApi.phones().then((r) => setPhones(r.phones)).catch(() => setPhones([])), []);
  useEffect(() => {
    void loadPhones();
    const t = setInterval(() => void loadPhones(), 20_000);
    return () => clearInterval(t);
  }, [loadPhones]);

  const body = (over: Partial<{ enabled: boolean }> = {}) => ({
    enabled,
    provider,
    ...(replacing && token.trim() ? { token: token.trim() } : {}),
    device,
    deviceName,
    onReady,
    templates: { ready },
    ...over,
  });

  const persist = async (over: Partial<{ enabled: boolean }> = {}) => {
    const next = await smsApi.save(body(over));
    onSaved(next);
    setEnabled(next.enabled);
    setToken("");
    setReplacing(!next.hasToken);
    return next;
  };

  /** Выключатель сохраняет сразу: выключили — панель сворачивается в строку. */
  const flip = (on: boolean) =>
    act("switch", async () => {
      if (!on) {
        await persist({ enabled: false });
        setExpanded(false);
        say("SMS выключены");
        return;
      }
      setExpanded(true);
      // SemySMS без токена включить нельзя — сначала токен, потом «Сохранить».
      if (provider === "semysms" && !saved.hasToken && !token.trim()) {
        setEnabled(true);
        setError("Вставьте токен SemySMS и нажмите «Сохранить»");
        return;
      }
      await persist({ enabled: true });
      say("SMS включены");
    });

  const save = () =>
    act("save", async () => {
      const next = await persist();
      say(next.enabled ? "Сохранено" : "Сохранено. SMS пока выключены");
    });

  const loadDevices = () =>
    act("devices", async () => {
      const r = await smsApi.devices(replacing && token.trim() ? token.trim() : undefined);
      setDevices(r.devices);
      if (!r.devices.length) setError("В SemySMS нет ни одного телефона — установите их приложение и добавьте телефон в личном кабинете");
    });

  const test = () =>
    act("test", async () => {
      const r = await smsApi.test(testPhone);
      if (r.status === "FAILED") setError(r.error ?? "SMS не отправлена");
      else say(provider === "phone" ? "Тестовая SMS ушла телефону-шлюзу — придёт через несколько секунд" : "Тестовая SMS передана SemySMS — придёт через несколько секунд");
    });

  const dirty =
    provider !== saved.provider ||
    (replacing && !!token.trim()) ||
    device !== saved.device ||
    onReady !== saved.onReady ||
    ready !== saved.templates.ready ||
    enabled !== saved.enabled;

  const online = phones?.filter((p) => p.online).length ?? 0;
  const summary = !saved.enabled
    ? "Выключено"
    : saved.provider === "phone"
      ? phones === null
        ? "Свой телефон"
        : phones.length === 0
          ? "Свой телефон · ни один не подключён"
          : `Свой телефон · на связи ${online} из ${phones.length}`
      : `SemySMS · ${saved.deviceName ?? "любой включённый телефон"}`;

  return (
    <Panel
      id="integrations:sms"
      title="SMS клиентам"
      summary={summary}
      open={expanded}
      onOpenChange={setExpanded}
      right={<Switch on={enabled} onChange={(v) => void flip(v)} label="SMS включены" disabled={busy === "switch"} />}
    >
      <div className="mt-3 space-y-5">
        {notice && <Banner>{notice}</Banner>}
        {error && <Banner tone="error">{error}</Banner>}

        <div>
          <span className="mb-1.5 block text-[13px] font-semibold text-ink-soft">Чем отправлять</span>
          <div className="grid gap-2 sm:grid-cols-2">
            {PROVIDERS.map((p) => (
              <button key={p.id} type="button" aria-pressed={provider === p.id} onClick={() => setProvider(p.id)} className={box(provider === p.id)}>
                <span className={"block text-[14.5px] font-semibold " + (provider === p.id ? "text-brand-ink" : "")}>{p.label}</span>
                <span className="mt-0.5 block text-[12.5px] text-ink-dim">{p.hint}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <div className="space-y-4">
            {provider === "phone" ? (
              <PhonesBlock phones={phones} onPair={() => setPairing(true)} onChanged={() => void loadPhones()} />
            ) : (
              <>
                <Field label="Токен API SemySMS" hint={replacing ? "Личный кабинет semysms.net → API" : "После сохранения токен не показывается целиком"}>
                  {replacing ? (
                    <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="например, 7c1d…e04f" />
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
                  <span className="mb-1.5 block text-[13px] font-semibold text-ink-soft">Телефон в SemySMS</span>
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
                          className={"flex w-full items-center gap-3 " + box(device === d.id)}
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
              </>
            )}

            <div>
              <span className="mb-1.5 block text-[13px] font-semibold text-ink-soft">Когда заказ готов к выдаче</span>
              <div className="grid gap-2 sm:grid-cols-3">
                {ON_READY.map((m) => (
                  <button key={m.id} type="button" aria-pressed={onReady === m.id} onClick={() => setOnReady(m.id)} className={box(onReady === m.id)}>
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
                <Input inputMode="tel" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} placeholder="Ваш номер: +7 921 123-45-67" />
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy === "test" || dirty || !saved.enabled || testPhone.replace(/\D/g, "").length < 10}
                  onClick={() => void test()}
                  className="shrink-0"
                >
                  {busy === "test" ? "Отправляем…" : "Тестовая SMS"}
                </Button>
              </div>
              <p className="mt-1.5 text-[12px] text-ink-dim">По сохранённым настройкам — сначала включите SMS и сохраните.</p>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2 border-t border-line pt-4 sm:flex-row-reverse">
          <Button type="button" disabled={busy === "save" || !dirty} onClick={() => void save()} className="sm:min-w-[200px]">
            {busy === "save" ? "Сохраняем…" : dirty ? "Сохранить" : "Всё сохранено"}
          </Button>
        </div>
      </div>

      {pairing && (
        <PairModal
          known={new Set((phones ?? []).map((p) => p.id))}
          onClose={() => setPairing(false)}
          onPaired={(name) => {
            setPairing(false);
            void loadPhones();
            say(`Телефон «${name}» подключён`);
          }}
        />
      )}
    </Panel>
  );
}

function PhonesBlock({ phones, onPair, onChanged }: { phones: SmsPhone[] | null; onPair: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div>
      <span className="mb-1.5 block text-[13px] font-semibold text-ink-soft">Телефоны-шлюзы</span>
      {phones === null ? (
        <Spinner />
      ) : phones.length === 0 ? (
        <p className="text-[13.5px] text-ink-dim">
          Пока ни одного. Подойдёт любой Android с SIM-картой — лучше отдельный, который лежит в мастерской на зарядке.
        </p>
      ) : (
        <div className="space-y-1.5">
          {phones.map((p) => (
            <div key={p.id} className="rounded-card border border-line bg-surface-raised px-3.5 py-2.5">
              <div className="flex items-center gap-3">
                <span className={"h-2 w-2 shrink-0 rounded-full " + (p.online ? "bg-state-done" : "bg-ink-dim")} />
                <span className="min-w-0 flex-1 text-[14px] font-semibold">{p.name}</span>
                <button
                  type="button"
                  disabled={busy === p.id}
                  onClick={() => {
                    setBusy(p.id);
                    void smsApi
                      .unpair(p.id)
                      .then(onChanged)
                      .finally(() => setBusy(null));
                  }}
                  className="text-[12.5px] font-semibold text-ink-muted hover:text-state-off"
                >
                  Отключить
                </button>
              </div>
              <p className="mt-1 text-[12.5px] text-ink-dim">
                {p.online ? "на связи" : p.lastSeenAt ? `не на связи · был ${formatDateTime(p.lastSeenAt)}` : "не на связи"}
                {p.battery !== null ? ` · батарея ${p.battery}%${p.charging ? ", заряжается" : ""}` : ""}
                {` · сегодня отправил ${p.sentToday}`}
              </p>
              {p.problems.length > 0 && <p className="mt-1 text-[12.5px] text-state-waiting">{p.problems.join("; ")}</p>}
            </div>
          ))}
        </div>
      )}
      <Button type="button" variant="secondary" className="mt-2.5" onClick={onPair}>
        Подключить телефон
      </Button>
    </div>
  );
}

const isLocal = (host: string) => host === "localhost" || host.startsWith("127.") || host === "[::1]";

/**
 * Подключение телефона: QR-код и 6 цифр. QR открывает в браузере телефона
 * страницу «/sms-phone» — с неё приложение запускается уже с адресом и кодом.
 * Окно само замечает новый телефон и закрывается.
 */
function PairModal({ known, onClose, onPaired }: { known: Set<string>; onClose: () => void; onPaired: (name: string) => void }) {
  const [pair, setPair] = useState<PairCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const qrRef = useRef<HTMLDivElement>(null);

  const get = useCallback(
    () =>
      smsApi
        .pair()
        .then(setPair)
        .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось получить код")),
    []
  );
  useEffect(() => {
    void get();
  }, [get]);

  // Куда стучаться телефону: у Основы — через интернет, если доступ включён;
  // иначе тот адрес, по которому открыта эта страница (если он не «этот компьютер»).
  const here = window.location.origin + BASE;
  const server = pair?.remote ?? (!isLocal(window.location.hostname) ? here : pair?.lan) ?? null;
  const link = pair && server ? `${server}sms-phone?c=${pair.code}&u=${encodeURIComponent(server)}` : null;

  useEffect(() => {
    if (!link || !qrRef.current) return;
    const qr = qrcode(0, "M");
    qr.addData(link);
    qr.make();
    qrRef.current.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 3, scalable: true });
  }, [link]);

  // Ждём, пока телефон подключится: новый в списке — готово.
  useEffect(() => {
    if (!pair) return;
    const t = setInterval(() => {
      void smsApi.phones().then((r) => {
        const fresh = r.phones.find((p) => !known.has(p.id));
        if (fresh) onPaired(fresh.name);
      });
    }, 3000);
    return () => clearInterval(t);
  }, [pair, known, onPaired]);

  return (
    <Modal title="Подключить телефон" onClose={onClose}>
      {error ? (
        <Banner tone="error">{error}</Banner>
      ) : !pair ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          <ol className="list-decimal space-y-1.5 pl-5 text-[14px] text-ink-soft">
            <li>
              Установите на телефон приложение{" "}
              <a href={SMS_APP_URL} className="font-semibold text-brand hover:text-brand-ink">
                FineCRM SMS
              </a>{" "}
              — файл скачается прямо на телефон.
            </li>
            <li>Наведите камеру телефона на QR-код и откройте ссылку — приложение подключится само.</li>
            <li>Или откройте приложение и введите адрес и код вручную.</li>
          </ol>
          {server ? (
            <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
              <div ref={qrRef} className="h-[190px] w-[190px] shrink-0 rounded-card bg-white p-1 [&>svg]:h-full [&>svg]:w-full" aria-label="QR-код подключения" />
              <div className="min-w-0 space-y-2 text-[14px]">
                <p>
                  <span className="text-ink-dim">Адрес: </span>
                  <span className="break-all font-mono font-semibold">{server}</span>
                </p>
                <p>
                  <span className="text-ink-dim">Код: </span>
                  <span data-testid="pair-code" className="font-mono text-[22px] font-extrabold tracking-[0.18em]">
                    {pair.code}
                  </span>
                </p>
                <p className="text-[12.5px] text-ink-dim">Код действует 10 минут, до {formatDateTime(pair.expiresAt)}.</p>
              </div>
            </div>
          ) : (
            <Banner tone="warning">
              Телефону некуда подключиться: страница открыта на самом компьютере Основы, а доступ из интернета не включён
              и раздача по сети тоже. Включите «Доступ из интернета» в настройках или откройте эту страницу с другого
              устройства в сети мастерской.
            </Banner>
          )}
          <p className="text-[12.5px] text-ink-dim">
            Телефон должен быть включён и в сети. При первом запуске приложение попросит разрешение на SMS и отключить для
            себя экономию батареи — без этого Android может его усыпить.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <Button type="button" variant="secondary" onClick={() => void get()} className="sm:flex-1">
              Новый код
            </Button>
            <Button type="button" variant="ghost" onClick={onClose} className="sm:flex-1">
              Закрыть
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
