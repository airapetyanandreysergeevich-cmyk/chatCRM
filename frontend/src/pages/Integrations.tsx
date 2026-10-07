import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import qrcode from "qrcode-generator";
import { Modal } from "../components/Modal";
import { Panel } from "../components/Panel";
import { Banner, Button, Field, Input, PageHeader, Select, Spinner, Textarea } from "../components/ui";
import { ApiError } from "../lib/api";
import { BASE } from "../lib/basePath";
import { formatDateTime } from "../lib/format";
import {
  SMS_APP_URL,
  forgetSmsStatus,
  smsApi,
  smsCounter,
  type ApprovalConfig,
  type OnReady,
  type PairCode,
  type SmsPhone,
  type SmsSettings,
  type TemplateKey,
} from "../lib/sms";
import { ordersApi, type OrderStatus } from "../lib/orders";

/**
 * «Настройки → Интеграции»: внешние сервисы мастерской. Пока одна панель —
 * SMS клиентам со своего телефона (приложение «FineCRM SMS») и согласование
 * по SMS. Выключили SMS — панель сворачивается в строку.
 */

const ON_READY: Array<{ id: OnReady; label: string; hint: string }> = [
  { id: "ask", label: "Спрашивать", hint: "после «Готов к выдаче» — окно с готовым текстом, можно поправить" },
  { id: "auto", label: "Отправлять сразу", hint: "SMS уходит клиенту сама, без вопросов" },
  { id: "off", label: "Не предлагать", hint: "только кнопкой «SMS» в заказе" },
];

