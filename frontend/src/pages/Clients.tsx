import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Modal } from "../components/Modal";
import { IconAdd, IconClients, IconCompany, IconEdit, IconPerson } from "../components/icons";
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  List,
  ListRow,
  PageHeader,
  SearchInput,
  Select,
  Spinner,
  StatusGlyph,
} from "../components/ui";
import { ApiError, api } from "../lib/api";
import { formatDateShort, plural } from "../lib/format";

interface Client {
  id: string;
  type: "INDIVIDUAL" | "COMPANY";
  name: string;
  phone: string;
  phone2: string | null;
  email: string | null;
  address: string | null;
  source: string | null;
  note: string | null;
  discountPercent: number;
  createdAt: string;
  orderCount: number;
  deviceCount: number;
}

/** Пустая карточка для формы: у нового клиента заполнять нечего. */
const blank = {
  type: "INDIVIDUAL" as Client["type"],
  name: "",
  phone: "",
  phone2: "",
  email: "",
  address: "",
  note: "",
  discountPercent: "0",
};

type Form = typeof blank;

const formOf = (c: Client): Form => ({
  type: c.type,
  name: c.name,
  phone: c.phone,
  phone2: c.phone2 ?? "",
  email: c.email ?? "",
  address: c.address ?? "",
  note: c.note ?? "",
  discountPercent: String(c.discountPercent ?? 0),
});

