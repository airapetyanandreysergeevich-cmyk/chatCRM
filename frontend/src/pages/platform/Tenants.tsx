import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Modal } from "../../components/Modal";
import {
  CategoryChip,
  ClientModal,
  FilterSelect,
  KindMark,
  PayText,
  RowMenu,
  Seen,
  UsageBar,
  norm,
  usePref,
  type ClientTarget,
} from "../../components/platform/ClientBits";
import { SortSelect } from "../../components/ListControls";
import { IconStaff } from "../../components/icons";
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
  Select,
  Spinner,
  Textarea,
} from "../../components/ui";
import { ApiError, api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDate, plural } from "../../lib/format";
import {
  activityOf,
  bytes,
  platformApi,
  type Activity,
  type Category,
  type PayState,
  type TenantRow,
} from "../../lib/platformApi";
import {
  brandsFromText,
  brandsToText,
  modelLinesWithoutBrand,
  modelsFromText,
  modelsToText,
  noiseFromText,
  patternFromModel,
  plateDictionaryApi,
  type DictionaryReply,
  type PlateMiss,
} from "../../lib/plateDictionary";

/**
 * Облачные мастерские — строками, с отбором и сортировкой.
 *
 * В строке то, что нужно собственнику облака: жива ли мастерская, в какой
 * она категории, заплатила ли, сколько занимает места и людей. Заказов и
 * прочего содержимого мастерской здесь нет — это её дело, не наше. Войти в
 * мастерскую отсюда тоже нельзя.
 */

const STATUS_BADGE: Record<TenantRow["status"], { text: string; tone: "warning" | "danger" } | null> = {
  ACTIVE: null,
  READONLY: { text: "только чтение", tone: "warning" },
  SUSPENDED: { text: "приостановлена", tone: "danger" },
};

type StatusFilter = "work" | "readonly" | "suspended" | "archive" | "all";
type PayFilter = "" | PayState | "debt";
type ActFilter = "" | Activity | "quiet";
type Sort = "seen" | "name" | "paid" | "storage" | "users" | "created";

const SORTS: Array<{ value: Sort; label: string }> = [
  { value: "seen", label: "по активности" },
  { value: "paid", label: "по сроку оплаты" },
  { value: "storage", label: "по занятому месту" },
  { value: "users", label: "по сотрудникам" },
  { value: "name", label: "по названию" },
  { value: "created", label: "сначала новые" },
];

const MB = 1024 * 1024;

