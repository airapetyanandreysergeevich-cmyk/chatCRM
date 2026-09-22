import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Banner, Button, Card, Checkbox, Field, Input, PageHeader, SectionLabel, Spinner } from "../components/ui";
import { ApiError, api } from "../lib/api";

/**
 * Доступ к Основе из интернета — экран владельца мастерской.
 *
 * Основа стоит в мастерской и по умолчанию видна только в своей сети: это её
 * достоинство, а не недостаток — база заказов никуда не уезжает. Но мастеру
 * из дома и владельцу из отпуска тоже надо заходить, поэтому есть туннель:
 * программа сама соединяется с сервером поставщика, и тот отдаёт ей адрес в
 * интернете. Наружу мастерская по-прежнему ничего не открывает.
 *
 * Ключ выдаёт поставщик программы, он же его отзывает. Здесь ключ только
 * вставляют, и обратно он не показывается: видно четыре последних знака —
 * ровно чтобы отличить один ключ от другого.
 */

interface State {
  enabled: boolean;
  keyHint: string;
  url: string;
  state: "off" | "connecting" | "online" | "error";
  detail: string | null;
}

const WORDS: Record<State["state"], { text: string; tone: string }> = {
  off: { text: "Выключен", tone: "text-ink-muted" },
  connecting: { text: "Подключаемся…", tone: "text-state-waiting" },
  online: { text: "На связи", tone: "text-state-done" },
  error: { text: "Не удаётся подключиться", tone: "text-state-off" },
};

export default function RemoteAccess() {
  const [data, setData] = useState<State | null>(null);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.get<State>("/settings/remote-access"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось прочитать настройку");
    }
  }, []);

  useEffect(() => {
    void load();
    // Связь появляется и пропадает сама: пока экран открыт, показываем правду.
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [load]);

  async function save(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      await api.put("/settings/remote-access", { enabled, key: key.trim() || undefined });
      setKey("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  if (error && !data) return <Banner tone="error">{error}</Banner>;
  if (!data) return <Spinner />;

  const status = WORDS[data.state];

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Настройки"
        title="Доступ из интернета"
        subtitle="Чтобы сотрудники заходили в вашу Основу не только из мастерской."
      />

      {error && <Banner tone="error">{error}</Banner>}

      <Card>
        <SectionLabel>Состояние</SectionLabel>
        <p className={"mt-2 text-[17px] font-bold " + status.tone}>{status.text}</p>
        {data.detail && data.state === "error" && (
          <p className="mt-1 text-[13px] text-ink-muted">{data.detail}</p>
        )}
        {data.enabled && data.keyHint && (
          <p className="mt-2 text-[13px] text-ink-dim">Ключ …{data.keyHint}</p>
        )}
        <p className="mt-3 text-[13px] leading-relaxed text-ink-dim">
          Адрес, по которому открывается мастерская, выдаёт поставщик программы вместе с ключом.
          Компьютер с Основой для этого должен быть включён: когда он спит, адрес не отвечает.
        </p>
      </Card>

      <Card>
        <SectionLabel>Ключ доступа</SectionLabel>
        <form
          className="mt-3 space-y-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void save(true);
          }}
        >
          <Field
            label={data.keyHint ? "Новый ключ" : "Ключ"}
            hint={
              data.keyHint
                ? "Оставьте пустым, чтобы сохранить прежний ключ"
                : "Его выдаёт поставщик программы — скопируйте целиком"
            }
          >
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoCapitalize="none"
              autoComplete="off"
              placeholder={data.keyHint ? `…${data.keyHint}` : ""}
            />
          </Field>

          <Checkbox
            label="Пускать в мастерскую из интернета"
            checked={data.enabled}
            disabled={busy}
            onChange={(next) => void save(next)}
          />

          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <Button type="submit" disabled={busy || (!key.trim() && data.enabled)} className="sm:min-w-[200px]">
              {busy ? "Сохраняем…" : data.enabled ? "Сменить ключ" : "Включить"}
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <SectionLabel>Что важно знать</SectionLabel>
        <ul className="mt-3 space-y-2 text-[13.5px] leading-relaxed text-ink-muted">
          <li>
            Заказы, фотографии и пароли остаются на вашем компьютере. Сервер поставщика только
            передаёт запросы туда и обратно и ничего не хранит.
          </li>
          <li>
            Вход остаётся прежним: логин и пароль сотрудника. Тот, у кого их нет, ничего не увидит,
            даже зная адрес.
          </li>
          <li>
            Выключили здесь — доступ снаружи пропал сразу. Работа в самой мастерской, по локальной
            сети, от этого не зависит вовсе.
          </li>
        </ul>
      </Card>
    </div>
  );
}
