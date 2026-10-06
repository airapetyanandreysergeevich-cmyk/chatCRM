import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Modal } from "../../components/Modal";
import { SortSelect } from "../../components/ListControls";
import {
  CategoryChip,
  ClientModal,
  FilterSelect,
  KindMark,
  PayText,
  RowMenu,
  Seen,
  norm,
  usePref,
} from "../../components/platform/ClientBits";
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  Field,
  Input,
  List,
  ListRow,
  SearchInput,
  SectionLabel,
  Spinner,
} from "../../components/ui";
import { ApiError, api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDate, plural } from "../../lib/format";
import {
  activityOf,
  bytes,
  platformApi,
  type Activity,
  type BoxRow,
  type Category,
  type PayState,
} from "../../lib/platformApi";

/**
 * Локальные мастерские: программа и база у них на компьютере, а у нас —
 * только доступ к ней из интернета.
 *
 * Мастерская работает у себя, и её база никуда не уезжает. Здесь выдаётся
 * только право подключиться к нашему серверу — одной фразой, в которой и
 * адрес, и ключ, и код мастерской. «Выключить» — это и есть рубильник
 * услуги: адрес перестаёт работать, а программа в мастерской продолжает
 * работать по локальной сети как ни в чём не бывало.
 *
 * Фраза показывается один раз, при выдаче: у нас хранится только отпечаток
 * ключа. Потерялась — выпускаем новую, прежняя сразу перестаёт действовать.
 */

type Box = BoxRow;

const addressOf = (code: string) => `${window.location.origin}/b/${code}/`;

/** Что выдаётся мастерской одним разом: фраза и адрес. */
interface Issued {
  code: string;
  email: string;
  phrase: string;
  address: string;
}

type StateFilter = "" | "online" | "offline" | "off";
type PayFilter = "" | PayState | "debt";
type ActFilter = "" | Activity | "quiet";
type Sort = "seen" | "name" | "paid" | "traffic" | "created";

const SORTS: Array<{ value: Sort; label: string }> = [
  { value: "seen", label: "по активности" },
  { value: "paid", label: "по сроку оплаты" },
  { value: "traffic", label: "по трафику" },
  { value: "name", label: "по названию" },
  { value: "created", label: "сначала новые" },
];