export default function Tenants() {
  const { me } = useAuth();
  // Цены, лимиты и оплату меняет собственник; администратор только смотрит.
  const isOwner = me?.kind === "platform" && me.platformUser.role === "OWNER";
  const [rows, setRows] = useState<TenantRow[] | null>(null);
  const [cats, setCats] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [removing, setRemoving] = useState<TenantRow | null>(null);
  const [open, setOpen] = useState<TenantRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dictionary, setDictionary] = useState(false);

  const [q, setQ] = useState("");
  const [status, setStatus] = usePref<StatusFilter>("platform.tenants.status", "work", ["work", "readonly", "suspended", "archive", "all"]);
  const [cat, setCat] = useState("");
  const [pay, setPay] = usePref<PayFilter>("platform.tenants.pay", "", ["", "paid", "soon", "overdue", "none", "free", "debt"]);
  const [act, setAct] = usePref<ActFilter>("platform.tenants.act", "", ["", "online", "day", "week", "month", "long", "never", "quiet"]);
  const [sort, setSort] = usePref<Sort>("platform.tenants.sort", "seen", ["seen", "name", "paid", "storage", "users", "created"]);

  const load = useCallback(async () => {
    try {
      const [t, c] = await Promise.all([platformApi.tenants(), platformApi.categories()]);
      setRows(t);
      setCats(c);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить список");
    }
  }, []);

  useEffect(() => {
    void load();
    // «В сети» меняется само: обновляем раз в минуту, чтобы список не врал.
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  const catBy = useMemo(() => new Map(cats.map((c) => [c.id, c])), [cats]);

  const shown = useMemo(() => {
    if (!rows) return [];
    const words = norm(q).split(/\s+/).filter(Boolean);
    const list = rows.filter((t) => {
      if (status === "archive" ? !t.archivedAt : status !== "all" && t.archivedAt) return false;
      if (status === "work" && t.status !== "ACTIVE") return false;
      if (status === "readonly" && t.status !== "READONLY") return false;
      if (status === "suspended" && t.status !== "SUSPENDED") return false;
      if (cat && (cat === "none" ? t.categoryId : t.categoryId !== cat)) return false;
      if (pay === "debt" ? t.pay !== "overdue" && t.pay !== "soon" : pay && t.pay !== pay) return false;
      const a = activityOf(t.online, t.lastSeenAt);
      if (act === "quiet" ? !["month", "long", "never"].includes(a) : act && a !== act) return false;
      if (words.length) {
        const hay = norm([t.name, t.slug, t.contactName, t.contactPhone, t.contactEmail].filter(Boolean).join(" "));
        if (!words.every((w) => hay.includes(w))) return false;
      }
      return true;
    });
    const seen = (t: TenantRow) => (t.online ? Date.now() + 1 : t.lastSeenAt ? new Date(t.lastSeenAt).getTime() : 0);
    const paid = (t: TenantRow) => (t.pay === "free" ? Infinity : t.paidUntil ? new Date(t.paidUntil).getTime() : -Infinity);
    const by: Record<Sort, (a: TenantRow, b: TenantRow) => number> = {
      seen: (a, b) => seen(b) - seen(a),
      name: (a, b) => a.name.localeCompare(b.name, "ru"),
      paid: (a, b) => paid(a) - paid(b),
      storage: (a, b) => b.storageBytes - a.storageBytes,
      users: (a, b) => b.userCount - a.userCount,
      created: (a, b) => b.createdAt.localeCompare(a.createdAt),
    };
    return [...list].sort((a, b) => by[sort](a, b) || a.name.localeCompare(b.name, "ru"));
  }, [rows, q, status, cat, pay, act, sort]);

  async function changeStatus(t: TenantRow, next: TenantRow["status"]) {
    try {
      await api.patch(`/platform/tenants/${t.id}`, { status: next });
      await load();
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : "Не удалось сменить состояние");
    }
  }

  /**
   * В архив — без вопросов, обратно — тоже. Спрашивать имеет смысл только
   * там, откуда нет пути назад, а это отдельное окно.
   */
  async function archive(t: TenantRow, toArchive: boolean) {
    try {
      await api.post(`/platform/tenants/${t.id}/${toArchive ? "archive" : "restore"}`, {});
      await load();
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : "Не удалось");
    }
  }

  if (error) return <Banner tone="error">{error}</Banner>;
  if (!rows) return <Spinner />;

  const live = rows.filter((r) => !r.archivedAt);
  const online = live.filter((r) => r.online).length;
  const used = live.reduce((a, r) => a + r.storageBytes, 0);
  const filtered = !!(q || cat || pay || act || status !== "work");

  const target = (t: TenantRow): ClientTarget => ({
    kind: "cloud",
    id: t.id,
    name: t.name,
    categoryId: t.categoryId,
    ownPrice: t.ownPrice,
    price: t.price,
    paidUntil: t.paidUntil,
    limits: { maxUsers: t.maxUsers, maxStorageMb: t.maxStorageMb, plateOcr: t.plateOcr, customLimits: t.customLimits },
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <SectionLabel>Платформа</SectionLabel>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight">Облачные мастерские</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {live.length ? plural(live.length, "мастерская", "мастерские", "мастерских") : "Пока ни одной"}
            {live.length > 0 && ` · ${online} в сети · фото ${bytes(used)}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setDictionary(true)}>
            Словарь шильдиков
          </Button>
          <Button onClick={() => setCreating(true)}>Новая мастерская</Button>
        </div>
      </div>

      {notice && <Banner tone="error">{notice}</Banner>}

      {rows.length > 0 && (
        <div className="space-y-2.5">
          <SearchInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Название, код, контакт" aria-label="Поиск мастерской" />
          <div className="flex flex-wrap gap-2">
            <FilterSelect label="Состояние" value={status} onChange={(v) => setStatus(v as StatusFilter)}>
              <option value="work">работают</option>
              <option value="readonly">только чтение</option>
              <option value="suspended">приостановлены</option>
              <option value="archive">в архиве</option>
              <option value="all">все</option>
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
              <option value="online">в сети</option>
              <option value="day">сегодня</option>
              <option value="week">за неделю</option>
              <option value="quiet">давно не заходили</option>
              <option value="never">не заходили</option>
            </FilterSelect>
            <SortSelect value={sort} options={SORTS} onChange={setSort} />
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState title="Пока ни одной">
          Заведите первую мастерскую — владелец получит логин и сможет сразу принимать технику.
        </EmptyState>
      ) : shown.length === 0 ? (
        <EmptyState title="Никого не нашлось">
          {filtered ? "Под выбранный отбор никто не подходит — ослабьте фильтры." : "Список пуст."}
        </EmptyState>
      ) : (
        <List>
          {shown.map((t) => {
            const badge = STATUS_BADGE[t.status];
            return (
              <div key={t.id} role="button" tabIndex={0} onClick={() => setOpen(t)} onKeyDown={(e) => e.key === "Enter" && setOpen(t)} className="cursor-pointer">
                <ListRow
                  className={t.archivedAt ? "opacity-60" : undefined}
                  glyph={<KindMark kind="cloud" online={t.online} />}
                  title={
                    <>
                      <span className="truncate">{t.name}</span>
                      <CategoryChip category={t.categoryId ? catBy.get(t.categoryId) : null} />
                      {t.archivedAt ? <Badge tone="danger">в архиве</Badge> : badge && <Badge tone={badge.tone}>{badge.text}</Badge>}
                    </>
                  }
                  subtitle={
                    <>
                      <span className="font-mono text-[12.5px]">{t.slug}</span>
                      {t.contactName && <span> · {t.contactName}</span>}
                      {t.contactPhone && <span> · {t.contactPhone}</span>}
                      <span className="text-ink-dim"> · с {formatDate(t.createdAt)}</span>
                    </>
                  }
                  meta={
                    <>
                      <span className="lg:w-[118px]">
                        <Seen online={t.online} at={t.lastSeenAt} />
                      </span>
                      <span className="inline-flex items-center gap-1 whitespace-nowrap lg:w-[64px]" title="Сотрудники: есть / можно">
                        <IconStaff className="h-3.5 w-3.5" />
                        <b className="text-ink-soft">{t.userCount}</b>/{t.maxUsers}
                      </span>
                      <span className="w-[150px]" title="Фотографии в облаке">
                        <UsageBar used={t.storageBytes} limit={t.maxStorageMb * MB} />
                      </span>
                      <span className="whitespace-nowrap lg:w-[86px]" title="Снимков шильдиков за месяц">
                        {t.plateOcr ? `шильдики ${t.plateOcrMonth}` : "шильдики выкл"}
                      </span>
                      <span className="lg:w-[150px] lg:text-right">
                        <PayText pay={t.pay} paidUntil={t.paidUntil} price={t.price} />
                      </span>
                    </>
                  }
                  actions={
                    <RowMenu
                      items={
                        t.archivedAt
                          ? [
                              { label: "Вернуть из архива", onClick: () => void archive(t, false) },
                              isOwner && { label: "Удалить насовсем…", onClick: () => setRemoving(t), danger: true },
                            ]
                          : [
                              { label: "Условия и оплата", onClick: () => setOpen(t) },
                              t.status === "ACTIVE"
                                ? { label: "Перевести в чтение", onClick: () => void changeStatus(t, "READONLY") }
                                : { label: "Вернуть в работу", onClick: () => void changeStatus(t, "ACTIVE") },
                              t.status !== "SUSPENDED" && { label: "Приостановить", onClick: () => void changeStatus(t, "SUSPENDED") },
                              { label: "В архив", onClick: () => void archive(t, true), danger: true },
                            ]
                      }
                    />
                  }
                />
              </div>
            );
          })}
        </List>
      )}

      {open && (
        <ClientModal
          target={target(rows.find((r) => r.id === open.id) ?? open)}
          categories={cats}
          canEdit={isOwner}
          onClose={() => setOpen(null)}
          onChanged={() => void load()}
        />
      )}

      {dictionary && <DictionaryModal canEdit={isOwner} onClose={() => setDictionary(false)} />}

      {creating && (
        <CreateTenantModal
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            void load();
          }}
        />
      )}

      {removing && (
        <RemoveTenantModal
          tenant={removing}
          onClose={() => setRemoving(null)}
          onDone={() => {
            setRemoving(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function CreateTenantModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({
    name: "",
    slug: "",
    ownerFullName: "",
    ownerEmail: "",
    ownerPassword: "",
    contactPhone: "",
    timezone: "Europe/Moscow",
  });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/platform/tenants", form);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Новая мастерская" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Banner tone="error">{error.message}</Banner>}

        <Field label="Название" error={error?.field("name")}>
          <Input value={form.name} onChange={set("name")} placeholder="Сервис на Ленина" invalid={!!error?.field("name")} />
        </Field>
        <Field
          label="Код мастерской"
          error={error?.field("slug")}
          hint="Короткий код для служебных нужд: адреса, имена файлов. Латиница, цифры и дефис."
        >
          <Input value={form.slug} onChange={set("slug")} placeholder="lenina" autoCapitalize="none" invalid={!!error?.field("slug")} />
        </Field>

        <div className="border-t border-line pt-4">
          <SectionLabel>Учётная запись владельца</SectionLabel>
        </div>

        <Field label="Имя владельца" error={error?.field("ownerFullName")}>
          <Input value={form.ownerFullName} onChange={set("ownerFullName")} invalid={!!error?.field("ownerFullName")} />
        </Field>
        <Field label="Email" error={error?.field("ownerEmail")} hint="По нему владелец входит в систему">
          <Input
            type="email"
            value={form.ownerEmail}
            onChange={set("ownerEmail")}
            autoCapitalize="none"
            invalid={!!error?.field("ownerEmail")}
          />
        </Field>
        <Field label="Пароль" error={error?.field("ownerPassword")} hint="Передайте владельцу — он сменит его сам">
          <Input value={form.ownerPassword} onChange={set("ownerPassword")} invalid={!!error?.field("ownerPassword")} />
        </Field>
        <Field label="Телефон для связи">
          <Input value={form.contactPhone} onChange={set("contactPhone")} />
        </Field>
        <Field label="Часовой пояс">
          <Select value={form.timezone} onChange={set("timezone")}>
            {["Europe/Kaliningrad", "Europe/Moscow", "Europe/Samara", "Asia/Yekaterinburg", "Asia/Omsk", "Asia/Krasnoyarsk", "Asia/Irkutsk", "Asia/Yakutsk", "Asia/Vladivostok"].map(
              (tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              )
            )}
          </Select>
        </Field>

        <div className="flex flex-col gap-2 pt-2 sm:flex-row-reverse">
          <Button type="submit" disabled={busy} className="sm:flex-1">
            {busy ? "Создаём…" : "Создать мастерскую"}
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
 * Удаление насовсем.
 *
 * Название вводится целиком и вручную — не для церемонии. Это единственное
 * действие во всей платформе, у которого нет отмены: после него от мастерской
 * не остаётся ни заказов, ни клиентов, ни фотографий. Кнопка, которую можно
 * нажать не глядя, рано или поздно будет нажата не глядя.
 */
function RemoveTenantModal({
  tenant,
  onClose,
  onDone,
}: {
  tenant: TenantRow;
  onClose: () => void;
  onDone: () => void;
}) {
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const matches = confirm.trim() === tenant.name;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.del(`/platform/tenants/${tenant.id}`, { confirm: confirm.trim() });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Не удалось удалить"));
      setBusy(false);
    }
  }

  return (
    <Modal title="Удалить мастерскую насовсем" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Banner tone="error">
          Будут стёрты все заказы, клиенты, фотографии, склад, касса и сотрудники мастерской «{tenant.name}».
          Восстановить это будет нечем — резервная копия платформы тоже перестанет их содержать со следующей
          выгрузки.
        </Banner>

        <Field
          label={`Введите название мастерской: ${tenant.name}`}
          hint="Так же, как написано выше, буква в букву"
          error={error?.message}
        >
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoFocus invalid={!!error} />
        </Field>

        <div className="flex flex-col gap-2 pt-2 sm:flex-row-reverse">
          <Button type="submit" variant="danger" disabled={busy || !matches} className="sm:flex-1">
            {busy ? "Удаляю…" : "Удалить насовсем"}
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
 * Словарь распознавания шильдиков: марки, лишние слова и марка по модели.
 *
 * Встроенное показано рядом, но не правится: оно проверено на настоящих
 * шильдиках тестами. Словарь дополняет встроенное — новая марка, другое
 * написание знакомой («Hewlett-Packard: HP»), фраза, которую надо отрезать
 * от модели («Made in China»), шаблон модели для шильдиков без марки.
 *
 * Ниже — модели, у которых марка при распознавании не нашлась: по ним видно,
 * каких правил не хватает, и правило добавляется одной кнопкой.
 */
function DictionaryModal({ canEdit, onClose }: { canEdit: boolean; onClose: () => void }) {
  const [reply, setReply] = useState<DictionaryReply | null>(null);
  const [brands, setBrands] = useState("");
  const [noise, setNoise] = useState("");
  const [models, setModels] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [misses, setMisses] = useState<PlateMiss[] | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  const fill = (r: DictionaryReply) => {
    setReply(r);
    setBrands(brandsToText(r.dictionary.brands));
    setNoise(r.dictionary.noise.join("\n"));
    setModels(modelsToText(r.dictionary.models));
  };

  const loadMisses = useCallback(() => {
    plateDictionaryApi
      .misses()
      .then((r) => setMisses(r.items))
      .catch(() => setMisses([]));
  }, []);

  useEffect(() => {
    plateDictionaryApi
      .get()
      .then(fill)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить словарь"));
    loadMisses();
  }, [loadMisses]);

  const orphan = modelLinesWithoutBrand(models);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    setAdded(null);
    try {
      fill(
        await plateDictionaryApi.save({
          brands: brandsFromText(brands),
          noise: noiseFromText(noise),
          models: modelsFromText(models),
        })
      );
      setSaved(true);
      loadMisses();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить словарь");
    } finally {
      setBusy(false);
    }
  }

  function addRule(brand: string, model: string) {
    const b = brand.replace(/\s+/g, " ").trim();
    if (b.length < 2) return;
    const pattern = patternFromModel(model);
    // Марка уже есть в поле — шаблон дописываем в её строку.
    const lines = models.split(/\r?\n/);
    const at = lines.findIndex((l) => l.split(":")[0].trim().toLowerCase() === b.toLowerCase() && l.includes(":"));
    if (at === -1) lines.push(`${b}: ${pattern}`);
    else if (!lines[at].toUpperCase().includes(pattern)) lines[at] = `${lines[at].replace(/[\s,]+$/, "")}, ${pattern}`;
    setModels(lines.filter((l, i) => l.trim() || i < lines.length - 1).join("\n").replace(/^\n+/, ""));
    setSaved(false);
    setAdded(`${b}: ${pattern}`);
  }

  async function hide(key: string) {
    setMisses((m) => m?.filter((x) => x.modelKey !== key) ?? null);
    await plateDictionaryApi.hideMiss(key).catch(() => loadMisses());
  }

  return (
    <Modal title="Словарь шильдиков" onClose={onClose} wide>
      {!reply && !error ? (
        <Spinner />
      ) : (
        <form onSubmit={save} className="space-y-4">
          {error && <Banner tone="error">{error}</Banner>}
          {saved && <Banner>Сохранено. Приёмщики получат словарь в течение минуты, Основы — в течение шести часов.</Banner>}

          <div className="grid gap-4 md:grid-cols-2">
            <Field
              label="Марки"
              hint="По одной в строке. Другие написания и серии — через двоеточие и запятые: «MSI: Cyborg, Raider». По серии находится и марка, и модель после неё. До 100 на марку"
            >
              <Textarea
                value={brands}
                onChange={(e) => setBrands(e.target.value)}
                rows={6}
                readOnly={!canEdit}
                placeholder={"Haier\nRaybook\nHewlett-Packard: HP"}
                className="font-mono text-[13.5px]"
              />
            </Field>
            <Field label="Лишние слова" hint="По одной фразе в строке. Модель обрывается на первой такой фразе">
              <Textarea
                value={noise}
                onChange={(e) => setNoise(e.target.value)}
                rows={6}
                readOnly={!canEdit}
                placeholder={"Energy Star\nTUV Rheinland"}
                className="font-mono text-[13.5px]"
              />
            </Field>
          </div>

          <Field
            label="Марка по модели"
            hint="Для шильдиков без марки. Марка, двоеточие, шаблоны через запятую: * — любые знаки, # — цифра, @ — буква. Дефис необязателен, регистр не важен"
            error={orphan.length ? `Без марки и двоеточия — не сохранится: ${orphan.slice(0, 3).join("; ")}` : undefined}
          >
            <Textarea
              value={models}
              onChange={(e) => {
                setModels(e.target.value);
                setAdded(null);
              }}
              rows={5}
              readOnly={!canEdit}
              placeholder={"ASUS: X5##@*, D5##@*\nRaybook: RB-1###*"}
              className="font-mono text-[13.5px]"
            />
          </Field>
          {added && (
            <p className="-mt-2 text-[12.5px] text-ink-dim">
              Добавлено «{added}». Поправьте шаблон, если нужно шире или уже, и нажмите «Сохранить».
            </p>
          )}

          {reply && (
            <details className="rounded-field border border-line px-3 py-2 text-[13px]">
              <summary className="cursor-pointer font-semibold text-ink-muted">Уже встроено в программу</summary>
              <p className="mt-2 text-ink-dim">
                <span className="font-semibold text-ink-soft">Марки: </span>
                {reply.builtin.brands.join(", ")}
              </p>
              <p className="mt-2 text-ink-dim">
                <span className="font-semibold text-ink-soft">Лишние слова: </span>
                {reply.builtin.noise.join(", ")}
              </p>
              {reply.builtin.series && (
                <div className="mt-2 text-ink-dim">
                  <span className="font-semibold text-ink-soft">Серии:</span>
                  <ul className="mt-1 space-y-0.5 text-[12.5px]">
                    {reply.builtin.series.map((m) => (
                      <li key={m.brand}>
                        <span className="font-semibold text-ink-soft">{m.brand}:</span> {m.series.join(", ")}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {reply.builtin.models && (
                <div className="mt-2 text-ink-dim">
                  <span className="font-semibold text-ink-soft">Марка по модели:</span>
                  <ul className="mt-1 space-y-0.5 font-mono text-[12px]">
                    {reply.builtin.models.map((m) => (
                      <li key={m.brand}>
                        {m.brand}: {m.patterns.join(", ")}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="mt-2 text-ink-dim">
                Сверх того каждая мастерская узнаёт марки, которые сама вводила в бланке не меньше двух раз. Марку по
                модели программа берёт и из заказов: своей мастерской хватает одного заказа с этой моделью, а от других
                — нужно, чтобы марку вписали хотя бы две мастерские и против почти никто.
              </p>
            </details>
          )}

          <MissList misses={misses} canEdit={canEdit} onAdd={addRule} onHide={hide} />

          <div className="flex flex-col gap-2 pt-2 sm:flex-row-reverse">
            {canEdit && (
              <Button type="submit" disabled={busy} className="sm:flex-1">
                {busy ? "Сохраняем…" : "Сохранить"}
              </Button>
            )}
            <Button type="button" variant="secondary" onClick={onClose} className="sm:flex-1">
              {canEdit ? "Закрыть" : "Закрыть (правит собственник)"}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/**
 * Модели, у которых марка при распознавании не нашлась, — со всех мастерских.
 * Сначала те, что не узнаются и сейчас. Марку в поле подсказывает то, что
 * мастерские вписывали руками.
 */
function MissList({
  misses,
  canEdit,
  onAdd,
  onHide,
}: {
  misses: PlateMiss[] | null;
  canEdit: boolean;
  onAdd: (brand: string, model: string) => void;
  onHide: (key: string) => void;
}) {
  const [all, setAll] = useState(false);
  const [brandFor, setBrandFor] = useState<Record<string, string>>({});
  if (!misses) return null;
  const open = misses.filter((m) => !m.resolved);
  const shown = all ? misses : misses.slice(0, 12);

  return (
    <div className="rounded-field border border-line">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-line px-3 py-2">
        <p className="text-[13px] font-semibold text-ink-soft">Модели без марки</p>
        <p className="text-[12px] text-ink-dim">
          {misses.length
            ? `${open.length} не узнаются · ${misses.length - open.length} уже узнаются`
            : "Пока пусто: все распознанные модели получили марку"}
        </p>
      </div>
      {misses.length > 0 && (
        <ul className="divide-y divide-line">
          {shown.map((m) => {
            const guess = brandFor[m.modelKey] ?? m.votes[0]?.brand ?? "";
            return (
              <li key={m.modelKey} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
                <div className="min-w-[150px] flex-1">
                  <p className="break-all font-mono text-[13.5px] font-semibold">{m.model}</p>
                  <p className="mt-0.5 text-[12px] text-ink-dim">
                    {plural(m.uses, "снимок", "снимка", "снимков")} · {formatDate(m.lastAt)}
                    {m.workshops > 1 ? ` · из ${m.workshops} мест` : ""}
                  </p>
                </div>
                {m.resolved ? (
                  <p className="text-[12.5px] text-stage-done">
                    узнаётся: <span className="font-semibold">{m.resolved.brand}</span>{" "}
                    {m.resolved.by === "rule" ? "по правилу" : "по заказам"}
                  </p>
                ) : (
                  <>
                    {m.votes.length > 0 && (
                      <p className="text-[12px] text-ink-dim">
                        вписывали: {m.votes.map((v) => `${v.brand}${v.sources > 1 ? ` (${v.sources})` : ""}`).join(", ")}
                      </p>
                    )}
                    {canEdit && (
                      <div className="flex items-center gap-2">
                        <div className="w-[140px]">
                          <Input
                            value={guess}
                            onChange={(e) => setBrandFor((b) => ({ ...b, [m.modelKey]: e.target.value }))}
                            placeholder="Марка"
                            aria-label={`Марка для ${m.model}`}
                          />
                        </div>
                        <Button
                          type="button"
                          variant="secondary"
                          className="whitespace-nowrap"
                          disabled={guess.trim().length < 2}
                          onClick={() => onAdd(guess, m.model)}
                        >
                          В правила
                        </Button>
                      </div>
                    )}
                  </>
                )}
                {canEdit && (
                  <Button type="button" variant="ghost" onClick={() => onHide(m.modelKey)}>
                    Убрать
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {misses.length > shown.length && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="w-full border-t border-line px-3 py-2 text-[13px] font-semibold text-brand-ink hover:bg-surface-raised"
        >
          Показать все ({misses.length})
        </button>
      )}
    </div>
  );
}
