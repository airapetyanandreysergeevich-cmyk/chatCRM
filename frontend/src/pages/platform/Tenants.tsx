import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Modal } from "../../components/Modal";
import {
  Banner,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  SectionLabel,
  Select,
  Spinner,
  StatusChip,
  Textarea,
} from "../../components/ui";
import { ApiError, api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { formatDate, plural } from "../../lib/format";
import {
  brandsFromText,
  brandsToText,
  noiseFromText,
  plateDictionaryApi,
  type DictionaryReply,
} from "../../lib/plateDictionary";

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  status: "ACTIVE" | "READONLY" | "SUSPENDED";
  plan: string;
  maxUsers: number;
  /** Распознавание шильдиков камерой на бланке приёма. */
  plateOcr: boolean;
  contactPhone: string | null;
  createdAt: string;
  /** Не пусто — мастерская в архиве: вход закрыт, данные целы. */
  archivedAt: string | null;
  userCount: number;
  orderCount: number;
}

const STATUS_LABEL: Record<TenantRow["status"], { text: string; tone: "done" | "waiting" | "cancelled" }> = {
  ACTIVE: { text: "Работает", tone: "done" },
  READONLY: { text: "Только чтение", tone: "waiting" },
  SUSPENDED: { text: "Приостановлена", tone: "cancelled" },
};