export default function Clients() {
  const [rows, setRows] = useState<Client[] | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** null — окно закрыто, "new" — создание, объект — правка. */
  const [editing, setEditing] = useState<Client | "new" | null>(null);

  const load = useCallback(async () => {
    try {
      const q = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : "";
      setRows(await api.get<Client[]>(`/customers${q}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить клиентов");
    }
  }, [search]);

  useEffect(() => {
    const t = setTimeout(() => void load(), search ? 350 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  if (error) return <Banner tone="error">{error}</Banner>;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Мастерская"
        title="Клиенты"
        subtitle="Карточка заводится сама при приёме техники. Кнопка рядом — на случай, когда клиента нужно завести заранее."
        actions={
          <button
            type="button"
            onClick={() => setEditing("new")}
            title="Добавить клиента"
            aria-label="Добавить клиента"
            className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-brand text-white shadow-raised transition-all duration-150 hover:bg-brand-press active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand [&>svg]:h-[22px] [&>svg]:w-[22px]"
          >
            <IconAdd />
          </button>
        }
      />

      <Card className="p-3.5">
        <SearchInput
          placeholder="Имя, телефон или email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="sm:max-w-[380px]"
        />
      </Card>

      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState icon={<IconClients />} title={search ? "Никого не нашлось" : "Клиентов пока нет"}>
          {search
            ? "Попробуйте другой номер или часть имени."
            : "Первый клиент появится здесь сразу после того, как приёмщик заведёт заказ."}
        </EmptyState>
      ) : (
        <List>
          {rows.map((c) => (
            <ListRow
              key={c.id}
              glyph={
                // Цвета значков теперь заняты стадиями заказа: покрасить
                // организацию в цвет «Диагностики» значило бы соврать. Тип
                // клиента и так виден по значку и по пометке рядом с именем.
                <StatusGlyph
                  tone="neutral"
                  title={c.type === "COMPANY" ? "Организация" : "Частное лицо"}
                  icon={c.type === "COMPANY" ? <IconCompany /> : <IconPerson />}
                />
              }
              title={
                <>
                  <span className="truncate">{c.name}</span>
                  {c.type === "COMPANY" && <Badge>организация</Badge>}
                </>
              }
              subtitle={
                <>
                  {/* Позвонить прямо из списка — самое частое действие приёмщика,
                      поэтому телефон здесь ссылка, а не просто текст. */}
                  <a
                    href={`tel:${c.phone}`}
                    onClick={(e) => e.stopPropagation()}
                    className="font-semibold text-brand-ink hover:underline"
                  >
                    {c.phone}
                  </a>
                  {c.email && <span className="text-ink-dim"> · {c.email}</span>}
                </>
              }
              meta={
                <>
                  <span className="whitespace-nowrap lg:w-[100px] lg:text-right">
                    {plural(c.orderCount, "заказ", "заказа", "заказов")}
                  </span>
                  <span className="whitespace-nowrap lg:w-[112px] lg:text-right">
                    {plural(c.deviceCount, "аппарат", "аппарата", "аппаратов")}
                  </span>
                  <span className="whitespace-nowrap lg:w-[104px] lg:text-right">
                    {c.discountPercent > 0 ? (
                      <span className="font-semibold text-brand-ink">скидка {c.discountPercent}%</span>
                    ) : (
                      `с ${formatDateShort(c.createdAt)}`
                    )}
                  </span>
                </>
              }
              actions={
                <div className="flex justify-end sm:min-w-[44px]">
                  <Button
                    variant="secondary"
                    className="min-h-[36px] w-[36px] px-0"
                    onClick={() => setEditing(c)}
                    title="Редактировать клиента"
                    aria-label={`Редактировать ${c.name}`}
                    icon={<IconEdit />}
                  />
                </div>
              }
            />
          ))}
        </List>
      )}

      {rows && rows.length > 0 && (
        <p className="text-[12.5px] text-ink-dim">
          {plural(rows.length, "клиент", "клиента", "клиентов")} в списке.
        </p>
      )}

      {editing && (
        <ClientModal
          client={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function ClientModal({
  client,
  onClose,
  onDone,
}: {
  client: Client | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState<Form>(client ? formOf(client) : blank);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  /** Удаление в два шага: кнопка сначала спрашивает, потом удаляет. */
  const [confirmDelete, setConfirmDelete] = useState(false);

  const set = (k: keyof Form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Пустые строки отправляем как есть: сервер сам превратит их в null,
      // а отличать «не заполнено» от «стёрли» на клиенте незачем.
      const body = {
        ...form,
        discountPercent: form.discountPercent.trim() === "" ? 0 : Number(form.discountPercent.replace(",", ".")),
      };
      if (client) await api.patch(`/customers/${client.id}`, body);
      else await api.post("/customers", body);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!client) return;
    setBusy(true);
    setError(null);
    try {
      await api.del(`/customers/${client.id}`);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={client ? client.name : "Новый клиент"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Banner tone="error">{error.message}</Banner>}

        <Field label="Кто это" error={error?.field("type")}>
          <Select value={form.type} onChange={set("type")}>
            <option value="INDIVIDUAL">Частное лицо</option>
            <option value="COMPANY">Организация</option>
          </Select>
        </Field>

        <Field label={form.type === "COMPANY" ? "Название" : "Имя"} error={error?.field("name")}>
          <Input value={form.name} onChange={set("name")} invalid={!!error?.field("name")} />
        </Field>

        <Field label="Телефон" error={error?.field("phone")} hint="По нему клиента находят при приёме техники">
          <Input
            type="tel"
            value={form.phone}
            onChange={set("phone")}
            invalid={!!error?.field("phone")}
          />
        </Field>

        <Field label="Второй телефон" error={error?.field("phone2")}>
          <Input type="tel" value={form.phone2} onChange={set("phone2")} />
        </Field>

        <Field label="Email" error={error?.field("email")}>
          <Input
            type="email"
            value={form.email}
            onChange={set("email")}
            autoCapitalize="none"
            invalid={!!error?.field("email")}
          />
        </Field>

        <Field label="Адрес" error={error?.field("address")}>
          <Input value={form.address} onChange={set("address")} />
        </Field>

        <Field
          label="Скидка на работы, %"
          error={error?.field("discountPercent")}
          hint="Постоянная скидка клиента. Считается только от стоимости работ — запчасти она не трогает."
        >
          <Input
            inputMode="decimal"
            value={form.discountPercent}
            onChange={set("discountPercent")}
            invalid={!!error?.field("discountPercent")}
          />
        </Field>

        <Field label="Заметка" error={error?.field("note")} hint="Видна только сотрудникам мастерской">
          <Input value={form.note} onChange={set("note")} />
        </Field>

        <div className="flex flex-col gap-2 pt-2 sm:flex-row-reverse">
          <Button type="submit" disabled={busy} className="sm:flex-1">
            {busy ? "Сохраняем…" : client ? "Сохранить" : "Добавить"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} className="sm:flex-1">
            Отмена
          </Button>
        </div>

        {client && (
          <div className="border-t border-line pt-4">
            {confirmDelete ? (
              <div className="space-y-3">
                {/* Заказы и история ремонтов остаются: карточка помечается
                    удалённой, а не вычищается из базы. Об этом честно
                    говорим — иначе владелец побоится нажать. */}
                <Banner tone="warning">
                  {client.orderCount > 0
                    ? `Карточка скроется из списка клиентов, но ${plural(client.orderCount, "заказ", "заказа", "заказов")} и история ремонтов останутся на месте.`
                    : "Карточка скроется из списка клиентов."}
                </Banner>
                <div className="flex flex-col gap-2 sm:flex-row-reverse">
                  <Button
                    type="button"
                    variant="danger"
                    disabled={busy}
                    onClick={() => void remove()}
                    className="sm:flex-1"
                  >
                    {busy ? "Удаляем…" : "Удалить клиента"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setConfirmDelete(false)}
                    className="sm:flex-1"
                  >
                    Не удалять
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                type="button"
                variant="danger"
                onClick={() => setConfirmDelete(true)}
                className="w-full"
              >
                Удалить клиента
              </Button>
            )}
          </div>
        )}
      </form>
    </Modal>
  );
}
