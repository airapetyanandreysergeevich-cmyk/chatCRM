import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { BrandLogo, BrandRow } from "../components/Brand";
import { Banner, Button, Field, Input, SectionLabel } from "../components/ui";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";

/**
 * Вход один на всех. Кто пришёл — сотрудник мастерской или команда платформы —
 * решает сервер по адресу. Выбирать пользователю нечего.
 */
export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login({ email, password });
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-full bg-bg lg:grid-cols-2">
      <div className="relative hidden flex-col justify-between overflow-hidden border-r border-line bg-surface p-14 lg:flex">
        <div
          className="pointer-events-none absolute -right-24 -top-24 h-[420px] w-[420px] rounded-full opacity-[0.14] blur-3xl"
          style={{ background: "radial-gradient(circle, #2F8FE0 0%, transparent 70%)" }}
        />
        <BrandRow />
        <div className="relative">
          <BrandLogo width={210} />
          <h1 className="mt-9 max-w-md text-[34px] font-extrabold leading-[1.15] tracking-tight">
            Мастерская целиком — от приёма техники до выдачи
          </h1>
          <p className="mt-4 max-w-md leading-relaxed text-ink-muted">
            Заказы, склад, закупки и зарплата в одном месте. У каждого сотрудника ровно то, что нужно
            для работы, и ничего лишнего.
          </p>
        </div>
        <p className="relative text-[13px] text-ink-dim">
          Данные каждой мастерской изолированы на уровне базы данных.
        </p>
      </div>

      <div className="flex items-center justify-center p-5 sm:p-10">
        <form onSubmit={submit} className="w-full max-w-[380px]">
          <div className="mb-9 lg:hidden">
            <BrandRow />
          </div>

          <SectionLabel>Вход</SectionLabel>
          <h2 className="mb-7 mt-2 text-[26px] font-extrabold tracking-tight">Здравствуйте</h2>

          {error && (
            <div className="mb-4">
              <Banner tone="error">{error.message}</Banner>
            </div>
          )}

          <div className="space-y-4">
            <Field label="Email" error={error?.field("email")}>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                autoCapitalize="none"
                autoFocus
                invalid={!!error?.field("email")}
              />
            </Field>
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

          <p className="mt-7 text-[13.5px] text-ink-muted">
            Ещё не подключены?{" "}
            <Link to="/register" className="font-semibold text-brand hover:text-brand-ink">
              Оставить заявку
            </Link>
          </p>
          <p className="mt-2.5 text-[12.5px] text-ink-dim">
            Забыли пароль — его меняет владелец мастерской в разделе «Сотрудники».
          </p>
        </form>
      </div>
    </div>
  );
}