export default function Tenants() {
  const { applyToken, me } = useAuth();
  // Распознаватель — общий ресурс сервера, поэтому включает его собственник.
  const isOwner = me?.kind === "platform" && me.platformUser.role === "OWNER";
  const [rows, setRows] = useState<TenantRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [impersonate, setImpersonate] = useState<TenantRow | null>(null);
  const [removing, setRemoving] = useState<TenantRow | null>(null);
  /** Ошибка действия — над списком, а не вместо него. */
  const [notice, setNotice] = useState<string | null>(null);
  const [dictionary, setDictionary] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await api.get<TenantRow[]>("/platform/tenants"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить список");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function togglePlateOcr(t: TenantRow, on: boolean) {
    // Сразу на экране, не дожидаясь сервера; при отказе — вернуть как было.
    setRows((rs) => rs?.map((r) => (r.id === t.id ? { ...r, plateOcr: on } : r)) ?? rs);
    try {
      await api.patch(`/platform/tenants/${t.id}`, { plateOcr: on });
    } catch (err) {
      setRows((rs) => rs?.map((r) => (r.id === t.id ? { ...r, plateOcr: !on } : r)) ?? rs);
      setNotice(err instanceof ApiError ? err.message : "Не удалось переключить распознавание");
    }
  }

  async function changeStatus(t: TenantRow, status: TenantRow["status"]) {
    await api.patch(`/platform/tenants/${t.id}`, { status });
    await load();
  }

  /**
   * В архив — без вопросов, обратно — тоже. Спрашивать имеет смысл только
   * там, откуда нет пути назад, а это отдельное окно.
   */
  async function archive(t: TenantRow, toArchive: boolean) {
    await api.post(`/platform/tenants/${t.id}/${toArchive ? "archive" : "restore"}`, {});
    await load();
  }

  if (error) return <Banner tone="error">{error}</Banner>;
  if (!rows) return <Spinner />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <SectionLabel>Платформа</SectionLabel>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight">Мастерские</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {rows.length ? plural(rows.length, "мастерская", "мастерские", "мастерских") : "Пока ни одной"}
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

      {rows.length === 0 ? (
        <Card>
          <p className="text-ink-muted">
            Заведите первую мастерскую — владелец получит логин и сможет сразу принимать технику.
          </p>
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {rows.map((t) => (
            <Card key={t.id} className={t.archivedAt ? "opacity-70" : undefined}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-[17px] font-bold leading-tight">{t.name}</h2>
                  <p className="mt-1 font-mono text-[13px] text-ink-muted">{t.slug}</p>
                </div>
                <StatusChip tone={t.archivedAt ? "cancelled" : STATUS_LABEL[t.status].tone}>
                  {t.archivedAt ? "В архиве" : STATUS_LABEL[t.status].text}
                </StatusChip>
              </div>

              <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-line pt-4 text-sm">
                <div>
                  <dt className="text-ink-muted">Сотрудники</dt>
                  <dd className="font-bold">
                    {t.userCount} <span className="font-normal text-ink-muted">из {t.maxUsers}</span>
                  </dd>
                </div>
                <div>
                  <dt className="text-ink-muted">Заказы</dt>
                  <dd className="font-bold">{t.orderCount}</dd>
                </div>
                <div>
                  <dt className="text-ink-muted">Подключена</dt>
                  <dd className="font-bold">{formatDate(t.createdAt)}</dd>
                </div>
              </dl>

              <div className="mt-4 border-t border-line pt-3">
                <Checkbox
                  checked={t.plateOcr}
                  disabled={!isOwner || !!t.archivedAt}
                  onChange={(on) => void togglePlateOcr(t, on)}
                  label="Распознавание шильдиков камерой"
                />
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {t.archivedAt ? (
                  <>
                    <Button variant="secondary" className="px-4 text-sm" onClick={() => void archive(t, false)}>
                      Вернуть из архива
                    </Button>
                    <Button variant="danger" className="px-4 text-sm" onClick={() => setRemoving(t)}>
                      Удалить насовсем
                    </Button>
                  </>
                ) : (
                  <>
                    <Button variant="secondary" className="px-4 text-sm" onClick={() => setImpersonate(t)}>
                      Войти как владелец
                    </Button>
                    {t.status === "ACTIVE" ? (
                      <Button
                        variant="secondary"
                        className="px-4 text-sm"
                        onClick={() => void changeStatus(t, "READONLY")}
                      >
                        Перевести в чтение
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        className="px-4 text-sm"
                        onClick={() => void changeStatus(t, "ACTIVE")}
                      >
                        Вернуть в работу
                      </Button>
                    )}
                    <Button variant="ghost" className="px-4 text-sm" onClick={() => void archive(t, true)}>
                      В архив
                    </Button>
                  </>
                )}
              </div>
            </Card>
          ))}
        </div>
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

      {impersonate && (
        <ImpersonateModal
          tenant={impersonate}
          onClose={() => setImpersonate(null)}
          onDone={async (token) => {
            setImpersonate(null);
            await applyToken(token);
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
          Будут стёрты все заказы, клиенты, фотографии, склад, касса и сотрудники мастерской «{tenant.name}»:
          {" "}
          {tenant.orderCount} заказов, {tenant.userCount} сотрудников. Восстановить это будет нечем — резервная
          копия платформы тоже перестанет их содержать со следующей выгрузки.
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

function ImpersonateModal({
  tenant,
  onClose,
  onDone,
}: {
  tenant: TenantRow;
  onClose: () => void;
  onDone: (token: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await api.post<{ accessToken: string }>(`/platform/tenants/${tenant.id}/impersonate`, { reason });
      onDone(data.accessToken);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Войти в «${tenant.name}»`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Banner>
          Вход будет записан в журнал и виден владельцу мастерской: кто зашёл, когда и по какой причине.
        </Banner>
        {error && <Banner tone="error">{error.message}</Banner>}
        <Field label="Причина входа" error={error?.field("reason")} hint="Например: разбираем обращение в поддержку №128">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} invalid={!!error?.field("reason")} />
        </Field>
        <div className="flex flex-col gap-2 pt-2 sm:flex-row-reverse">
          <Button type="submit" disabled={busy} className="sm:flex-1">
            {busy ? "Входим…" : "Войти"}
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
 * Словарь распознавания шильдиков: марки и лишние слова.
 *
 * Встроенное показано рядом, но не правится: оно проверено на настоящих
 * шильдиках тестами. Словарь дополняет встроенное — новая марка, другое
 * написание знакомой («Hewlett-Packard: HP»), фраза, которую надо отрезать
 * от модели («Made in China»).
 */
function DictionaryModal({ canEdit, onClose }: { canEdit: boolean; onClose: () => void }) {
  const [reply, setReply] = useState<DictionaryReply | null>(null);
  const [brands, setBrands] = useState("");
  const [noise, setNoise] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  const fill = (r: DictionaryReply) => {
    setReply(r);
    setBrands(brandsToText(r.dictionary.brands));
    setNoise(r.dictionary.noise.join("\n"));
  };

  useEffect(() => {
    plateDictionaryApi
      .get()
      .then(fill)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить словарь"));
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      fill(await plateDictionaryApi.save({ brands: brandsFromText(brands), noise: noiseFromText(noise) }));
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить словарь");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Словарь шильдиков" onClose={onClose}>
      {!reply && !error ? (
        <Spinner />
      ) : (
        <form onSubmit={save} className="space-y-4">
          {error && <Banner tone="error">{error}</Banner>}
          {saved && <Banner>Сохранено. Приёмщики получат словарь в течение минуты.</Banner>}

          <Field
            label="Марки"
            hint="По одной в строке. Другие написания — через двоеточие и запятые: «Hewlett-Packard: HP, HPE»"
          >
            <Textarea
              value={brands}
              onChange={(e) => setBrands(e.target.value)}
              rows={7}
              readOnly={!canEdit}
              placeholder={"Haier\nRaybook\nHewlett-Packard: HP"}
              className="font-mono text-[13.5px]"
            />
          </Field>
          <Field label="Лишние слова" hint="По одной фразе в строке. Модель обрывается на первой такой фразе">
            <Textarea
              value={noise}
              onChange={(e) => setNoise(e.target.value)}
              rows={4}
              readOnly={!canEdit}
              placeholder={"Energy Star\nTUV Rheinland"}
              className="font-mono text-[13.5px]"
            />
          </Field>

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
              <p className="mt-2 text-ink-dim">
                Сверх того каждая мастерская узнаёт марки, которые сама вводила в бланке не меньше двух раз.
              </p>
            </details>
          )}

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
