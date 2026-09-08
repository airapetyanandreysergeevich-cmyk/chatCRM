import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ApiError, api } from "../lib/api";
import { Banner, Button, Card, Field, Input, SectionLabel } from "../components/ui";

/**
 * Заявка на подключение мастерской. Форма открыта всем, поэтому спрашиваем минимум:
 * чем короче анкета, тем больше людей доходит до конца. Остальное выясняется по телефону.
 */
export default function Register() {
  const [form, setForm] = useState({
    workshopName: "",
    ownerFullName: "",
    ownerPhone: "",
    ownerEmail: "",
    password: "",
    city: "",
  });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post("/public/register", form);
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="flex min-h-full items-center justify-center bg-canvas p-5">
        <Card className="max-w-[460px]">
          <SectionLabel>Заявка отправлена</SectionLabel>
          <h1 className="mt-2 text-2xl font-extrabold tracking-tight">Спасибо, {form.ownerFullName}</h1>
          <p className="mt-3 text-ink-muted">
            Мы посмотрим заявку и свяжемся с вами по телефону {form.ownerPhone}. После подключения вход будет
            по адресу {form.ownerEmail} и паролю, который вы задали, — придумывать заново ничего не придётся.
          </p>
          <Link to="/login" className="mt-5 inline-block font-bold text-primary">
            Вернуться ко входу
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-canvas px-5 py-10">
      <div className="mx-auto max-w-[460px]">
        <div className="mb-8 flex items-center gap-3">
          <div className="h-11 w-11 rounded-xl bg-primary" />
          <span className="text-lg font-extrabold tracking-tight">RepairShop</span>
        </div>

        <SectionLabel>Подключение</SectionLabel>
        <h1 className="mb-2 mt-2 text-2xl font-extrabold tracking-tight">Заявка на подключение мастерской</h1>
        <p className="mb-6 text-ink-muted">
          Заполните пять полей — мы посмотрим заявку и откроем доступ. Обычно это занимает один рабочий день.
        </p>

        <form onSubmit={submit} className="space-y-4">
          {error && <Banner tone="error">{error.message}</Banner>}

          <Field label="Название мастерской" error={error?.field("workshopName")}>
            <Input
              value={form.workshopName}
              onChange={set("workshopName")}
              placeholder="Сервис на Ленина"
              invalid={!!error?.field("workshopName")}
            />
          </Field>
          <Field label="Ваше имя" error={error?.field("ownerFullName")}>
            <Input value={form.ownerFullName} onChange={set("ownerFullName")} invalid={!!error?.field("ownerFullName")} />
          </Field>
          <Field label="Телефон" error={error?.field("ownerPhone")} hint="По нему свяжемся перед подключением">
            <Input
              type="tel"
              value={form.ownerPhone}
              onChange={set("ownerPhone")}
              placeholder="+7 900 000-00-00"
              invalid={!!error?.field("ownerPhone")}
            />
          </Field>
          <Field label="Email" error={error?.field("ownerEmail")} hint="По нему вы будете входить в систему">
            <Input
              type="email"
              value={form.ownerEmail}
              onChange={set("ownerEmail")}
              autoCapitalize="none"
              invalid={!!error?.field("ownerEmail")}
            />
          </Field>
          <Field label="Пароль" error={error?.field("password")} hint="От 8 символов. Менять после одобрения не нужно.">
            <Input
              type="password"
              value={form.password}
              onChange={set("password")}
              autoComplete="new-password"
              invalid={!!error?.field("password")}
            />
          </Field>
          <Field label="Город" error={error?.field("city")}>
            <Input value={form.city} onChange={set("city")} />
          </Field>

          <Button type="submit" disabled={busy} className="w-full">
            {busy ? "Отправляем…" : "Отправить заявку"}
          </Button>
        </form>

        <p className="mt-5 text-[13px] text-ink-muted">
          Уже подключены?{" "}
          <Link to="/login" className="font-bold text-primary">
            Войти
          </Link>
        </p>
      </div>
    </div>
  );
}
