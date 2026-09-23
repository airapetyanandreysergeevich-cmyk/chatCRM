import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { BrandMark } from "../components/Brand";
import { Banner, Button, Card, SectionLabel, Textarea } from "../components/ui";
import { parseStaffKey } from "../lib/staffKey";

/**
 * Подключение к мастерской по ключу.
 *
 * Сотруднику нельзя диктовать адрес вида /b/kn7tuw2m4p9xzq — он ошибётся на
 * третьем знаке. Владелец выдаёт ему строку, сотрудник вставляет её здесь и
 * попадает на экран входа своей мастерской, где дальше всё как обычно: логин
 * и пароль.
 *
 * Страница открыта всем и ничего не проверяет: ключ не даёт прав, он только
 * говорит, куда идти. Права даёт учётная запись, и её отключает владелец.
 */
export default function Connect() {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const parsed = parseStaffKey(text);

  function go(e: FormEvent) {
    e.preventDefault();
    if (!parsed) {
      setError("Это не похоже на ключ подключения. Скопируйте строку целиком — она начинается с FINECRM-S-");
      return;
    }
    window.location.href = parsed.address;
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-[520px] flex-col justify-center gap-5 p-5">
      <div className="text-center">
        <BrandMark size={44} />
        <h1 className="mt-4 text-2xl font-extrabold tracking-tight">Подключение к мастерской</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-muted">
          Вставьте ключ, который дал владелец мастерской. Он нужен один раз — дальше входите обычным
          логином и паролем.
        </p>
      </div>

      <Card>
        <form onSubmit={go} className="space-y-3">
          {error && <Banner tone="error">{error}</Banner>}
          <SectionLabel>Ключ подключения</SectionLabel>
          <Textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
            }}
            rows={3}
            spellCheck={false}
            autoCapitalize="none"
            aria-label="Ключ подключения"
            placeholder="FINECRM-S-…"
            className="font-mono text-[13px]"
          />
          {parsed && (
            <p className="text-[13px] text-state-done">
              {parsed.workshop ? `Мастерская «${parsed.workshop}»` : "Мастерская найдена"}
              {parsed.label ? ` · ключ для: ${parsed.label}` : ""}
            </p>
          )}
          <Button type="submit" disabled={!text.trim()} className="w-full">
            Подключиться
          </Button>
        </form>
      </Card>

      <p className="text-center text-[13px] text-ink-dim">
        Работаете в облачной версии?{" "}
        <Link to="/login" className="font-semibold text-brand-ink hover:underline">
          Обычный вход
        </Link>
      </p>
    </div>
  );
}
