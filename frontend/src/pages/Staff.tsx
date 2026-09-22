import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Modal } from "../components/Modal";
import { IconPerson } from "../components/icons";
import {
  Badge,
  Banner,
  Button,
  Checkbox,
  Field,
  Input,
  List,
  ListRow,
  SectionLabel,
  Spinner,
  StatusGlyph,
} from "../components/ui";
import { Pager } from "../components/Pager";
import { ApiError, api, type Page } from "../lib/api";
import { formatDateTime, plural } from "../lib/format";

interface Role {
  id: string;
  name: string;
  code: string | null;
  isSystem: boolean;
  permissions: string[];
}

interface StaffRow {
  id: string;
  fullName: string;
  phone: string | null;
  email: string;
  isOwner: boolean;
  isActive: boolean;
  lastLoginAt: string | null;
  androidAppAt: string | null;
  role: { id: string; name: string; code: string | null } | null;
  /** Все роли сотрудника, основная — первой. Права у ролей складываются. */
  roles?: Array<{ id: string; name: string; code: string | null }>;
  workPercent: string | number | null;
  partPercent: string | number | null;
}

const rolesOf = (u: StaffRow) => u.roles ?? (u.role ? [u.role] : []);

export default function Staff() {
  const [rows, setRows] = useState<StaffRow[] | null>(null);
  const [pageInfo, setPageInfo] = useState({ page: 1, pages: 1, total: 0, pageSize: 50 });
  const [page, setPage] = useState(1);
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<StaffRow | null>(null);
  const [resetting, setResetting] = useState<StaffRow | null>(null);

  const load = useCallback(async () => {
    try {
      const [staff, roleList] = await Promise.all([
        api.get<Page<StaffRow>>(`/staff?page=${page}`),
        api.get<Role[]>("/roles"),
      ]);
      setRows(staff.rows);
      setPageInfo({ page: staff.page, pages: staff.pages, total: staff.total, pageSize: staff.pageSize });
      setRoles(roleList);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить сотрудников");
    }
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleActive(u: StaffRow) {
    await api.patch(`/staff/${u.id}`, { isActive: !u.isActive });
    await load();
  }

  if (error) return <Banner tone="error">{error}</Banner>;
  if (!rows) return <Spinner />;

  const active = rows.filter((r) => r.isActive).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <SectionLabel>Мастерская</SectionLabel>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight">Сотрудники</h1>
          <p className="mt-1 text-sm text-ink-muted">{plural(active, "работает", "работают", "работают")}</p>
        </div>
        <Button onClick={() => setCreating(true)}>Добавить сотрудника</Button>
      </div>

      <List>
        {rows.map((u) => (
          <ListRow
            key={u.id}
            glyph={
              <StatusGlyph
                tone={u.isActive ? "neutral" : "cancelled"}
                title={u.isActive ? "Работает" : "Доступ отключён"}
                icon={<IconPerson />}
              />
            }
            title={
              <>
                <span className={u.isActive ? "truncate" : "truncate text-ink-muted line-through"}>{u.fullName}</span>
                {u.isOwner && <Badge tone="brand">владелец</Badge>}
                {!u.isActive && <Badge tone="danger">отключён</Badge>}
              </>
            }
            subtitle={
              <>
                {rolesOf(u).length ? rolesOf(u).map((r) => r.name).join(", ") : "без роли"} · <span className="font-mono text-[13px]">{u.email}</span>
              </>
            }
            meta={
              <>
                {/* Мастер без приложения не получает оповещений о заказах —
                    владельцу стоит видеть это, не спрашивая каждого. */}
                <span
                  className={
                    "whitespace-nowrap lg:w-[128px] lg:text-right " +
                    (u.androidAppAt ? "text-state-done" : "text-ink-dim")
                  }
                >
                  {u.androidAppAt ? "приложение есть" : "без приложения"}
                </span>
                <span className="whitespace-nowrap lg:w-[150px] lg:text-right">
                  вход {formatDateTime(u.lastLoginAt)}
                </span>
              </>
            }
            actions={
              // Ширина колонки кнопок задана, чтобы у владельца, у которого кнопка
              // одна, остальные столбцы не разъезжались.
              <div className="flex flex-wrap gap-1.5 sm:min-w-[280px] sm:justify-end">
                <Button
                  variant="secondary"
                  className="min-h-[34px] px-3 text-[13px]"
                  onClick={() => setEditing(u)}
                >
                  Изменить
                </Button>
                <Button
                  variant="secondary"
                  className="min-h-[34px] px-3 text-[13px]"
                  onClick={() => setResetting(u)}
                >
                  Пароль
                </Button>
                {!u.isOwner && (
                  <Button
                    variant={u.isActive ? "danger" : "secondary"}
                    className="min-h-[34px] px-3 text-[13px]"
                    onClick={() => void toggleActive(u)}
                  >
                    {u.isActive ? "Отключить" : "Включить"}
                  </Button>
                )}
              </div>
            }
          />
        ))}
      </List>

      <Pager
        {...pageInfo}
        onPage={(n) => {
          setPage(n);
          window.scrollTo({ top: 0 });
        }}
      />

      {(creating || editing) && (
        <StaffModal
          roles={roles}
          user={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onDone={() => {
            setCreating(false);
            setEditing(null);
            void load();
          }}
        />
      )}

      {resetting && (
        <PasswordModal
          user={resetting}
          onClose={() => setResetting(null)}
          onDone={() => {
            setResetting(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

/**
 * Карточка сотрудника: создание и правка.
 *
 * Ролей можно отметить несколько: в маленькой мастерской приёмщик сам же и
 * развозит технику, а мастер принимает, когда стойка пустая. Права ролей
 * складываются. Первая отмеченная — основная, ею сотрудник подписан там,
 * где помещается одна роль.
 */
function StaffModal({
  roles,
  user,
  onClose,
  onDone,
}: {
  roles: Role[];
  user: StaffRow | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const editing = !!user;
  const pct = (v: string | number | null | undefined) => (v === null || v === undefined ? "" : String(Number(v)));
  const [form, setForm] = useState({
    fullName: user?.fullName ?? "",
    email: user?.email ?? "",
    password: "",
    phone: user?.phone ?? "",
    workPercent: pct(user?.workPercent),
    partPercent: pct(user?.partPercent),
  });
  const [roleIds, setRoleIds] = useState<string[]>(
    user ? rolesOf(user).map((r) => r.id) : roles[0] ? [roles[0].id] : []
  );
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const toggleRole = (id: string) =>
    setRoleIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const percent = (v: string) => (v.trim() === "" ? null : Number(v.replace(",", ".")));

  async function submit(e: FormEvent) {
    e.preventDefault();
    // Владельцу роль не обязательна: права у него и так все.
    if (!roleIds.length && !user?.isOwner) {
      setError(new ApiError(400, "Отметьте хотя бы одну роль"));
      return;
    }
    // Роли шлём, только если их правда меняли: иначе управляющий, правящий
    // телефон, упёрся бы в проверку «нельзя выдать права, которых нет у вас»
    // из-за ролей, выданных сотруднику владельцем.
    const before = user ? rolesOf(user).map((r) => r.id) : [];
    const rolesChanged = !user || before.join() !== roleIds.join();
    setBusy(true);
    setError(null);
    try {
      const common = {
        fullName: form.fullName,
        email: form.email,
        phone: form.phone,
        ...(rolesChanged && roleIds.length ? { roleIds } : {}),
        workPercent: percent(form.workPercent),
        partPercent: percent(form.partPercent),
      };
      if (editing) {
        await api.patch(`/staff/${user.id}`, common);
      } else {
        await api.post("/staff", {
          ...common,
          password: form.password,
          workPercent: common.workPercent ?? undefined,
          partPercent: common.partPercent ?? undefined,
        });
      }
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={editing ? user.fullName : "Новый сотрудник"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Banner tone="error">{error.message}</Banner>}
        <Field label="Имя" error={error?.field("fullName")}>
          <Input value={form.fullName} onChange={set("fullName")} invalid={!!error?.field("fullName")} />
        </Field>

        <div>
          <span className="mb-1.5 block text-[13px] font-semibold text-ink-soft">Роли</span>
          {user?.isOwner && (
            <p className="mb-2 text-[12.5px] text-ink-dim">
              У владельца все права и так — роли нужны, чтобы он попадал в списки, например мастеров.
            </p>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            {roles.map((r) => (
              <Checkbox
                key={r.id}
                checked={roleIds.includes(r.id)}
                onChange={() => toggleRole(r.id)}
                label={
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{r.name}</span>
                    {roleIds[0] === r.id && roleIds.length > 1 && <Badge tone="brand">основная</Badge>}
                  </span>
                }
              />
            ))}
          </div>
          <span className="mt-1.5 block text-[12.5px] text-ink-dim">
            Можно отметить несколько — например, «Приёмщик» и «Курьер». Права ролей складываются.
          </span>
          {error?.field("roleIds") && (
            <span className="mt-1.5 block text-[12.5px] text-state-off">{error.field("roleIds")}</span>
          )}
        </div>

        <Field
          label="Email"
          error={error?.field("email")}
          hint="По нему сотрудник входит в систему. Нет почты — подойдёт адрес вида master1@masterskaya.local"
        >
          <Input
            type="email"
            value={form.email}
            onChange={set("email")}
            autoCapitalize="none"
            invalid={!!error?.field("email")}
          />
        </Field>
        {!editing && (
          <Field label="Пароль" error={error?.field("password")} hint="От 8 символов. Сотрудник сменит его сам.">
            <Input value={form.password} onChange={set("password")} invalid={!!error?.field("password")} />
          </Field>
        )}
        <Field label="Телефон" error={error?.field("phone")}>
          <Input value={form.phone} onChange={set("phone")} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Процент с работ" hint="Для расчёта зарплаты" error={error?.field("workPercent")}>
            <Input inputMode="decimal" value={form.workPercent} onChange={set("workPercent")} />
          </Field>
          <Field label="Процент с запчастей" error={error?.field("partPercent")}>
            <Input inputMode="decimal" value={form.partPercent} onChange={set("partPercent")} />
          </Field>
        </div>
        {editing && (
          <p className="text-[12.5px] text-ink-dim">
            Новые права начнут действовать при следующем обновлении входа сотрудника — обычно в течение нескольких минут.
          </p>
        )}
        <div className="flex flex-col gap-2 pt-2 sm:flex-row-reverse">
          <Button type="submit" disabled={busy} className="sm:flex-1">
            {busy ? "Сохраняем…" : editing ? "Сохранить" : "Добавить"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} className="sm:flex-1">
            Отмена
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function PasswordModal({ user, onClose, onDone }: { user: StaffRow; onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/staff/${user.id}/password`, { password });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Пароль для ${user.fullName}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Banner>Сотрудник выйдет из системы на всех устройствах — это и есть смысл смены пароля.</Banner>
        {error && <Banner tone="error">{error.message}</Banner>}
        <Field label="Новый пароль" error={error?.field("password")}>
          <Input value={password} onChange={(e) => setPassword(e.target.value)} invalid={!!error?.field("password")} />
        </Field>
        <div className="flex flex-col gap-2 pt-2 sm:flex-row-reverse">
          <Button type="submit" disabled={busy} className="sm:flex-1">
            {busy ? "Меняем…" : "Сменить"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} className="sm:flex-1">
            Отмена
          </Button>
        </div>
      </form>
    </Modal>
  );
}
