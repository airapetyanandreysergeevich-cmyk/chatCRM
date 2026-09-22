import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  Banner,
  Button,
  Card,
  Checkbox,
  PageHeader,
  SectionLabel,
  Spinner,
  Textarea,
} from "../components/ui";
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
 * Всё, что нужно сделать, — вставить одну фразу и нажать «Подключить».
 * В ней уже и адрес сервера, и ключ, и код мастерской: переписывать по
 * отдельности нечего, а значит, и ошибиться негде. Обратно фраза не
 * показывается никогда — видно только четыре последних знака ключа.
 */

interface State {
  enabled: boolean;
  /** Фраза уже вставлена: можно просто двигать переключатель. */
  connected: boolean;
  keyHint: string;
  code: string;
  /** Почта, на которую поставщик выдал доступ. */
  email: string;
  address: string;
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
  const [phrase, setPhrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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

  async function save(enabled: boolean, withPhrase: boolean) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.put("/settings/remote-access", {
        enabled,
        phrase: withPhrase ? phrase.trim() : undefined,
      });
      if (withPhrase) {
        setPhrase("");
        setNotice("Фраза принята — подключаемся");
      }
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
      {notice && <Banner>{notice}</Banner>}

      <Card>
        <SectionLabel>Состояние</SectionLabel>
        <p className={"mt-2 text-[17px] font-bold " + status.tone}>{status.text}</p>
        {data.detail && data.state === "error" && <p className="mt-1 text-[13px] text-ink-muted">{data.detail}</p>}

        {data.address && (
          <p className="mt-3 text-[13.5px]">
            <span className="text-ink-muted">Адрес мастерской: </span>
            <a href={data.address} target="_blank" rel="noreferrer" className="font-semibold text-brand-ink hover:underline">
              {data.address}
            </a>
          </p>
        )}

        {data.connected && (
          <p className="mt-2 text-[13px] text-ink-dim">
            Фраза подключена, ключ …{data.keyHint}
            {data.email && ` · выдана на ${data.email}`}
          </p>
        )}

        <div className="mt-4">
          <Checkbox
            label="Пускать в мастерскую из интернета"
            checked={data.enabled}
            disabled={busy || !data.connected}
            onChange={(next) => void save(next, false)}
          />
          {!data.connected && (
            <p className="mt-1.5 text-[12.5px] text-ink-dim">
              Сначала вставьте фразу подключения — её выдаёт поставщик программы.
            </p>
          )}
        </div>

        <p className="mt-3 text-[13px] leading-relaxed text-ink-dim">
          Компьютер с Основой для этого должен быть включён: когда он спит, адрес не отвечает.
        </p>
      </Card>

      <Card>
        <SectionLabel>{data.connected ? "Новая фраза подключения" : "Фраза подключения"}</SectionLabel>
        <form
          className="mt-3 space-y-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void save(true, true);
          }}
        >
          <Textarea
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            rows={3}
            spellCheck={false}
            autoCapitalize="none"
            aria-label="Фраза подключения"
            placeholder="FINECRM-…"
            className="font-mono text-[13px]"
          />
          <p className="text-[12.5px] leading-relaxed text-ink-dim">
            Вставьте строку, которую прислал поставщик программы, целиком — вместе с началом FINECRM-.
            Лишний текст вокруг не помешает.
            {data.connected && " Пока не вставите новую, работает прежняя."}
          </p>
          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <Button type="submit" disabled={busy || !phrase.trim()} className="sm:min-w-[200px]">
              {busy ? "Подключаем…" : "Подключить"}
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
          <li>
            Фраза — это пароль от входа снаружи. Передавайте её так же бережно и не пересылайте в
            общие чаты.
          </li>
        </ul>
      </Card>
    </div>
  );
}
