import { useState, type FormEvent } from "react";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button, Field, Input, SectionLabel, Banner } from "../components/ui";

type Mode = "tenant" | "platform";

export default function Login() {
  const { loginTenant, loginPlatform } = useAuth();
  const [mode, setMode] = useState<Mode>("tenant");
  const [workshop, setWorkshop] = useState("");
  const [login, setLogin] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "tenant") await loginTenant({ workshop, login, password });
      else await loginPlatform({ email, password });
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-full lg:grid-cols-2">
      <div className="hidden flex-col justify-between bg-surface-muted p-14 lg:flex">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 rounded-xl bg-primary" />
          <span className="text-lg font-extrabold tracking-tight">RepairShop</span>
        </div>
        <div>
          <h1 className="max-w-md text-4xl font-extrabold leading-tight tracking-tight">
            Мастерская целиком — от приёма техники до выдачи
          </h1>
          <p className="mt-4 max-w-md text-ink-muted">
            Заказы, склад, закупки и зарплата в одном месте. У каждого сотрудника — ровно то, что нужно для работы,
            и ничего лишнего.
          </p>
        </div>
        <p className="text-[13px] text-ink-muted">Данные каждой мастерской изолированы на уровне базы данных.</p>
      </div>

      <div className="flex items-center justify-center p-5 sm:p-10">
        <form onSubmit={submit} className="w-full max-w-[420px]">
          <div className="mb-6 flex items-center gap-3 lg:hidden">
            <div className="h-11 w-11 rounded-xl bg-primary" />
            <span className="text-lg font-extrabold tracking-tight">RepairShop</span>
          </div>

          <div className="mb-6 grid grid-cols-2 gap-1 rounded-field bg-surface-muted p-1.5">
            {(
              [
                ["tenant", "Мастерская"],
                ["platform", "Платформа"],
              ] as Array<[Mode, string]>
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setMode(value);
                  setError(null);
                }}
                className={
                  "rounded-[11px] py-2.5 text-[15px] font-bold transition " +
                  (mode === value ? "bg-surface shadow-card" : "text-ink-muted")
                }
              >
                {label}
              </button>
            ))}
          </div>

          <SectionLabel>{mode === "tenant" ? "Вход для сотрудников" : "Вход для владельца платформы"}</SectionLabel>
          <h2 className="mb-6 mt-2 text-2xl font-extrabold tracking-tight">Вход</h2>

          {error && (
            <div className="mb-4">
              <Banner tone="error">{error.message}</Banner>
            </div>
          )}

          <div className="space-y-4">
            {mode === "tenant" ? (
              <>
                <Field label="Мастерская" error={error?.field("workshop")} hint="Короткий код, который выдали при подключении">
                  <Input
                    value={workshop}
                    onChange={(e) => setWorkshop(e.target.value)}
                    autoComplete="organization"
                    autoCapitalize="none"
                    placeholder="masterskaya"
                    invalid={!!error?.field("workshop")}
                  />
                </Field>
                <Field label="Логин" error={error?.field("login")}>
                  <Input
                    value={login}
                    onChange={(e) => setLogin(e.target.value)}
                    autoComplete="username"
                    autoCapitalize="none"
                    invalid={!!error?.field("login")}
                  />
                </Field>
              </>
            ) : (
              <Field label="Email" error={error?.field("email")}>
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  invalid={!!error?.field("email")}
                />
              </Field>
            )}

            <Field label="Пароль" error={error?.field("password")}>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                invalid={!!error?.field("password")}
              />
            </Field>
          </div>

          <Button type="submit" disabled={busy} className="mt-6 w-full">
            {busy ? "Проверяем…" : "Войти"}
          </Button>

          <p className="mt-5 text-[13px] text-ink-muted">
            Забыли пароль — его меняет владелец мастерской в разделе «Сотрудники».
          </p>
        </form>
      </div>
    </div>
  );
}
