import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
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
import { ApiError, api, type Page } from "../lib/api";
import { DebtPanel } from "../components/DebtPanel";
import { Pager } from "../components/Pager";
import { formatDateShort, plural } from "../lib/format";
import { ColorPicker } from "../components/ColorPicker";
import { customerColor, nameStyle } from "../lib/customerColor";
import { useAuth } from "../lib/auth";
import { listPref } from "../lib/listPrefs";
import { COLOR_FILTER_VALUES, ColorFilter, SortSelect, type ColorFilterValue } from "../components/ListControls";

export interface Client {
  id: string;
  /** Короткий номер внутри мастерской — по нему клиента удобно продиктовать. */
  number: number;
  type: "INDIVIDUAL" | "COMPANY";
  name: string;
  phone: string;
  phone2: string | null;
  email: string | null;
  address: string | null;
  source: string | null;
  note: string | null;
  /** Цветная метка: ключ цвета или пусто. Что он значит, решает мастерская. */
  color: string | null;
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
  color: "",
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
  color: c.color ?? "",
  discountPercent: String(c.discountPercent ?? 0),
});

const SORTS = [
  { value: "new", label: "Сначала новые" },
  { value: "old", label: "Сначала старые" },
  { value: "name", label: "По имени, А–Я" },
  { value: "color", label: "По цвету метки" },
  { value: "orders", label: "По числу заказов" },
  { value: "paid", label: "По сумме оплат", money: true },
  { value: "visit", label: "По последнему визиту" },
] as const;
type Sort = (typeof SORTS)[number]["value"];

