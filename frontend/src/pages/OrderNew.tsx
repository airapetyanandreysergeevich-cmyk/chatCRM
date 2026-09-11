import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { IconCompany, IconPerson } from "../components/icons";
import {
  Banner,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  PageHeader,
  SectionLabel,
  Select,
  Spinner,
  Textarea,
} from "../components/ui";
import { ApiError } from "../lib/api";
import { plural } from "../lib/format";
import { ordersApi, type CustomerHit, type Reference } from "../lib/orders";

const toggle = (list: string[], key: string) =>
  list.includes(key) ? list.filter((k) => k !== key) : [...list, key];

const num = (v: string) => (v.trim() === "" ? undefined : Number(v.replace(",", ".")));

/**
 * Похожие клиенты под полем. Показываем, а не подставляем молча: в мастерской
 * бывает два Кузнецова и один телефон на всю семью, и решить, тот ли это
 * человек, может только приёмщик — он с ним сейчас разговаривает.
 */
function CustomerHints({ hits, onPick }: { hits: CustomerHit[]; onPick: (c: CustomerHit) => void }) {
  if (hits.length === 0) return null;
  return (
    <div className="mt-2 overflow-hidden rounded-field border border-line bg-surface-raised">
      <p className="border-b border-line px-3 py-1.5 text-[11.5px] font-semibold uppercase tracking-[0.1em] text-ink-dim">
        Уже есть в базе
      </p>
      {hits.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => onPick(c)}
          className="flex w-full items-center gap-3 border-b border-line px-3 py-2.5 text-left transition-colors duration-150 last:border-b-0 hover:bg-[#242936]"
        >
          <span className="text-ink-dim [&>svg]:h-[18px] [&>svg]:w-[18px]">
            {c.type === "COMPANY" ? <IconCompany /> : <IconPerson />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-semibold">{c.name}</span>
            <span className="block truncate text-[12.5px] text-ink-muted">
              {c.phone}
              {c.orderCount > 0 && ` · ${plural(c.orderCount, "заказ", "заказа", "заказов")}`}
            </span>
          </span>
          <span className="shrink-0 text-[12.5px] font-semibold text-brand-ink">выбрать</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Бланк приёма техники. Порядок полей повторяет разговор у стойки:
 * сначала кто принёс, потом что принёс, потом что с этим не так.
 */
export default function OrderNew() {
  const navigate = useNavigate();
  const [ref, setRef] = useState<Reference | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [phoneHits, setPhoneHits] = useState<CustomerHit[]>([]);
  const [nameHits, setNameHits] = useState<CustomerHit[]>([]);
  /** Выбранная карточка: пока она есть, подсказки не мешаются. */
  const [picked, setPicked] = useState<CustomerHit | null>(null);

  const [customer, setCustomer] = useState({
    id: "",
    type: "INDIVIDUAL",
    name: "",
    phone: "",
    phone2: "",
    email: "",
    address: "",
    source: "",
  });
  const [device, setDevice] = useState({ kind: "", brand: "", model: "", serial: "" });
  const [form, setForm] = useState({
    kind: "REPAIR",
    isUrgent: false,
    complaint: "",
    receptionNote: "",
    devicePasscode: "",
    appearanceNote: "",
    hasOpenTraces: false,
    hasWaterDamage: false,
    storageLocation: "",
    dueAt: "",
    estimatedCost: "",
    approvedLimit: "",
    prepayment: "",
    assignedMasterId: "",
  });
  const [completeness, setCompleteness] = useState<string[]>([]);
  const [appearance, setAppearance] = useState<string[]>([]);

  useEffect(() => {
    ordersApi
      .reference()
      .then((r) => {
        setRef(r);
        setDevice((d) => ({ ...d, kind: d.kind || r.deviceKinds[0] }));
      })
      .catch(() => setError(new ApiError(0, "Не удалось загрузить справочники")));
  }, []);

  /**
   * Ищем по телефону и по имени независимо: у стойки человек называет то
   * одно, то другое. Запрос уходит с задержкой — иначе сервер получает по
   * запросу на каждую нажатую цифру.
   */
  useEffect(() => {
    if (picked) return;
    if (customer.phone.replace(/\D/g, "").length < 3) {
      setPhoneHits([]);
      return;
    }
    const t = setTimeout(() => {
      ordersApi
        .suggestCustomers({ phone: customer.phone })
        .then(setPhoneHits)
        // Подсказка — удобство, а не условие приёма: если поиск отвалился,
        // приёмщик просто заводит нового клиента.
        .catch(() => setPhoneHits([]));
    }, 300);
    return () => clearTimeout(t);
  }, [customer.phone, picked]);

  useEffect(() => {
    if (picked) return;
    if (customer.name.trim().length < 2) {
      setNameHits([]);
      return;
    }
    const t = setTimeout(() => {
      ordersApi
        .suggestCustomers({ name: customer.name })
        .then(setNameHits)
        .catch(() => setNameHits([]));
    }, 300);
    return () => clearTimeout(t);
  }, [customer.name, picked]);

  function pickCustomer(c: CustomerHit) {
    setCustomer({
      id: c.id,
      type: c.type,
      name: c.name,
      phone: c.phone,
      phone2: c.phone2 ?? "",
      email: c.email ?? "",
      address: c.address ?? "",
      source: c.source ?? "",
    });
    setPicked(c);
    setPhoneHits([]);
    setNameHits([]);
  }

  /** «Это другой человек»: отвязываем карточку, поля оставляем как есть. */
  function unpickCustomer() {
    setPicked(null);
    setCustomer((c) => ({ ...c, id: "" }));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await ordersApi.create({
        customer: {
          ...(customer.id ? { id: customer.id } : {}),
          type: customer.type,
          name: customer.name,
          phone: customer.phone,
          phone2: customer.phone2 || undefined,
          email: customer.email || undefined,
          address: customer.address || undefined,
          source: customer.source || undefined,
        },
        device,
        kind: form.kind,
        isUrgent: form.isUrgent,
        complaint: form.complaint,
        receptionNote: form.receptionNote || undefined,
        devicePasscode: form.devicePasscode || undefined,
        completeness,
        appearance,
        appearanceNote: form.appearanceNote || undefined,
        hasOpenTraces: form.hasOpenTraces,
        hasWaterDamage: form.hasWaterDamage,
        storageLocation: form.storageLocation || undefined,
        dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : undefined,
        estimatedCost: num(form.estimatedCost),
        approvedLimit: num(form.approvedLimit),
        prepayment: num(form.prepayment) ?? 0,
        assignedMasterId: form.assignedMasterId || undefined,
      });
      navigate(`/orders/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
      window.scrollTo({ top: 0, behavior: "smooth" });
    } finally {
      setBusy(false);
    }
  }

  if (!ref) return <Spinner label="Готовим бланк" />;

  const fieldError = (path: string) => error?.field(path);

  return (
    <form onSubmit={submit} className="space-y-5">
      <PageHeader
        eyebrow="Мастерская"
        title="Приём техники"
        subtitle="Всё, что зафиксировано здесь, потом решает споры: комплектность, дефекты и слова клиента."
        actions={
          <>
            <Button type="button" variant="secondary" onClick={() => navigate("/orders")}>
              Отмена
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Сохраняем…" : "Принять в ремонт"}
            </Button>
          </>
        }
      />

      {error && <Banner tone="error">{error.message}</Banner>}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <SectionLabel>Клиент</SectionLabel>
          <div className="mt-4 space-y-4">
            {picked && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-field border border-brand/40 bg-brand-tint px-3 py-2.5">
                <span className="text-[13.5px]">
                  Карточка из базы: <span className="font-semibold">{picked.name}</span>
                  {picked.orderCount > 0 && (
                    <span className="text-ink-muted">
                      {" "}
                      · {plural(picked.orderCount, "заказ", "заказа", "заказов")}
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={unpickCustomer}
                  className="text-[12.5px] font-semibold text-brand-ink hover:underline"
                >
                  это другой человек
                </button>
              </div>
            )}

            {/* Подсказки лежат рядом с полем, а не внутри него: Field — это
                <label>, и кнопка внутри неё спорила бы с фокусом ввода. */}
            <div>
              <Field
                label="Телефон"
                error={fieldError("customer.phone")}
                hint="Начните набирать — покажем, обращались ли уже"
              >
                <Input
                  type="tel"
                  value={customer.phone}
                  onChange={(e) => setCustomer({ ...customer, phone: e.target.value, id: "" })}
                  placeholder="+7 900 000-00-00"
                  invalid={!!fieldError("customer.phone")}
                />
              </Field>
              {!picked && <CustomerHints hits={phoneHits} onPick={pickCustomer} />}
            </div>

            <div>
              <Field label="Имя или название" error={fieldError("customer.name")}>
                <Input
                  value={customer.name}
                  onChange={(e) => setCustomer({ ...customer, name: e.target.value })}
                  invalid={!!fieldError("customer.name")}
                />
              </Field>
              {/* Если тот же клиент уже нашёлся по телефону, второй раз его
                  не предлагаем — один и тот же список под двумя полями
                  читается как ошибка. */}
              {!picked && (
                <CustomerHints
                  hits={nameHits.filter((h) => !phoneHits.some((p) => p.id === h.id))}
                  onPick={pickCustomer}
                />
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Тип">
                <Select value={customer.type} onChange={(e) => setCustomer({ ...customer, type: e.target.value })}>
                  <option value="INDIVIDUAL">Физлицо</option>
                  <option value="COMPANY">Организация</option>
                </Select>
              </Field>
              <Field label="Ещё телефон">
                <Input value={customer.phone2} onChange={(e) => setCustomer({ ...customer, phone2: e.target.value })} />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Email" error={fieldError("customer.email")}>
                <Input
                  type="email"
                  value={customer.email}
                  onChange={(e) => setCustomer({ ...customer, email: e.target.value })}
                  invalid={!!fieldError("customer.email")}
                />
              </Field>
              <Field label="Откуда узнал">
                <Input
                  value={customer.source}
                  onChange={(e) => setCustomer({ ...customer, source: e.target.value })}
                  placeholder="Реклама, знакомые, вывеска"
                />
              </Field>
            </div>
            <Field label="Адрес">
              <Input value={customer.address} onChange={(e) => setCustomer({ ...customer, address: e.target.value })} />
            </Field>
          </div>
        </Card>

        <Card>
          <SectionLabel>Техника</SectionLabel>
          <div className="mt-4 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Тип" error={fieldError("device.kind")}>
                <Select value={device.kind} onChange={(e) => setDevice({ ...device, kind: e.target.value })}>
                  {ref.deviceKinds.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Бренд">
                <Input value={device.brand} onChange={(e) => setDevice({ ...device, brand: e.target.value })} />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Модель">
                <Input value={device.model} onChange={(e) => setDevice({ ...device, model: e.target.value })} />
              </Field>
              <Field label="Серийный номер">
                <Input value={device.serial} onChange={(e) => setDevice({ ...device, serial: e.target.value })} />
              </Field>
            </div>
            <Field label="Пароль, PIN или графический ключ" hint="Без него мастер не сможет проверить работу">
              <Input
                value={form.devicePasscode}
                onChange={(e) => setForm({ ...form, devicePasscode: e.target.value })}
              />
            </Field>
            <Field label="Место хранения" hint="Стеллаж, полка, ячейка">
              <Input
                value={form.storageLocation}
                onChange={(e) => setForm({ ...form, storageLocation: e.target.value })}
              />
            </Field>
          </div>
        </Card>

        <Card>
          <SectionLabel>Комплектность</SectionLabel>
          <p className="mt-2 text-[13px] text-ink-dim">Отметьте всё, что клиент сдал вместе с техникой.</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {ref.completeness.map((c) => (
              <Checkbox
                key={c.key}
                label={c.label}
                checked={completeness.includes(c.key)}
                onChange={() => setCompleteness((v) => toggle(v, c.key))}
              />
            ))}
          </div>
        </Card>

        <Card>
          <SectionLabel>Внешнее состояние</SectionLabel>
          <p className="mt-2 text-[13px] text-ink-dim">
            Зафиксированные дефекты защищают и мастерскую, и клиента.
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {ref.appearance.map((a) => (
              <Checkbox
                key={a.key}
                label={a.label}
                checked={appearance.includes(a.key)}
                onChange={() => setAppearance((v) => toggle(v, a.key))}
              />
            ))}
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <Checkbox
              label="Следы вскрытия"
              checked={form.hasOpenTraces}
              onChange={(v) => setForm({ ...form, hasOpenTraces: v })}
            />
            <Checkbox
              label="Следы влаги"
              checked={form.hasWaterDamage}
              onChange={(v) => setForm({ ...form, hasWaterDamage: v })}
            />
          </div>
          <div className="mt-4">
            <Field label="Прочее по состоянию">
              <Input
                value={form.appearanceNote}
                onChange={(e) => setForm({ ...form, appearanceNote: e.target.value })}
              />
            </Field>
          </div>
        </Card>
      </div>

      <Card>
        <SectionLabel>Заявка</SectionLabel>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Field
            label="Неисправность со слов клиента"
            error={fieldError("complaint")}
            hint="Записывайте дословно — это юридически значимая часть квитанции"
          >
            <Textarea
              value={form.complaint}
              onChange={(e) => setForm({ ...form, complaint: e.target.value })}
              placeholder="Не включается после того, как залили чаем"
              invalid={!!fieldError("complaint")}
            />
          </Field>
          <Field label="Примечания приёмщика" hint="Техническая часть: что заметили при осмотре">
            <Textarea
              value={form.receptionNote}
              onChange={(e) => setForm({ ...form, receptionNote: e.target.value })}
            />
          </Field>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="Тип обращения">
            <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {ref.orderKinds.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Мастер" hint="Можно назначить позже">
            <Select
              value={form.assignedMasterId}
              onChange={(e) => setForm({ ...form, assignedMasterId: e.target.value })}
            >
              <option value="">Не назначен</option>
              {ref.masters.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.fullName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Срок готовности">
            <Input type="date" value={form.dueAt} onChange={(e) => setForm({ ...form, dueAt: e.target.value })} />
          </Field>
          <div className="flex items-end">
            <Checkbox label="Срочный заказ" checked={form.isUrgent} onChange={(v) => setForm({ ...form, isUrgent: v })} />
          </div>
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <Field label="Предварительная стоимость, ₽">
            <Input
              inputMode="decimal"
              value={form.estimatedCost}
              onChange={(e) => setForm({ ...form, estimatedCost: e.target.value })}
            />
          </Field>
          <Field label="Клиент согласовал до, ₽" hint="Выше этой суммы мастер работы не начнёт">
            <Input
              inputMode="decimal"
              value={form.approvedLimit}
              onChange={(e) => setForm({ ...form, approvedLimit: e.target.value })}
            />
          </Field>
          <Field label="Предоплата, ₽">
            <Input
              inputMode="decimal"
              value={form.prepayment}
              onChange={(e) => setForm({ ...form, prepayment: e.target.value })}
            />
          </Field>
        </div>

        <Banner>
          Фотографии приложите на карточке заказа сразу после сохранения — там они привязываются
          к номеру и видны мастеру.
        </Banner>
      </Card>

      <div className="flex flex-col gap-2 sm:flex-row-reverse">
        <Button type="submit" disabled={busy} className="sm:min-w-[220px]">
          {busy ? "Сохраняем…" : "Принять в ремонт"}
        </Button>
        <Button type="button" variant="secondary" onClick={() => navigate("/orders")}>
          Отмена
        </Button>
      </div>
    </form>
  );
}