export default function Boxes() {
  const { me } = useAuth();
  const isOwner = me?.kind === "platform" && me.platformUser.role === "OWNER";
  const [rows, setRows] = useState<Box[] | null>(null);
  const [cats, setCats] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [confirmKey, setConfirmKey] = useState<Box | null>(null);
  const [confirmDrop, setConfirmDrop] = useState<Box | null>(null);
  const [confirmFree, setConfirmFree] = useState<Box | null>(null);
  const [open, setOpen] = useState<Box | null>(null);

  const [q, setQ] = useState("");
  const [state, setState] = usePref<StateFilter>("platform.boxes.state", "", ["", "online", "offline", "off"]);
  const [cat, setCat] = useState("");
  const [pay, setPay] = usePref<PayFilter>("platform.boxes.pay", "", ["", "paid", "soon", "overdue", "none", "free", "debt"]);
  const [act, setAct] = usePref<ActFilter>("platform.boxes.act", "", ["", "online", "day", "week", "month", "long", "never", "quiet"]);
  const [sort, setSort] = usePref<Sort>("platform.boxes.sort", "seen", ["seen", "name", "paid", "traffic", "created"]);

  const load = useCallback(async () => {
    try {
      const [b, c] = await Promise.all([platformApi.boxes(), platformApi.categories()]);
      setRows(b);
      setCats(c);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить список");
    }
  }, []);

  useEffect(() => {
    void load();
    // Кто на связи — меняется само по себе: у мастерской выключили компьютер,
    // пропал интернет. Обновляем раз в полминуты, чтобы список не врал.
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const catBy = useMemo(() => new Map(cats.map((c) => [c.id, c])), [cats]);

  const shown = useMemo(() => {
    if (!rows) return [];
    const words = norm(q).split(/\s+/).filter(Boolean);
    const list = rows.filter((b) => {
      if (state === "online" && !b.online) return false;
      if (state === "offline" && (b.online || !b.isActive)) return false;
      if (state === "off" && b.isActive) return false;
      if (cat && (cat === "none" ? b.categoryId : b.categoryId !== cat)) return false;
      if (pay === "debt" ? b.pay !== "overdue" && b.pay !== "soon" : pay && b.pay !== pay) return false;
      const a = activityOf(b.online, b.lastSeenAt);
      if (act === "quiet" ? !["month", "long", "never"].includes(a) : act && a !== act) return false;
      if (words.length) {
        const hay = norm([b.name, b.email, b.code, b.note].filter(Boolean).join(" "));
        if (!words.every((w) => hay.includes(w))) return false;
      }
      return true;
    });
    const seen = (b: Box) => (b.online ? Date.now() + 1 : b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0);
    const paid = (b: Box) => (b.pay === "free" ? Infinity : b.paidUntil ? new Date(b.paidUntil).getTime() : -Infinity);
    const title = (b: Box) => b.name ?? b.email;
    const by: Record<Sort, (a: Box, b: Box) => number> = {
      seen: (a, b) => seen(b) - seen(a),
      name: (a, b) => title(a).localeCompare(title(b), "ru"),
      paid: (a, b) => paid(a) - paid(b),
      traffic: (a, b) => b.trafficBytes - a.trafficBytes,
      created: (a, b) => b.createdAt.localeCompare(a.createdAt),
    };
    return [...list].sort((a, b) => by[sort](a, b) || title(a).localeCompare(title(b), "ru"));
  }, [rows, q, state, cat, pay, act, sort]);

  async function toggle(box: Box) {
    await api.patch(`/platform/boxes/${box.id}`, { isActive: !box.isActive });
    await load();
  }

  async function reissue(box: Box) {
    const next = await api.post<Issued>(`/platform/boxes/${box.id}/key`, {});
    setConfirmKey(null);
    setIssued(next);
    await load();
  }

  /** Имя освобождается, Основа переподключится и предложит владельцу выбрать новое. */
  async function freeName(box: Box) {
    await api.patch(`/platform/boxes/${box.id}`, { name: null });
    setConfirmFree(null);
    await load();
  }

  /**
   * Удалить доступ совсем.
   *
   * «Выключить» — это пауза: мастерская отвалилась, но запись осталась, и
   * включить обратно можно одним нажатием. Удаление — насовсем: освобождает
   * и код, и имя мастерской, а ей придётся выдавать доступ заново.
   */
  async function drop(box: Box) {
    await api.del(`/platform/boxes/${box.id}`);
    setConfirmDrop(null);
    await load();
  }

  if (error) return <Banner tone="error">{error}</Banner>;
  if (!rows) return <Spinner />;

  const online = rows.filter((r) => r.online).length;
  const traffic = rows.reduce((a, r) => a + r.trafficBytes, 0);
  const filtered = !!(q || cat || pay || act || state);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <SectionLabel>Платформа</SectionLabel>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight">Локальные мастерские</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {rows.length
              ? `${plural(rows.length, "мастерская", "мастерские", "мастерских")} с доступом из интернета · ${online} на связи · трафик за месяц ${bytes(traffic)}`
              : "Доступ из интернета пока никому не открыт"}
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>Открыть доступ</Button>
      </div>

      {rows.length > 0 && (
        <div className="space-y-2.5">
          <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Имя, почта, код, заметка" aria-label="Поиск мастерской" />
          <div className="flex flex-wrap gap-2">
            <FilterSelect label="Связь" value={state} onChange={(v) => setState(v as StateFilter)}>
              <option value="">все</option>
              <option value="online">на связи</option>
              <option value="offline">не на связи</option>
              <option value="off">доступ выключен</option>
            </FilterSelect>
            <FilterSelect label="Категория" value={cat} onChange={setCat}>
              <option value="">все</option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              <option value="none">без категории</option>
            </FilterSelect>
            <FilterSelect label="Оплата" value={pay} onChange={(v) => setPay(v as PayFilter)}>
              <option value="">любая</option>
              <option value="debt">пора платить</option>
              <option value="overdue">просрочено</option>
              <option value="soon">меньше недели</option>
              <option value="paid">оплачено</option>
              <option value="none">срок не задан</option>
              <option value="free">бесплатно</option>
            </FilterSelect>
            <FilterSelect label="Активность" value={act} onChange={(v) => setAct(v as ActFilter)}>
              <option value="">любая</option>
              <option value="online">на связи</option>
              <option value="day">сегодня</option>
              <option value="week">за неделю</option>
              <option value="quiet">давно не было</option>
              <option value="never">не подключалась</option>
            </FilterSelect>
            <SortSelect value={sort} options={SORTS} onChange={setSort} />
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState title="Пока никому не открыт">
          Локальная мастерская работает у себя по локальной сети. Чтобы сотрудники могли заходить и снаружи,
          выдайте доступ на почту владельца — он получит фразу подключения и вставит её в программе, в разделе
          «Настройки → Доступ из интернета».
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState title="Никого не нашлось">
          {filtered ? "Под выбранный отбор никто не подходит — ослабьте фильтры." : "Список пуст."}
        </EmptyState>
      ) : (
        <List>
          {shown.map((b) => (
            <div key={b.id} role="button" tabIndex={0} onClick={() => setOpen(b)} onKeyDown={(e) => e.key === "Enter" && setOpen(b)} className="cursor-pointer">
              <ListRow
                className={b.isActive ? undefined : "opacity-60"}
                glyph={<KindMark kind="local" online={b.online} />}
                title={
                  <>
                    <span className={b.isActive ? "truncate" : "truncate line-through"}>{b.name ? `@${b.name}` : b.email}</span>
                    <CategoryChip category={b.categoryId ? catBy.get(b.categoryId) : null} />
                    {!b.isActive && <Badge tone="danger">выключен</Badge>}
                  </>
                }
                subtitle={
                  <>
                    {b.name && <span>{b.email} · </span>}
                    <a
                      href={addressOf(b.code)}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="font-mono text-[12.5px] text-brand-ink hover:underline"
                    >
                      /b/{b.code}/
                    </a>
                    {!b.name && <span className="text-ink-dim"> · имя не выбрано</span>}
                    {b.previousName && <span className="text-ink-dim"> · прежнее @{b.previousName}</span>}
                    <span className="text-ink-dim"> · ключ …{b.keyHint}</span>
                    {b.note && <span className="text-ink-dim"> · {b.note}</span>}
                    <span className="text-ink-dim"> · с {formatDate(b.createdAt)}</span>
                  </>
                }
                meta={
                  <>
                    <span className="lg:w-[118px]">
                      <Seen online={b.online} at={b.lastSeenAt} />
                    </span>
                    <span className="whitespace-nowrap lg:w-[130px]" title="Трафик доступа из интернета за месяц">
                      {bytes(b.trafficBytes)} · {b.trafficRequests} запр.
                    </span>
                    <span className="lg:w-[150px] lg:text-right">
                      <PayText pay={b.pay} paidUntil={b.paidUntil} price={b.price} />
                    </span>
                  </>
                }
                actions={
                  <RowMenu
                    items={[
                      { label: "Условия и оплата", onClick: () => setOpen(b) },
                      { label: "Новая фраза…", onClick: () => setConfirmKey(b) },
                      { label: b.isActive ? "Выключить доступ" : "Включить доступ", onClick: () => void toggle(b), danger: b.isActive },
                      !!b.name && { label: "Освободить имя…", onClick: () => setConfirmFree(b) },
                      { label: "Удалить…", onClick: () => setConfirmDrop(b), danger: true },
                    ]}
                  />
                }
              />
            </div>
          ))}
        </List>
      )}

      {open && (
        <ClientModal
          target={(() => {
            const b = rows.find((r) => r.id === open.id) ?? open;
            return {
              kind: "local" as const,
              id: b.id,
              name: b.name ? `@${b.name} · ${b.email}` : b.email,
              categoryId: b.categoryId,
              ownPrice: b.ownPrice,
              price: b.price,
              paidUntil: b.paidUntil,
            };
          })()}
          categories={cats}
          canEdit={isOwner}
          onClose={() => setOpen(null)}
          onChanged={() => void load()}
        />
      )}

      {creating && (
        <NewBoxModal
          onClose={() => setCreating(false)}
          onDone={(box) => {
            setCreating(false);
            setIssued(box);
            void load();
          }}
        />
      )}

      {confirmKey && (
        <Modal title={`Новая фраза для ${confirmKey.email}`} onClose={() => setConfirmKey(null)}>
          <div className="space-y-4">
            <Banner tone="warning">
              Прежняя фраза перестанет работать сразу, и мастерская отключится. Новую придётся вставить
              в программе — до этого доступ из интернета работать не будет.
            </Banner>
            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              <Button variant="danger" onClick={() => void reissue(confirmKey)} className="sm:flex-1">
                Выпустить новую
              </Button>
              <Button variant="secondary" onClick={() => setConfirmKey(null)} className="sm:flex-1">
                Отмена
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {confirmFree && (
        <Modal title={`Освободить имя @${confirmFree.name}?`} onClose={() => setConfirmFree(null)}>
          <div className="space-y-4">
            <Banner tone="warning">
              Сотрудники мастерской {confirmFree.email} перестанут входить с общего сайта логинами
              вида имя@{confirmFree.name}, а само имя сможет занять другая мастерская. В локальной сети
              всё продолжит работать. Владелец сможет выбрать имя заново у себя в программе.
            </Banner>
            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              <Button variant="danger" onClick={() => void freeName(confirmFree)} className="sm:flex-1">
                Освободить
              </Button>
              <Button variant="secondary" onClick={() => setConfirmFree(null)} className="sm:flex-1">
                Отмена
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {confirmDrop && (
        <Modal title={`Удалить доступ для ${confirmDrop.email}?`} onClose={() => setConfirmDrop(null)}>
          <div className="space-y-4">
            <Banner tone="warning">
              Мастерская отключится сразу, её адрес и имя освободятся, а сотрудники перестанут
              входить с общего сайта. Заказы и база при этом останутся на компьютере мастерской —
              программа продолжит работать по локальной сети.
            </Banner>
            <p className="text-[13.5px] text-ink-muted">
              Если нужно просто приостановить услугу, лучше «Выключить доступ»: запись останется, и доступ
              вернётся одним нажатием.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              <Button variant="danger" onClick={() => void drop(confirmDrop)} className="sm:flex-1">
                Удалить насовсем
              </Button>
              <Button variant="secondary" onClick={() => setConfirmDrop(null)} className="sm:flex-1">
                Отмена
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {issued && <PhraseModal issued={issued} onClose={() => setIssued(null)} />}
    </div>
  );
}

/**
 * Открыть доступ — одно поле.
 *
 * Спрашиваем только почту того, кто запросил доступ: она же подпись в списке
 * и адресат письма, когда фразу попросят прислать заново. Код в адресе сервер
 * придумывает сам и делает его случайным — из почты его не выводят нарочно,
 * чтобы по чужому адресу нельзя было догадаться, чья это мастерская.
 */
function NewBoxModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (b: Issued) => void;
}) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const box = await api.post<Issued>("/platform/boxes", { email });
      onDone(box);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Открыть доступ из интернета" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Banner tone="error">{error.message}</Banner>}
        <Field
          label="Email владельца мастерской"
          error={error?.field("email")}
          hint="На эту почту выдаётся доступ: по ней видно, чей это ключ, и на неё же можно будет выслать фразу заново. Адрес мастерской сервер придумает сам — случайный, чтобы его нельзя было угадать по почте"
        >
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoCapitalize="none"
            autoFocus
            invalid={!!error?.field("email")}
            placeholder="master@servis.ru"
          />
        </Field>
        <div className="flex flex-col gap-2 pt-2 sm:flex-row-reverse">
          <Button type="submit" disabled={busy || !email.includes("@")} className="sm:flex-1">
            {busy ? "Открываем…" : "Получить фразу"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} className="sm:flex-1">
            Отмена
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Единственный раз, когда доступ виден целиком.
 *
 * Отдаём одной фразой: в ней и адрес узла связи, и ключ, и код мастерской.
 * Передавать три строки по телефону — это три возможности ошибиться, а одна
 * копируется кнопкой и вставляется целиком.
 */
function PhraseModal({
  issued,
  onClose,
}: {
  issued: Issued;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      setCopied(null);
    }
  };

  const box = "mt-1.5 break-all rounded-field border border-line bg-surface-input px-3 py-2.5 font-mono text-[13px]";

  return (
    <Modal title="Доступ открыт" onClose={onClose}>
      <div className="space-y-4">
        <Banner tone="warning">
          Фраза показывается один раз: у нас хранится только отпечаток ключа. Передайте её мастерской —
          там её вставляют в «Настройки → Доступ из интернета» и нажимают «Подключить».
        </Banner>

        <p className="text-[13.5px] text-ink-muted">
          Доступ выдан на почту <span className="font-semibold text-ink">{issued.email}</span>.
        </p>

        <div>
          <span className="text-[13px] font-semibold text-ink-soft">Фраза подключения</span>
          <div className={box}>{issued.phrase}</div>
        </div>

        <div>
          <span className="text-[13px] font-semibold text-ink-soft">Адрес мастерской после подключения</span>
          <div className={box}>{issued.address}</div>
        </div>

        <p className="text-[12.5px] leading-relaxed text-ink-dim">
          Имя мастерской для логинов сотрудников владелец выберет сам — в программе, в «Доступе из
          интернета», сразу после того как вставит фразу.
        </p>

        {copied && <p className="text-center text-[13px] text-state-done">Скопировано: {copied}</p>}

        <Button type="button" onClick={() => void copy(issued.phrase, "фраза")} className="w-full">
          Скопировать фразу
        </Button>
        <div className="grid gap-2 sm:grid-cols-2">
          <Button type="button" variant="secondary" onClick={() => void copy(issued.address, "адрес")}>
            Скопировать адрес
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            Готово
          </Button>
        </div>
      </div>
    </Modal>
  );
}
