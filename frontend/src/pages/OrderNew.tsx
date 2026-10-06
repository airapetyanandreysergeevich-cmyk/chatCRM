import { copyable } from "../components/CopyMenu";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { IconCamera, IconClose, IconCompany, IconPerson, IconSettings } from "../components/icons";
import { PhotoShooter } from "../components/PhotoShooter";
import { formatSize } from "../lib/photos";
import { PlateScanner } from "../components/PlateScanner";
import { CustomerDevices } from "../components/CustomerDevices";
import { OrderPeek } from "../components/OrderPeek";
import { mergeDevice } from "../lib/plate";
import { QuickPickEditor } from "../components/QuickPickEditor";
import {
  Banner,
  DebtBadge,
  Button,
  Card,
  Checkbox,
  countFilled,
  Field,
  Input,
  More,
  PageHeader,
  SectionLabel,
  Select,
  Spinner,
  Textarea,
} from "../components/ui";
import { ChipInput, Chips, hasPhrase, togglePhrase } from "../components/ChipInput";
import { SuggestInput } from "../components/SuggestInput";
import { ApiError } from "../lib/api";
import { ensureOnIntake } from "../lib/orderFolder";
import { useAuth } from "../lib/auth";
import type { QuickPick, QuickPickField } from "../lib/quickPicks";
import { plural } from "../lib/format";
import { customerColor, nameStyle } from "../lib/customerColor";
import { EMPTY_HINTS, hintsApi, matchHints, withBuiltIn, withoutHint, type Hints } from "../lib/hints";
import { masterLabel, ordersApi, type CustomerHit, type Reference } from "../lib/orders";

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
          className="flex w-full items-center gap-3 border-b border-line px-3 py-2.5 text-left transition-colors duration-150 last:border-b-0 hover:bg-surface-hover"
        >
          <span className="text-ink-dim [&>svg]:h-[18px] [&>svg]:w-[18px]">
            {c.type === "COMPANY" ? <IconCompany /> : <IconPerson />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-semibold" style={nameStyle(c.color)} {...copyable("name", c.name)}>
              {c.name}
              {customerColor(c.color) && (
                <span
                  className="ml-1.5 inline-block h-[9px] w-[9px] rounded-full align-middle"
                  style={{ backgroundColor: customerColor(c.color)!.dot }}
                />
              )}
            </span>
            <span className="block truncate text-[12.5px] text-ink-muted" {...copyable("phone", c.phone)}>
              {c.phone}
              {c.orderCount > 0 && ` · ${plural(c.orderCount, "заказ", "заказа", "заказов")}`}
            </span>
          </span>
          {c.inDebt && <DebtBadge amount={c.debt} />}
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
  const { can } = useAuth();
  // Шестерёнка у кнопок — тому, кто отвечает за настройки мастерской:
  // кнопки общие, и убранная одним приёмщиком пропадёт у всех.
  const canEditPicks = can("settings.manage");
  const [editingPicks, setEditingPicks] = useState<QuickPickField | null>(null);
  const [scanning, setScanning] = useState(false);
  /** Серийный номер пришёл с камеры — раскрыть блок, где он лежит, чтобы его было видно. */
  const [scannedSerial, setScannedSerial] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  /** Что сейчас делается после «Принять» — подпись на кнопке. */
  const [busyText, setBusyText] = useState<string | null>(null);
  /** Снимки при приёме: заказа ещё нет, поэтому держим их здесь и грузим после сохранения. */
  const [photos, setPhotos] = useState<Array<{ id: number; file: File; url: string }>>([]);
  const photoSeq = useRef(0);
  const [shooting, setShooting] = useState(false);
  /** Заказ сохранён, а часть снимков не ушла: показать «Повторить». */
  const [stuck, setStuck] = useState<{ orderId: string; files: File[]; why: string } | null>(null);
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
  /** Прошлые заказы клиента раскрыты; техника, взятая из них («Эта техника»); заказ в окне поверх. */
  const [showDevices, setShowDevices] = useState(false);
  const [sameDevice, setSameDevice] = useState<{ id: string; number: string; orderId: string } | null>(null);
  const [peek, setPeek] = useState<string | null>(null);
  const deviceCard = useRef<HTMLDivElement>(null);
  const [form, setForm] = useState({
    kind: "REPAIR",
    isUrgent: false,
    complaint: "",
    receptionNote: "",
    devicePasscode: "",
    storageLocation: "",
    dueAt: "",
    estimatedCost: "",
    approvedLimit: "",
    prepayment: "",
    assignedMasterId: "",
  });
  // Перечисления строкой, а не списком отмеченных ключей: в поле можно
  // дописать своё, чего в кнопках нет.
  const [completeness, setCompleteness] = useState("");
  const [appearance, setAppearance] = useState("");
  const [hints, setHints] = useState<Hints>(EMPTY_HINTS);

  useEffect(() => {
    ordersApi
      .reference()
      .then(setRef)
      .catch(() => setError(new ApiError(0, "Не удалось загрузить справочники")));

    // Память полей техники. Без неё бланк работает как раньше, поэтому
    // ошибку не показываем — просто не будет подсказок.
    hintsApi.list().then(setHints).catch(() => {});
  }, []);

  /**
   * Убрать вариант из памяти.
   *
   * Из списка он исчезает сразу, не дожидаясь ответа сервера: человек
   * нажимает урну, когда хочет избавиться от своей же опечатки, и видеть её
   * ещё секунду — раздражает. Если удалить не вышло, вариант вернётся при
   * следующем открытии бланка.
   */
  function forget(hint: { id: string }) {
    setHints((h) => withoutHint(h, hint.id));
    hintsApi.remove(hint.id).catch(() => {});
  }

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
    setShowDevices(false);
    setSameDevice(null);
    setPhoneHits([]);
    setNameHits([]);
  }

  /** «Это другой человек»: отвязываем карточку, поля оставляем как есть. */
  function unpickCustomer() {
    setPicked(null);
    setShowDevices(false);
    setSameDevice(null);
    setCustomer((c) => ({ ...c, id: "" }));
  }

  /**
   * «Принять снова — та же техника» из меню заказа: клиент и техника того
   * заказа сразу на бланке, новый заказ продолжает историю той же вещи
   * (как «Эта техника» в прошлых заказах клиента). Метка в истории браузера
   * снимается — обновление страницы не подставит второй раз.
   */
  const location = useLocation();
  const repeatFrom = (location.state as { repeatFrom?: string } | null)?.repeatFrom ?? null;
  useEffect(() => {
    if (!repeatFrom) return;
    navigate(location.pathname, { replace: true, state: null });
    void (async () => {
      try {
        const o = await ordersApi.get(repeatFrom);
        const c = o.customer;
        if (c.name) {
          const hits = c.phone ? await ordersApi.suggestCustomers({ phone: c.phone }).catch(() => []) : [];
          const hit = hits.find((h) => h.id === c.id);
          pickCustomer(
            hit ?? {
              id: c.id,
              type: c.type,
              name: c.name,
              phone: c.phone ?? "",
              phone2: c.phone2 ?? null,
              email: c.email ?? null,
              address: c.address ?? null,
              source: null,
              color: c.color ?? null,
              discountPercent: 0,
              orderCount: 0,
            }
          );
        }
        if (o.device) {
          setDevice({ kind: o.device.kind ?? "", brand: o.device.brand ?? "", model: o.device.model ?? "", serial: o.device.serial ?? "" });
          setSameDevice({ id: o.device.id, number: o.number, orderId: o.id });
          if (o.device.serial) setScannedSerial(true);
        }
      } catch {
        /* не нашли заказ — обычный пустой бланк */
      }
    })();
  }, [repeatFrom]); // eslint-disable-line react-hooks/exhaustive-deps

  // Превью снимков — память браузера: освобождаем, когда форма закрыта.
  const photoUrls = useRef<string[]>([]);
  useEffect(() => () => photoUrls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  function addPhotos(files: File[]) {
    const next = files.map((file) => {
      const url = URL.createObjectURL(file);
      photoUrls.current.push(url);
      photoSeq.current += 1;
      return { id: photoSeq.current, file, url };
    });
    setPhotos((p) => [...p, ...next]);
  }

  function removePhoto(id: number) {
    setPhotos((p) => p.filter((x) => x.id !== id));
  }

  /**
   * Загрузить снимки в только что принятый заказ. Что не ушло — остаётся
   * на экране с кнопкой «Повторить»: заказ уже сохранён, и второй раз его
   * создавать нельзя.
   */
  async function uploadPhotos(orderId: string, files: File[]): Promise<boolean> {
    let done = 0;
    try {
      await ordersApi.upload(orderId, files, "INTAKE", (n, total) => {
        done = n;
        setBusyText(`Загружаем снимки: ${n} из ${total}…`);
      });
      return true;
    } catch (err) {
      const why = err instanceof ApiError ? err.message : "Нет связи с сервером";
      setStuck({ orderId, files: files.slice(done), why });
      window.scrollTo({ top: 0, behavior: "smooth" });
      return false;
    }
  }

  async function retryPhotos() {
    if (!stuck) return;
    const { orderId, files } = stuck;
    setStuck(null);
    setBusy(true);
    try {
      if (await uploadPhotos(orderId, files)) navigate(`/orders/${orderId}`, { state: { printOffer: true } });
    } finally {
      setBusy(false);
      setBusyText(null);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (stuck) {
      // Заказ уже принят — второй раз его не создаём, только догружаем снимки.
      void retryPhotos();
      return;
    }
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
        // Та же техника, что в прошлом заказе, — та же карточка устройства: история не рвётся.
        device: sameDevice ? { ...device, id: sameDevice.id } : device,
        kind: form.kind,
        isUrgent: form.isUrgent,
        complaint: form.complaint,
        receptionNote: form.receptionNote || undefined,
        devicePasscode: form.devicePasscode || undefined,
        completeness,
        appearance,
        storageLocation: form.storageLocation || undefined,
        dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : undefined,
        estimatedCost: num(form.estimatedCost),
        approvedLimit: num(form.approvedLimit),
        prepayment: num(form.prepayment) ?? 0,
        assignedMasterId: form.assignedMasterId || undefined,
      });
      // Папка заказа на компьютере — сразу, если так настроено; приём её не ждёт.
      void ensureOnIntake({ number: created.number, device, customer: { name: customer.name } });
      if (photos.length && !(await uploadPhotos(created.id, photos.map((p) => p.file)))) return;
      navigate(`/orders/${created.id}`, { state: { printOffer: true } });
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
      window.scrollTo({ top: 0, behavior: "smooth" });
    } finally {
      setBusy(false);
      setBusyText(null);
    }
  }

  if (!ref) return <Spinner label="Готовим бланк" />;

  const fieldError = (path: string) => error?.field(path);

  return (
    <>
    <form onSubmit={submit} className="space-y-5">
      <PageHeader
        eyebrow="Мастерская"
        title="Приём техники"
        subtitle="Всё, что зафиксировано здесь, потом решает споры: комплектность, дефекты и слова клиента."
        actions={
          <>
            <Button type="button" variant="secondary" onClick={() => (stuck ? navigate(`/orders/${stuck.orderId}`, { state: { printOffer: true } }) : navigate("/orders"))}>
              {stuck ? "К заказу" : "Отмена"}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? busyText ?? "Сохраняем…" : stuck ? "Загрузить снимки ещё раз" : "Принять в ремонт"}
            </Button>
          </>
        }
      />

      {error && <Banner tone="error">{error.message}</Banner>}
      {stuck && (
        <Banner tone="error">
          Заказ принят, но {stuck.files.length === 1 ? "один снимок не загрузился" : `не загрузились снимки: ${stuck.files.length}`}{" "}
          — {stuck.why}.
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" className="px-4 text-[13px]" disabled={busy} onClick={() => void retryPhotos()}>
              Повторить
            </Button>
            <Button
              type="button"
              variant="secondary"
              className="px-4 text-[13px]"
              onClick={() => navigate(`/orders/${stuck.orderId}`, { state: { printOffer: true } })}
            >
              Перейти к заказу без них
            </Button>
          </div>
        </Banner>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <SectionLabel>Клиент</SectionLabel>
          <div className="mt-4 space-y-4">
            {picked && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-field border border-brand/40 bg-brand-tint px-3 py-2.5">
                <span className="text-[13.5px]">
                  Карточка из базы:{" "}
                  <span className="font-semibold" style={nameStyle(picked.color)} title={customerColor(picked.color)?.label} {...copyable("name", picked.name)}>
                    {picked.name}
                  </span>
                  {picked.orderCount > 0 && (
                    <>
                      {" "}
                      ·{" "}
                      {/* Прошлые заказы — кнопкой: список техники клиента, «Эта техника» и просмотр заказа. */}
                      <button
                        type="button"
                        aria-expanded={showDevices}
                        onClick={() => setShowDevices((v) => !v)}
                        className="font-semibold text-brand-ink underline decoration-dotted underline-offset-2 hover:decoration-solid"
                      >
                        {plural(picked.orderCount, "заказ", "заказа", "заказов")} {showDevices ? "▴" : "▾"}
                      </button>
                    </>
                  )}
                  {/* Скидка достанется заказу автоматически, но приёмщик
                      должен знать о ней до того, как назовёт клиенту сумму. */}
                  {picked.discountPercent > 0 && (
                    <span className="font-semibold text-state-done">
                      {" "}
                      · скидка на работы {picked.discountPercent}%
                    </span>
                  )}
                  {/* Должник у стойки: сказать о долге до того, как брать технику. */}
                  {picked.inDebt && <DebtBadge amount={picked.debt} className="ml-2" />}
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
            {picked && showDevices && (
              <CustomerDevices
                customerId={picked.id}
                pickedId={sameDevice?.id ?? null}
                onPeek={setPeek}
                onPick={(d, from) => {
                  setDevice({ kind: d.kind ?? "", brand: d.brand ?? "", model: d.model ?? "", serial: d.serial ?? "" });
                  setSameDevice({ id: d.id, number: from.number, orderId: from.id });
                  if (d.serial) setScannedSerial(true);
                  setShowDevices(false);
                  deviceCard.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
              />
            )}

            {/* Подсказки лежат рядом с полем, а не внутри него: Field — это
                <label>, и кнопка внутри неё спорила бы с фокусом ввода. */}
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
          </div>

          <More
            filled={countFilled(
              customer.type === "COMPANY",
              customer.phone2,
              customer.email,
              customer.source,
              customer.address
            )}
            // Ошибка в спрятанном поле — единственный случай, когда блок
            // обязан раскрыться сам: иначе человек видит красную рамку
            // формы и не понимает, где именно.
            forceOpen={!!fieldError("customer.email")}
          >
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
          </More>
        </Card>

        <Card>
          <div ref={deviceCard} className="flex items-start justify-between gap-3 scroll-mt-4">
            <SectionLabel>Техника</SectionLabel>
            {ref.features.plateOcr && (
              <button
                type="button"
                onClick={() => setScanning(true)}
                aria-label="Заполнить по шильдику"
                title="Заполнить по шильдику: навести камеру на наклейку с моделью и серийным номером"
                className="-mr-1.5 -mt-1.5 flex h-8 items-center gap-1.5 rounded-field px-2 text-[13px] font-semibold text-ink-muted transition-colors duration-150 hover:bg-surface-raised hover:text-ink [&>svg]:h-[18px] [&>svg]:w-[18px]"
              >
                <IconCamera />
                <span className="hidden sm:inline">По шильдику</span>
              </button>
            )}
          </div>
          {sameDevice && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-field border border-brand/40 bg-brand-tint px-3 py-2 text-[13px]">
              <span>
                Та же техника, что в заказе{" "}
                <button type="button" onClick={() => setPeek(sameDevice.orderId)} className="font-mono font-semibold text-brand-ink hover:underline">
                  {sameDevice.number}
                </button>{" "}
                — история ремонтов продолжится
              </span>
              <button type="button" onClick={() => setSameDevice(null)} className="text-[12.5px] font-semibold text-brand-ink hover:underline">
                это другая вещь
              </button>
            </div>
          )}
          <div className="mt-4 space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              {/* Вид, марку и модель мастерская набирает руками, и одни и те
                  же аппараты приходят снова и снова. Поэтому все три поля
                  помнят прежние варианты и предлагают их с первой буквы.

                  Вид раньше был выпадающим списком из девяти строк. Список
                  кончался «Прочим», и мастерская с потоком кофемашин или
                  автомагнитол сваливала туда половину заказов — а потом не
                  находила их ни поиском, ни глазами. Встроенные виды никуда
                  не делись: они идут в подсказках следом за своими. */}
              <Field label="Тип" error={fieldError("device.kind")} interactive>
                <SuggestInput
                  value={device.kind}
                  onChange={(kind) => setDevice({ ...device, kind })}
                  items={matchHints(withBuiltIn(hints.kind, ref.deviceKinds), device.kind)}
                  onForget={forget}
                  placeholder="Ноутбук, Кофемашина, Автомагнитола…"
                />
              </Field>
              <Field label="Бренд" interactive>
                <SuggestInput
                  value={device.brand}
                  onChange={(brand) => setDevice({ ...device, brand })}
                  items={matchHints(hints.brand, device.brand)}
                  onForget={forget}
                  placeholder="Lenovo, ASUS, HP…"
                />
              </Field>
            </div>
            <Field label="Модель" interactive>
              <SuggestInput
                value={device.model}
                // Модели показываем только для выбранной марки: IdeaPad
                // незачем подсказывать, когда в бренде стоит ASUS.
                onChange={(model) => setDevice({ ...device, model })}
                items={matchHints(hints.model, device.model, device.brand)}
                onForget={forget}
                placeholder="IdeaPad 5, VivoBook 15…"
              />
            </Field>
          </div>

          <More
            filled={countFilled(device.serial, form.devicePasscode, form.storageLocation)}
            forceOpen={scannedSerial}
          >
            <Field label="Серийный номер">
              <Input value={device.serial} onChange={(e) => setDevice({ ...device, serial: e.target.value })} />
            </Field>
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
          </More>
        </Card>

        <Card>
          <div className="flex items-start justify-between gap-3">
            <SectionLabel>Комплектность</SectionLabel>
            {canEditPicks && (
              <button
                type="button"
                onClick={() => setEditingPicks("completeness")}
                aria-label="Настроить кнопки"
                title="Настроить кнопки: добавить, переименовать, убрать"
                className="-mr-1.5 -mt-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-field text-ink-dim transition-colors duration-150 hover:bg-surface-raised hover:text-ink [&>svg]:h-[17px] [&>svg]:w-[17px]"
              >
                <IconSettings />
              </button>
            )}
          </div>
          <p className="mt-2 text-[13px] text-ink-dim">
            Что клиент сдал вместе с техникой. Кнопки дописывают пункт в строку, а строку можно
            править руками — «блок питания чужой» кнопкой не отметишь.
          </p>
          <div className="mt-4">
            <ChipInput
              value={completeness}
              onChange={setCompleteness}
              options={ref.completeness}
              placeholder="Блок питания, Кабель…"
            />
          </div>
        </Card>

        <Card>
          <div className="flex items-start justify-between gap-3">
            <SectionLabel>Внешнее состояние</SectionLabel>
            {canEditPicks && (
              <button
                type="button"
                onClick={() => setEditingPicks("appearance")}
                aria-label="Настроить кнопки"
                title="Настроить кнопки: добавить, переименовать, убрать"
                className="-mr-1.5 -mt-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-field text-ink-dim transition-colors duration-150 hover:bg-surface-raised hover:text-ink [&>svg]:h-[17px] [&>svg]:w-[17px]"
              >
                <IconSettings />
              </button>
            )}
          </div>
          <p className="mt-2 text-[13px] text-ink-dim">
            Зафиксированные дефекты защищают и мастерскую, и клиента. Чем точнее записано, тем
            меньше спорить при выдаче.
          </p>
          <div className="mt-4">
            <ChipInput
              value={appearance}
              onChange={setAppearance}
              options={ref.appearance}
              placeholder="Царапины, скол на крышке у петли…"
            />
          </div>
          {/* «Следы вскрытия» и «Следы влаги» — теперь такие же кнопки в
              списке выше, а «Прочее по состоянию» больше не нужно: своё
              дописывается прямо в строку. Три места для одного вопроса
              «в каком виде сдали технику» — это три места, где его можно
              заполнить наполовину. */}
        </Card>
      </div>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionLabel>Фотографии</SectionLabel>
          <Button
            type="button"
            variant="secondary"
            icon={<IconCamera />}
            className="px-4 text-[13px]"
            disabled={!!stuck}
            onClick={() => setShooting(true)}
          >
            {photos.length ? "Ещё фото" : "Сфотографировать"}
          </Button>
        </div>
        {photos.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-dim">
            Снимите технику со всех сторон, крупно — царапины и сколы. Снимки уйдут в заказ вместе с ним.
          </p>
        ) : (
          <>
            <p className="mt-2 text-[12.5px] text-ink-dim">
              {plural(photos.length, "снимок", "снимка", "снимков")}, {formatSize(photos.reduce((a, p) => a + p.file.size, 0))}
              {" "}— загрузятся после «Принять в ремонт»
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {photos.map((p) => (
                <div key={p.id} className="relative h-[84px] w-[84px] overflow-hidden rounded-card border border-line">
                  <img src={p.url} alt="" className="h-full w-full object-cover" />
                  {!stuck && (
                    <button
                      type="button"
                      aria-label="Убрать снимок"
                      onClick={() => removePhoto(p.id)}
                      className="absolute right-0.5 top-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/65 text-white [&>svg]:h-3.5 [&>svg]:w-3.5"
                    >
                      <IconClose />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      <Card>
        <SectionLabel>Заявка</SectionLabel>
        <div className="mt-4">
          <div className="flex items-start justify-between gap-3">
            <span className="mb-1.5 block text-[13px] font-semibold text-ink-soft">
              Неисправность со слов клиента
            </span>
            {canEditPicks && (
              <button
                type="button"
                onClick={() => setEditingPicks("complaint")}
                aria-label="Настроить кнопки"
                title="Настроить кнопки: добавить, переименовать, убрать"
                className="-mr-1.5 -mt-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-field text-ink-dim transition-colors duration-150 hover:bg-surface-raised hover:text-ink [&>svg]:h-[17px] [&>svg]:w-[17px]"
              >
                <IconSettings />
              </button>
            )}
          </div>
          {/* Не Field: он оборачивает всё в <label>, а клик по label браузер
              переадресует в поле — кнопки-подсказки тогда не нажимались бы. */}
          <Textarea
            aria-label="Неисправность со слов клиента"
            value={form.complaint}
            onChange={(e) => setForm({ ...form, complaint: e.target.value })}
            placeholder="Не включается после того, как залили чаем"
            invalid={!!fieldError("complaint")}
          />
          {/* Кнопки дописывают частую жалобу, но текст остаётся дословным:
              «после того, как залили чаем» приёмщик допишет сам. */}
          <Chips
            value={form.complaint}
            onChange={(complaint) => setForm((f) => ({ ...f, complaint }))}
            options={ref.complaint}
            has={hasPhrase}
            toggle={togglePhrase}
          />
          {fieldError("complaint") ? (
            <span className="mt-1.5 block text-[12.5px] text-state-off">{fieldError("complaint")}</span>
          ) : (
            <span className="mt-2 block text-[12.5px] text-ink-dim">
              Записывайте дословно — это юридически значимая часть квитанции
            </span>
          )}
        </div>

        <More
          filled={countFilled(
            form.receptionNote,
            form.kind !== "REPAIR",
            form.assignedMasterId,
            form.dueAt,
            form.isUrgent,
            form.estimatedCost,
            form.approvedLimit,
            form.prepayment
          )}
          forceOpen={
            !!fieldError("dueAt") ||
            !!fieldError("estimatedCost") ||
            !!fieldError("approvedLimit") ||
            !!fieldError("prepayment")
          }
        >
        <Field label="Примечания приёмщика" hint="Техническая часть: что заметили при осмотре">
          <Textarea
            value={form.receptionNote}
            onChange={(e) => setForm({ ...form, receptionNote: e.target.value })}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
                  {masterLabel(m)}
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

        <div className="grid gap-4 sm:grid-cols-3">
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
        </More>

      </Card>

      <div className="flex flex-col gap-2 sm:flex-row-reverse">
        <Button type="submit" disabled={busy} className="sm:min-w-[220px]">
          {busy ? busyText ?? "Сохраняем…" : stuck ? "Загрузить снимки ещё раз" : "Принять в ремонт"}
        </Button>
        <Button type="button" variant="secondary" onClick={() => (stuck ? navigate(`/orders/${stuck.orderId}`, { state: { printOffer: true } }) : navigate("/orders"))}>
          {stuck ? "К заказу без снимков" : "Отмена"}
        </Button>
      </div>
    </form>

    {/* Окно правки кнопок — рядом с формой бланка, а не внутри неё: форма в
        форме недопустима, и Enter в поле «Новая кнопка» отправил бы весь
        заказ. */}
    {peek && <OrderPeek orderId={peek} allowOpen={false} onClose={() => setPeek(null)} />}
    {scanning && (
      <PlateScanner
        current={device}
        mode={ref?.features.plateOcrMode ?? "server"}
        onClose={() => setScanning(false)}
        onApply={(draft) => {
          setDevice((d) => mergeDevice(d, draft));
          if (draft.serial.trim()) setScannedSerial(true);
          setScanning(false);
        }}
      />
    )}

    {shooting && (
      <PhotoShooter
        onClose={() => setShooting(false)}
        onCollect={(files) => {
          addPhotos(files);
          setShooting(false);
        }}
      />
    )}

    {editingPicks && (
      <QuickPickEditor
        field={editingPicks}
        onClose={() => setEditingPicks(null)}
        onChanged={(list: QuickPick[]) =>
          setRef((r) =>
            r ? { ...r, [editingPicks]: list.map((q) => ({ key: q.id, label: q.label, locked: q.locked })) } : r
          )
        }
      />
    )}
    </>
  );
}
