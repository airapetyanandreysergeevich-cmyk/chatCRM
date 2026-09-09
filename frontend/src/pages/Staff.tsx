import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Modal } from "../components/Modal";
import { Banner, Button, Card, Field, Input, SectionLabel, Select, Spinner } from "../components/ui";
import { ApiError, api } from "../lib/api";
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
}

export default function Staff() {
  const [rows, setRows] = useState<StaffRow[] | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<StaffRow | null>(null);

  const load = useCallback(async () => {
    try {
      const [staff, roleList] = await Promise.all([api.get<StaffRow[]>("/staff"), api.get<Role[]>("/roles")]);
      setRows(staff);
      setRoles(roleList);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить сотрудников");
    }
  }, []);

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

      <div className="grid gap-3 lg:grid-cols-2">
        {rows.map((u) => (
          <Card key={u.id}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-[17px] font-bold leading-tight">
                  {u.fullName}
                  {u.isOwner && <span className="ml-2 text-[13px] font-bold text-brand">владелец</span>}
                </h2>
                <p className="mt-1 text-sm text-ink-muted">
                  {u.role?.name ?? "без роли"} · <span className="font-mono">{u.email}</span>
                </p>
              </div>
              {!u.isActive && <span className="rounded-pill bg-surface-raised px-2.5 py-1 text-[12.5px] font-semibold text-ink-dim">отключён</span>}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3 text-[13px] text-ink-muted">
              <span>Последний вход: {formatDateTime(u.lastLoginAt)}</span>
              {/* Мастер без приложения не получает оповещений о заказах —
                  владельцу стоит видеть это, не спрашивая каждого. */}
              {u.androidAppAt ? (
                <span className="text-ink-dim">приложение установлено</span>
              ) : (
                <span className="text-ink-dim">приложение не установлено</span>
              )}
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" className="px-4 text-sm" onClick={() => setResetting(u)}>
                Сменить пароль
              </Button>
              {!u.isOwner && (
                <Button variant={u.isActive ? "danger" : "secondary"} className="px-4 text-sm" onClick={() => void toggleActive(u)}>
                  {u.isActive ? "Отключить" : "Включить"}
                </Button>
              )}
            </div>
          </Card>
        ))}
      </div>

      {creating && (
        <StaffModal
          roles={roles}
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
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

function StaffModal({ roles, onClose, onDone }: { roles: Role[]; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({
    fullName: "",
    email: "",
    password: "",
    phone: "",
    roleId: roles[0]?.id ?? "",
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
      await api.post("/staff", form);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Новый сотрудник" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Banner tone="error">{error.message}</Banner>}
        <Field label="Имя" error={error?.field("fullName")}>
          <Input value={form.fullName} onChange={set("fullName")} invalid={!!error?.field("fullName")} />
        </Field>
        <Field label="Роль" error={error?.field("roleId")} hint="Роль определяет, что сотрудник видит и может менять">
          <Select value={form.roleId} onChange={set("roleId")} invalid={!!error?.field("roleId")}>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
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
        <Field label="Пароль" error={error?.field("password")} hint="От 8 символов. Сотрудник сменит его сам.">
          <Input value={form.password} onChange={set("password")} invalid={!!error?.field("password")} />
        </Field>
        <Field label="Телефон" error={error?.field("phone")}>
          <Input value={form.phone} onChange={set("phone")} />
        </Field>
        <div className="flex flex-col gap-2 pt-2 sm:flex-row-reverse">
          <Button type="submit" disabled={busy} className="sm:flex-1">
            {busy ? "Создаём…" : "Добавить"}
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