export default function Clients() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState<Client[] | null>(null);
  const [pageInfo, setPageInfo] = useState({ page: 1, pages: 1, total: 0, pageSize: 50 });
  // Страница, порядок и метка живут в адресе: из карточки клиента «назад»
  // возвращает туда же, откуда ушли, а не на первую страницу.
  const [params, setParams] = useSearchParams();
  const page = Math.max(1, Number(params.get("page") ?? 1) || 1);
  const setPage = (next: number) => {
    const p = new URLSearchParams(params);
    if (next > 1) p.set("page", String(next));
    else p.delete("page");
    setParams(p, { replace: true });
  };
  // Деньги видит не каждый — и сортировку по ним тоже.
  const seesMoney = can("orders.cost", "orders.view.all");
  const sorts = SORTS.filter((s) => !("money" in s) || seesMoney);
  const [sort, setSort] = listPref<Sort>(params, setParams, {
    key: "sort",
    storageKey: "finecrm.clients.sort",
    fallback: "new",
    allowed: sorts.map((s) => s.value),
  });
  const [color, setColor] = listPref<ColorFilterValue>(params, setParams, {
    key: "color",
    storageKey: "finecrm.clients.color",
    fallback: "",
    allowed: COLOR_FILTER_VALUES,
  });
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** null — окно закрыто, "new" — создание, объект — правка. */
  const [editing, setEditing] = useState<Client | "new" | null>(null);

  const load = useCallback(async () => {
    try {
      const p = new URLSearchParams({ page: String(page) });
      if (search.trim()) p.set("search", search.trim());
      if (sort !== "new") p.set("sort", sort);
      if (color) p.set("color", color);
      const data = await api.get<Page<Client>>(`/customers?${p.toString()}`);
      setRows(data.rows);
      setPageInfo({ page: data.page, pages: data.pages, total: data.total, pageSize: data.pageSize });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить клиентов");
    }
  }, [search, page, sort, color]);

  useEffect(() => {
    const t = setTimeout(() => void load(), search ? 350 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  const open = (c: Client) => navigate(`/clients/${c.id}`);

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
        <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center">
          <SearchInput
            placeholder="Имя, телефон, email или номер"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              // Новый поиск — снова первая страница: иначе человек ищет и
              // попадает на седьмую страницу того, чего нашлось три строки.
              if (page > 1) setPage(1);
            }}
            className="lg:max-w-[380px]"
          />
          <div className="flex flex-col gap-2.5 sm:flex-row lg:ml-auto">
            <SortSelect value={sort} options={sorts} onChange={setSort} />
            <ColorFilter value={color} onChange={setColor} />
          </div>
        </div>
      </Card>

      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState icon={<IconClients />} title={search || color ? "Никого не нашлось" : "Клиентов пока нет"}>
          {search || color
            ? "Попробуйте другой номер или часть имени, или снимите отбор по метке."
            : "Первый клиент появится здесь сразу после того, как приёмщик заведёт заказ."}
        </EmptyState>
      ) : (
        <List>
          {rows.map((c) => (
            // Строка целиком ведёт в карточку клиента. Не ссылкой, а по
            // нажатию: внутри уже есть ссылка «позвонить», а ссылка в
            // ссылке браузер разбирает как попало.
            <div
              key={c.id}
              role="link"
              tabIndex={0}
              onClick={() => open(c)}
              onKeyDown={(e) => {
                if (e.key === "Enter") open(c);
              }}
              className="block cursor-pointer outline-none focus-visible:bg-surface-raised"
            >
            <ListRow
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
                  {/* Цветной кружок рядом с именем: цвет имени читается не на
                      всяком экране, а кружок виден и при ярком солнце в окне. */}
                  {customerColor(c.color) && (
                    <span
                      title={customerColor(c.color)!.label}
                      className="h-[10px] w-[10px] shrink-0 rounded-full"
                      style={{ backgroundColor: customerColor(c.color)!.dot }}
                    />
                  )}
                  <span className="truncate" style={nameStyle(c.color)}>
                    {c.name}
                  </span>
                  {c.type === "COMPANY" && <Badge>организация</Badge>}
                </>
              }
              subtitle={
                <>
                  {/* Номер держим приглушённым: он нужен, когда нужен —
                      продиктовать по телефону, найти в старой базе, — и не
                      должен спорить за внимание с именем и телефоном. */}
                  <span className="font-mono text-[12.5px] text-ink-dim">№{c.number}</span>
                  <span className="text-ink-dim"> · </span>
                  {/* Позвонить прямо из списка — самое частое действие приёмщика,
                      поэтому телефон здесь ссылка, а не просто текст. */}
                  {c.phone ? (
                    <a
                      href={`tel:${c.phone}`}
                      onClick={(e) => e.stopPropagation()}
                      className="font-semibold text-brand-ink hover:underline"
                    >
                      {c.phone}
                    </a>
                  ) : (
                    // Телефона может не быть у карточки, приехавшей из чужой
                    // программы. Пустое место здесь выглядело бы как ошибка.
                    <span className="text-ink-dim">телефон не указан</span>
                  )}
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
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditing(c);
                    }}
                    title="Редактировать клиента"
                    aria-label={`Редактировать ${c.name}`}
                    icon={<IconEdit />}
                  />
                </div>
              }
            />
            </div>
          ))}
        </List>
      )}

      {rows && (
        <Pager
          {...pageInfo}
          onPage={(n) => {
            setPage(n);
            window.scrollTo({ top: 0 });
          }}
        />
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

export function ClientModal({
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

        {/* Долг — первое, что нужно знать о клиенте, который стоит перед вами:
            прежде чем править ему телефон, стоит увидеть, что он должен. */}
        {client && <DebtPanel customerId={client.id} onPaid={onDone} />}

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

        <div>
          <span className="mb-1.5 block text-[13px] font-semibold text-ink-soft">Цветная метка</span>
          <ColorPicker value={form.color} onChange={(color) => setForm((f) => ({ ...f, color }))} />
          <span className="mt-1.5 block text-[12.5px] text-ink-dim">
            Имя клиента будет выделено этим цветом в списках, в поиске и в бланке приёма. Что означает
            цвет, решаете вы: например, зелёный — щедрый постоянный клиент, красный — с таким всё
            фиксировать письменно.
          </span>
        </div>

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