const ON_WAITING: Array<{ id: OnReady; label: string; hint: string }> = [
  { id: "ask", label: "Спрашивать", hint: "окно с готовым вопросом клиенту, можно поправить" },
  { id: "auto", label: "Отправлять сразу", hint: "вопрос уходит клиенту сам" },
  { id: "off", label: "Не предлагать", hint: "только из меню заказа и карточки" },
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
  const [onReady, setOnReady] = useState<OnReady>(saved.onReady);
  const [templates, setTemplates] = useState<Record<TemplateKey, string>>(saved.templates);
  const [approval, setApproval] = useState<ApprovalConfig>(saved.approval);
  const [statuses, setStatuses] = useState<OrderStatus[]>([]);
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
  useEffect(() => {
    ordersApi
      .reference()
      .then((r) => setStatuses(r.statuses))
      .catch(() => setStatuses([]));
  }, []);

  const body = (over: Partial<{ enabled: boolean; approval: ApprovalConfig }> = {}) => ({
    enabled,
    onReady,
    templates,
    approval,
    ...over,
  });

  const persist = async (over: Partial<{ enabled: boolean; approval: ApprovalConfig }> = {}) => {
    const next = await smsApi.save(body(over));
    onSaved(next);
    setEnabled(next.enabled);
    setApproval(next.approval);
    // Меню заказов спросит заново: «Согласовать по SMS» появляется и пропадает с настройкой.
    forgetSmsStatus();
    return next;
  };

  /** Выключатель сохраняет сразу: выключили — панель сворачивается в строку. */
  const flip = (on: boolean) =>
    act("switch", async () => {
      await persist({ enabled: on });
      setExpanded(on);
      say(on ? "SMS включены" : "SMS выключены");
    });

  /** Выключатель согласования — тоже сразу, как и главный. */
  const flipApproval = (on: boolean) =>
    act("approval", async () => {
      await persist({ approval: { ...approval, enabled: on } });
      say(on ? "Согласование по SMS включено" : "Согласование по SMS выключено");
    });

  const save = () =>
    act("save", async () => {
      const next = await persist();
      say(next.enabled ? "Сохранено" : "Сохранено. SMS пока выключены");
    });

  const test = () =>
    act("test", async () => {
      const r = await smsApi.test(testPhone);
      if (r.status === "FAILED") setError(r.error ?? "SMS не отправлена");
      else say("Тестовая SMS ушла телефону-шлюзу — придёт через несколько секунд");
    });

  const setTemplate = (k: TemplateKey) => (v: string) => setTemplates((t) => ({ ...t, [k]: v }));
  const dirty =
    onReady !== saved.onReady ||
    enabled !== saved.enabled ||
    (Object.keys(templates) as TemplateKey[]).some((k) => templates[k] !== saved.templates[k]) ||
    JSON.stringify(approval) !== JSON.stringify(saved.approval);

  const online = phones?.filter((p) => p.online).length ?? 0;
  const summary = !saved.enabled
    ? "Выключено"
    : (phones === null
        ? "Свой телефон"
        : phones.length === 0
          ? "Ни один телефон не подключён"
          : `Телефонов на связи: ${online} из ${phones.length}`) + (saved.approval.enabled ? " · согласование по SMS" : "");

  const waiting = statuses.filter((x) => x.group === "WAITING");
  const working = statuses.filter((x) => x.group === "IN_PROGRESS" || x.group === "NEW");
  const autoWaiting = waiting.find((x) => /соглас/i.test(x.name)) ?? waiting[0];
  const autoYes = statuses.find((x) => x.group === "IN_PROGRESS");

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

        <p className="text-[13px] text-ink-dim">
          SMS уходят с вашего телефона на Android с приложением FineCRM SMS — без сторонних сервисов, платите только
          оператору за SIM-карту.
        </p>

        <div className="grid gap-5 lg:grid-cols-2">
          <div className="space-y-4">
            <PhonesBlock phones={phones} onPair={() => setPairing(true)} onChanged={() => void loadPhones()} />

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
            <TemplateField
              label="Текст «Готов к выдаче»"
              value={templates.ready}
              fallback={saved.defaults.ready}
              placeholders={saved.placeholders.filter((p) => p !== "{стоимость}" && p !== "{работы}")}
              onChange={setTemplate("ready")}
            />
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

        <section className="rounded-panel border border-line p-4" aria-label="Согласование по SMS">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-[15px] font-bold">Согласование по SMS</h3>
              <p className="mt-0.5 max-w-[640px] text-[12.5px] text-ink-dim">
                Клиент получает вопрос с ценой и отвечает на SMS «да» или «нет». Ответ приходит в заказ: «да» — заказ сам
                переходит дальше, «нет» — остаётся с пометкой, непонятный ответ — решаете вы. Нужно приложение FineCRM SMS
                1.2 или новее с разрешением читать SMS: оно пересылает только ответы клиентов, которых спросили.
              </p>
            </div>
            <Switch on={approval.enabled} onChange={(v) => void flipApproval(v)} label="Согласование по SMS" disabled={busy === "approval" || !enabled} />
          </div>

          {approval.enabled && (
            <div className="mt-4 grid gap-5 lg:grid-cols-2">
              <div className="space-y-4">
                <div>
                  <span className="mb-1.5 block text-[13px] font-semibold text-ink-soft">Когда заказ переводят на согласование</span>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {ON_WAITING.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        aria-pressed={approval.onWaiting === m.id}
                        onClick={() => setApproval((a) => ({ ...a, onWaiting: m.id }))}
                        className={box(approval.onWaiting === m.id)}
                      >
                        <span className={"block text-[14px] font-semibold " + (approval.onWaiting === m.id ? "text-brand-ink" : "")}>{m.label}</span>
                        <span className="mt-0.5 block text-[12px] text-ink-dim">{m.hint}</span>
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Статус «на согласовании»" hint="В него переводят перед вопросом клиенту">
                    <Select
                      aria-label="Статус на согласовании"
                      value={approval.statusId ?? ""}
                      onChange={(e) => setApproval((a) => ({ ...a, statusId: e.target.value || null }))}
                    >
                      <option value="">{autoWaiting ? `Сам: ${autoWaiting.name}` : "Сам"}</option>
                      {waiting.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Если клиент согласен" hint="В этот статус заказ перейдёт сам">
                    <Select
                      aria-label="Статус при согласии"
                      value={approval.yesStatusId ?? ""}
                      onChange={(e) => setApproval((a) => ({ ...a, yesStatusId: e.target.value || null }))}
                    >
                      <option value="">{autoYes ? `Сам: ${autoYes.name}` : "Сам"}</option>
                      {working.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              </div>
              <div className="space-y-4">
                <TemplateField
                  label="Вопрос клиенту"
                  value={templates.approval}
                  fallback={saved.defaults.approval}
                  placeholders={saved.placeholders}
                  onChange={setTemplate("approval")}
                />
                <p className="-mt-2 text-[12.5px] text-ink-dim">
                  {"{работы}"} — работы и запчасти из заказа через запятую, {"{стоимость}"} — их сумма (пока их нет —
                  предварительная оценка с приёма).
                </p>
                <ReplyField
                  label="Ответ, если согласен"
                  on={approval.replyYes}
                  onToggle={(v) => setApproval((a) => ({ ...a, replyYes: v }))}
                  value={templates.approvalYes}
                  fallback={saved.defaults.approvalYes}
                  onChange={setTemplate("approvalYes")}
                />
                <ReplyField
                  label="Ответ, если отказался"
                  on={approval.replyNo}
                  onToggle={(v) => setApproval((a) => ({ ...a, replyNo: v }))}
                  value={templates.approvalNo}
                  fallback={saved.defaults.approvalNo}
                  onChange={setTemplate("approvalNo")}
                />
                <p className="text-[12.5px] text-ink-dim">
                  Согласием считаются «да», «ок», «согласен», «+», «1» и похожие; отказом — «нет», «не надо», «−», «0». Ответ с
                  вопросом («да, а сколько по времени?») решаете вы. Ответа ждём 3 дня.
                </p>
              </div>
            </div>
          )}
        </section>

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

function TemplateField({
  label,
  value,
  fallback,
  placeholders,
  onChange,
}: {
  label: string;
  value: string;
  fallback: string;
  placeholders: string[];
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <Field label={label} hint={smsCounter(value)}>
        <Textarea value={value} maxLength={1000} onChange={(e) => onChange(e.target.value)} />
      </Field>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {placeholders.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onChange((value.endsWith(" ") || !value ? value : value + " ") + p)}
            className="rounded-pill border border-line bg-surface-raised px-2.5 py-1 font-mono text-[12px] text-ink-muted hover:text-ink"
          >
            {p}
          </button>
        ))}
        {value !== fallback && (
          <button type="button" onClick={() => onChange(fallback)} className="px-2 text-[12.5px] font-semibold text-brand hover:text-brand-ink">
            Вернуть стандартный
          </button>
        )}
      </div>
    </div>
  );
}

function ReplyField({
  label,
  on,
  onToggle,
  value,
  fallback,
  onChange,
}: {
  label: string;
  on: boolean;
  onToggle: (v: boolean) => void;
  value: string;
  fallback: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <span className="text-[13px] font-semibold text-ink-soft">{label}</span>
        <Switch on={on} onChange={onToggle} label={label} />
      </div>
      {on ? (
        <>
          <Textarea aria-label={label} value={value} maxLength={1000} onChange={(e) => onChange(e.target.value)} />
          <p className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-ink-dim">
            <span>{smsCounter(value)}</span>
            {value !== fallback && (
              <button type="button" onClick={() => onChange(fallback)} className="font-semibold text-brand hover:text-brand-ink">
                Вернуть стандартный
              </button>
            )}
          </p>
        </>
      ) : (
        <p className="text-[12.5px] text-ink-dim">Не отвечать.</p>
      )}
    </div>
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
 * Адреса для телефона, лучший первым. Основа сама говорит, где её искать
 * (через интернет, потом сеть мастерской); облако — нет, там годится адрес
 * этой страницы.
 */
function addressOptions(pair: PairCode, here: string | null): string[] {
  const list = pair.box ? [pair.remote, ...(pair.lans ?? (pair.lan ? [pair.lan] : []))] : [here];
  return [...new Set(list.filter((a): a is string => !!a))];
}

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

  // Куда стучаться телефону. В облаке — туда же, где открыта эта страница.
  // У Основы — через интернет, если доступ включён (работает и без Wi-Fi), иначе
  // адрес компьютера в сети мастерской. Адрес этой страницы у Основы не годится:
  // её могли открыть через Radmin VPN или другой адрес, которого телефон не знает.
  const here = window.location.origin + BASE;
  const options = pair ? addressOptions(pair, isLocal(window.location.hostname) ? null : here) : [];
  const [picked, setPicked] = useState<string | null>(null);
  const server = picked && options.includes(picked) ? picked : options[0] ?? null;
  // Запасные адреса едут в QR-коде: не достучится по первому — приложение попробует их.
  const link =
    pair && server
      ? `${server}sms-phone?c=${pair.code}&u=${encodeURIComponent(server)}` +
        options
          .filter((a) => a !== server)
          .map((a) => `&a=${encodeURIComponent(a)}`)
          .join("")
      : null;

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
                {options.length > 1 && (
                  <div className="text-[12.5px] text-ink-dim">
                    Не подключается — другой адрес:
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      {options
                        .filter((a) => a !== server)
                        .map((a) => (
                          <button
                            key={a}
                            type="button"
                            onClick={() => setPicked(a)}
                            className="rounded-full border border-line px-2.5 py-0.5 font-mono text-[12px] text-ink-soft hover:border-brand hover:text-ink"
                          >
                            {a}
                          </button>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <Banner tone="warning">
              Телефону некуда подключиться: доступ из интернета не включён, и Основа не открыта для других устройств в
              сети мастерской. Включите{" "}
              <Link to="/settings/remote-access" className="font-semibold underline">
                «Доступ из интернета»
              </Link>{" "}
              — тогда телефон подключится и по Wi-Fi, и по мобильной сети.
            </Banner>
          )}
          {pair.box && !pair.remote && server && (
            <Banner tone="info">
              Телефон подключится, только если он в том же Wi-Fi, что и этот компьютер. Чтобы SMS уходили, даже когда
              телефон в мобильной сети, включите{" "}
              <Link to="/settings/remote-access" className="font-semibold underline">
                «Доступ из интернета»
              </Link>{" "}
              и возьмите новый код.
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
