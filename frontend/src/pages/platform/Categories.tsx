import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Modal } from "../../components/Modal";
import { CategoryChip } from "../../components/platform/ClientBits";
import { Badge, Banner, Button, Checkbox, EmptyState, Field, Input, List, ListRow, SectionLabel, Spinner, StatusGlyph } from "../../components/ui";
import { IconTag } from "../../components/icons";
import { ApiError } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { CUSTOMER_COLORS } from "../../lib/customerColor";
import { plural } from "../../lib/format";
import { mbLabel, platformApi, rub, type Category, type CategoryInput } from "../../lib/platformApi";

/**
 * Категории клиентов: у каждой свои цены и условия.
 *
 * «Свои ребята» — бесплатно и с запасом места, «Обычные» — по прайсу,
 * «Партнёры» — со скидкой. Условия категории получают все её клиенты;
 * отдельному клиенту цену и лимиты можно поправить в его окне — тогда
 * правка категории его не тронет.
 */

const EMPTY: CategoryInput = {
  name: "",
  color: "green",
  note: "",
  cloudPrice: 0,
  remotePrice: 0,
  trialDays: 14,
  maxUsers: 10,
  maxStorageMb: 5120,
  plateOcr: true,
  showAds: true,
  isDefault: false,
};

export default function Categories() {
  const { me } = useAuth();
  const isOwner = me?.kind === "platform" && me.platformUser.role === "OWNER";
  const [rows, setRows] = useState<Category[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Category | "new" | null>(null);
  const [removing, setRemoving] = useState<Category | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await platformApi.categories());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить категории");
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Banner tone="error">{error}</Banner>;
  if (!rows) return <Spinner />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <SectionLabel>Платформа</SectionLabel>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight">Категории клиентов</h1>
          <p className="mt-1 max-w-[640px] text-sm text-ink-muted">
            У каждой категории свои цены, пробный срок и лимиты. Отдельному клиенту их можно поправить в его окне.
          </p>
        </div>
        {isOwner && <Button onClick={() => setEditing("new")}>Новая категория</Button>}
      </div>

      {rows.length === 0 ? (
        <EmptyState title="Категорий пока нет">Заведите первую — в неё будут попадать новые клиенты.</EmptyState>
      ) : (
        <List>
          {rows.map((c) => (
            <div
              key={c.id}
              role="button"
              tabIndex={0}
              onClick={() => isOwner && setEditing(c)}
              onKeyDown={(e) => e.key === "Enter" && isOwner && setEditing(c)}
              className={isOwner ? "cursor-pointer" : undefined}
            >
              <ListRow
                glyph={<StatusGlyph tone="neutral" icon={<IconTag />} />}
                title={
                  <>
                    <CategoryChip category={c} />
                    {c.isDefault && <Badge tone="brand">для новых</Badge>}
                  </>
                }
                subtitle={
                  <>
                    облако {c.cloudPrice ? `${rub(c.cloudPrice)}/мес` : "бесплатно"} · доступ{" "}
                    {c.remotePrice ? `${rub(c.remotePrice)}/мес` : "бесплатно"}
                    {c.trialDays > 0 ? ` · проба ${plural(c.trialDays, "день", "дня", "дней")}` : ""}
                    {c.note ? ` · ${c.note}` : ""}
                  </>
                }
                meta={
                  <>
                    <span className="whitespace-nowrap">до {plural(c.maxUsers, "сотрудника", "сотрудников", "сотрудников")}</span>
                    <span className="whitespace-nowrap">фото {mbLabel(c.maxStorageMb)}</span>
                    <span className="whitespace-nowrap">шильдики {c.plateOcr ? "да" : "нет"}</span>
                    <span className="whitespace-nowrap">реклама {c.showAds ? "да" : "нет"}</span>
                    <span className="whitespace-nowrap font-semibold text-ink-soft lg:w-[150px] lg:text-right">
                      {c.tenantCount} облачн. · {c.boxCount} локальн.
                    </span>
                  </>
                }
              />
            </div>
          ))}
        </List>
      )}

      <p className="text-[12.5px] text-ink-dim">
        «Реклама» пока ни на что не влияет — это заготовка: когда в бесплатной локальной версии появится реклама,
        категории с выключенной галочкой её не увидят.
      </p>

      {editing && (
        <CategoryModal
          category={editing === "new" ? null : editing}
          canRemove={editing !== "new" && !editing.isDefault}
          onRemove={() => {
            if (editing !== "new") setRemoving(editing);
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            void load();
          }}
        />
      )}

      {removing && (
        <Modal title={`Удалить категорию «${removing.name}»?`} onClose={() => setRemoving(null)}>
          <div className="space-y-4">
            <Banner tone="warning">
              Её клиенты ({removing.tenantCount + removing.boxCount}) перейдут в категорию для новых клиентов и
              получат её цены и лимиты — кроме тех, кому их ставили вручную.
            </Banner>
            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              <Button
                variant="danger"
                className="sm:flex-1"
                onClick={async () => {
                  try {
                    await platformApi.removeCategory(removing.id);
                    setRemoving(null);
                    void load();
                  } catch (err) {
                    setRemoving(null);
                    setError(err instanceof ApiError ? err.message : "Не удалось удалить");
                  }
                }}
              >
                Удалить
              </Button>
              <Button variant="secondary" onClick={() => setRemoving(null)} className="sm:flex-1">
                Отмена
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function CategoryModal({
  category,
  canRemove,
  onRemove,
  onClose,
  onDone,
}: {
  category: Category | null;
  canRemove: boolean;
  onRemove: () => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const start = category ?? EMPTY;
  const [f, setF] = useState({
    name: start.name,
    color: start.color,
    note: start.note ?? "",
    cloudPrice: String(start.cloudPrice),
    remotePrice: String(start.remotePrice),
    trialDays: String(start.trialDays),
    maxUsers: String(start.maxUsers),
    storageGb: String(Math.round((start.maxStorageMb / 1024) * 10) / 10),
    plateOcr: start.plateOcr,
    showAds: start.showAds,
    isDefault: start.isDefault,
  });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const num = (k: "cloudPrice" | "remotePrice" | "trialDays" | "maxUsers") => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value.replace(/[^\d]/g, "") }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body: CategoryInput = {
      name: f.name.trim(),
      color: f.color,
      note: f.note.trim() || null,
      cloudPrice: Number(f.cloudPrice) || 0,
      remotePrice: Number(f.remotePrice) || 0,
      trialDays: Number(f.trialDays) || 0,
      maxUsers: Math.max(1, Number(f.maxUsers) || 1),
      maxStorageMb: Math.round((Number(f.storageGb.replace(",", ".")) || 0) * 1024),
      plateOcr: f.plateOcr,
      showAds: f.showAds,
      isDefault: f.isDefault,
    };
    try {
      if (category) {
        // Снять «для новых» нельзя — только отметить другую категорию.
        const { isDefault, ...rest } = body;
        await platformApi.updateCategory(category.id, isDefault ? body : rest);
      } else await platformApi.createCategory(body);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={category ? `Категория «${category.name}»` : "Новая категория"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Banner tone="error">{error.message}</Banner>}
        <Field label="Название" error={error?.field("name")}>
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Свои ребята" autoFocus={!category} />
        </Field>
        <div>
          <span className="text-[13px] font-semibold text-ink-soft">Цвет метки</span>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {CUSTOMER_COLORS.map((c) => (
              <button
                key={c.key}
                type="button"
                aria-label={c.label}
                aria-pressed={f.color === c.key}
                onClick={() => setF({ ...f, color: c.key })}
                className={
                  "h-8 w-8 rounded-full border-2 transition-transform " +
                  (f.color === c.key ? "scale-110 border-ink" : "border-transparent")
                }
                style={{ background: c.dot }}
              />
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Облако, ₽/мес" hint="0 — бесплатно">
            <Input inputMode="numeric" value={f.cloudPrice} onChange={num("cloudPrice")} />
          </Field>
          <Field label="Доступ из интернета, ₽/мес" hint="Для локальных">
            <Input inputMode="numeric" value={f.remotePrice} onChange={num("remotePrice")} />
          </Field>
          <Field label="Пробный срок, дней" hint="Новому клиенту до первой оплаты">
            <Input inputMode="numeric" value={f.trialDays} onChange={num("trialDays")} />
          </Field>
          <Field label="Сотрудников">
            <Input inputMode="numeric" value={f.maxUsers} onChange={num("maxUsers")} />
          </Field>
          <Field label="Место для фото, ГБ" hint="0 — без лимита">
            <Input inputMode="decimal" value={f.storageGb} onChange={(e) => setF({ ...f, storageGb: e.target.value.replace(/[^\d.,]/g, "") })} />
          </Field>
        </div>
        <div className="space-y-2">
          <Checkbox checked={f.plateOcr} onChange={(v) => setF({ ...f, plateOcr: v })} label="Распознавание шильдиков камерой" />
          <Checkbox checked={f.showAds} onChange={(v) => setF({ ...f, showAds: v })} label="Показывать рекламу в бесплатной локальной версии" />
          <Checkbox
            checked={f.isDefault}
            disabled={!!category?.isDefault}
            onChange={(v) => setF({ ...f, isDefault: v })}
            label="Сюда попадают новые клиенты"
          />
        </div>
        <Field label="Заметка">
          <Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="ребята из группы" />
        </Field>
        {category && (category.tenantCount > 0 || category.boxCount > 0) && (
          <p className="text-[12.5px] text-ink-dim">
            Новые лимиты сразу получат все её облачные мастерские, кроме тех, кому их ставили вручную. Цена
            меняется у всех, у кого нет своей.
          </p>
        )}
        <div className="flex flex-col gap-2 pt-2 sm:flex-row-reverse">
          <Button type="submit" disabled={busy || f.name.trim().length < 2} className="sm:flex-1">
            {busy ? "Сохраняем…" : "Сохранить"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} className="sm:flex-1">
            Отмена
          </Button>
        </div>
        {canRemove && (
          <button type="button" onClick={onRemove} className="w-full text-center text-[13px] font-semibold text-state-off hover:underline">
            Удалить категорию
          </button>
        )}
      </form>
    </Modal>
  );
}
