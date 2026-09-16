import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Modal } from "../components/Modal";
import { IconAdd, IconEdit, IconServices } from "../components/icons";
import {
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Field,
  Input,
  List,
  ListRow,
  PageHeader,
  SearchInput,
  Spinner,
  StatusGlyph,
} from "../components/ui";
import { ApiError } from "../lib/api";
import { plural } from "../lib/format";
import { money } from "../lib/orders";
import { PINNED_LIMIT, servicesApi, type Service } from "../lib/services";

/**
 * Прайс мастерской.
 *
 * Отсюда берутся подсказки при наборе выполненных работ, поэтому список
 * стоит держать в порядке: чем точнее названия, тем реже мастер пишет
 * своё и тем ближе отчёты к реальности.
 */
export default function Services() {
  const [rows, setRows] = useState<Service[] | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** null — окно закрыто, "new" — создание, объект — правка. */
  const [editing, setEditing] = useState<Service | "new" | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await servicesApi.list());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить услуги");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Banner tone="error">{error}</Banner>;

  const q = search.trim().toLowerCase();
  const visible = rows?.filter((s) => !q || s.name.toLowerCase().includes(q)) ?? null;
  const pinned = rows?.filter((s) => s.isPinned).length ?? 0;

  return (
    <div className="space-y-5">
      <Link to="/settings" className="text-[13.5px] font-semibold text-ink-muted hover:text-ink">
        ‹ Настройки
      </Link>

      <PageHeader
        eyebrow="Настройки"
        title="Услуги"
        subtitle="Прайс мастерской. Из него подставляются названия и цены при наборе выполненных работ."
        actions={
          <button
            type="button"
            onClick={() => setEditing("new")}
            title="Добавить услугу"
            aria-label="Добавить услугу"
            className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-brand text-white shadow-raised transition-all duration-150 hover:bg-brand-press active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand [&>svg]:h-[22px] [&>svg]:w-[22px]"
          >
            <IconAdd />
          </button>
        }
      />

      {/* Перебор с кнопками стоит показать сразу: в карточке заказа лишние
          всё равно не поместятся, и человек будет думать, что не сохранилось. */}
      {pinned > PINNED_LIMIT && (
        <Banner tone="warning">
          Кнопками отмечено {pinned} услуг, а в карточке заказа помещается {PINNED_LIMIT}. Остальные
          останутся в подсказках при наборе.
        </Banner>
      )}

      <Card className="p-3.5">
        <SearchInput
          placeholder="Название услуги"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="sm:max-w-[380px]"
        />
      </Card>

      {!visible ? (
        <Spinner />
      ) : visible.length === 0 ? (
        <EmptyState icon={<IconServices />} title={q ? "Ничего не нашлось" : "Прайс пока пуст"}>
          {q
            ? "Попробуйте другое название."
            : "Заведите то, что делаете чаще всего, — диагностику, чистку, установку системы. Дальше эти названия будут подставляться в заказ сами."}
        </EmptyState>
      ) : (
        <List>
          {visible.map((s) => (
            <ListRow
              key={s.id}
              glyph={<StatusGlyph tone="neutral" title="Услуга" icon={<IconServices />} />}
              title={
                <>
                  <span className="truncate">{s.name}</span>
                  {s.isPinned && <Badge tone="brand">кнопкой</Badge>}
                </>
              }
              subtitle={s.note ?? undefined}
              meta={
                <span className="whitespace-nowrap font-semibold text-ink-soft lg:w-[120px] lg:text-right">
                  {money(s.price)}
                </span>
              }
              actions={
                <div className="flex justify-end sm:min-w-[44px]">
                  <Button
                    variant="secondary"
                    className="min-h-[36px] w-[36px] px-0"
                    onClick={() => setEditing(s)}
                    title="Редактировать услугу"
                    aria-label={`Редактировать ${s.name}`}
                    icon={<IconEdit />}
                  />
                </div>
              }
            />
          ))}
        </List>
      )}

      {visible && visible.length > 0 && (
        <p className="text-[12.5px] text-ink-dim">
          {plural(visible.length, "услуга", "услуги", "услуг")} в прайсе.
        </p>
      )}

      {editing && (
        <ServiceModal
          service={editing === "new" ? null : editing}
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

const blank = { name: "", price: "", note: "", isPinned: false };
type Form = typeof blank;

function ServiceModal({
  service,
  onClose,
  onDone,
}: {
  service: Service | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState<Form>(
    service
      ? {
          name: service.name,
          price: String(service.price),
          note: service.note ?? "",
          isPinned: service.isPinned,
        }
      : blank
  );
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const set = (k: "name" | "price" | "note") => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: form.name,
        price: form.price.trim() === "" ? 0 : Number(form.price.replace(",", ".")),
        note: form.note,
        isPinned: form.isPinned,
      };
      if (service) await servicesApi.update(service.id, body);
      else await servicesApi.create(body);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!service) return;
    setBusy(true);
    setError(null);
    try {
      await servicesApi.remove(service.id);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
      setConfirmDelete(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={service ? service.name : "Новая услуга"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Banner tone="error">{error.message}</Banner>}

        <Field
          label="Название"
          error={error?.field("name")}
          hint="Это название попадёт в заказ и в квитанцию клиенту"
        >
          <Input value={form.name} onChange={set("name")} invalid={!!error?.field("name")} />
        </Field>

        <Field label="Цена, ₽" error={error?.field("price")} hint="Можно оставить нулевой и ставить руками в заказе">
          <Input
            inputMode="decimal"
            value={form.price}
            onChange={set("price")}
            invalid={!!error?.field("price")}
          />
        </Field>

        <Field label="Уточнение" error={error?.field("note")} hint="Что входит в работу, а что нет. Видно только сотрудникам.">
          <Input value={form.note} onChange={set("note")} placeholder="Без стоимости запчастей" />
        </Field>

        <Checkbox
          label="Вынести кнопкой в карточку заказа"
          checked={form.isPinned}
          onChange={(v) => setForm((f) => ({ ...f, isPinned: v }))}
        />

        <div className="flex flex-col gap-2 pt-2 sm:flex-row-reverse">
          <Button type="submit" disabled={busy} className="sm:flex-1">
            {busy ? "Сохраняем…" : service ? "Сохранить" : "Добавить"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} className="sm:flex-1">
            Отмена
          </Button>
        </div>

        {service && (
          <div className="border-t border-line pt-4">
            {confirmDelete ? (
              <div className="space-y-3">
                <Banner tone="warning">
                  Услуга исчезнет из прайса и из подсказок. Работы, уже записанные в заказы,
                  останутся на месте вместе со своими ценами.
                </Banner>
                <div className="flex flex-col gap-2 sm:flex-row-reverse">
                  <Button
                    type="button"
                    variant="danger"
                    disabled={busy}
                    onClick={() => void remove()}
                    className="sm:flex-1"
                  >
                    {busy ? "Удаляем…" : "Удалить услугу"}
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
                Удалить услугу
              </Button>
            )}
          </div>
        )}
      </form>
    </Modal>
  );
}
