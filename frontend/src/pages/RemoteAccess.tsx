import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Modal } from "../components/Modal";
import {
  Banner,
  Button,
  Card,
  Checkbox,
  Input,
  PageHeader,
  SectionLabel,
  Spinner,
  Textarea,
} from "../components/ui";
import { ApiError, api } from "../lib/api";
import { formatDateTime } from "../lib/format";

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

/** Кому владелец уже выдавал ключ — список для памяти, а не для проверки. */
interface StaffEntry {
  id: string;
  label: string;
  issuedAt: string;
}

interface State {
  enabled: boolean;
  /** Фраза уже вставлена: можно просто двигать переключатель. */
  connected: boolean;
  keyHint: string;
  code: string;
  /** Почта, на которую поставщик выдал доступ. */
  email: string;
  /** Имя мастерской в облаке: по нему входят сотрудники на общем сайте. */
  tag: string;
  address: string;
  staff: StaffEntry[];
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

        {/* Главное, что владельцу нужно отсюда унести: как его людям
            представляться на общем сайте. Показываем не само имя, а готовый
            образец — его и продиктуют сотруднику. */}
        {data.tag && (
          <div className="mt-4 rounded-field border border-line bg-surface-input px-3.5 py-3">
            <p className="text-[13px] font-semibold text-ink-soft">Как входят ваши сотрудники</p>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-muted">
              На www.finecrm.ru, обычной формой входа: своя почта, к которой дописано имя вашей
              мастерской — <span className="font-mono text-[13px] text-ink">.{data.tag}</span>
            </p>
            <p className="mt-2 break-all font-mono text-[13px]">
              anton@repair.ru<span className="font-bold text-brand-ink">.{data.tag}</span>
            </p>
            <p className="mt-2 text-[12.5px] leading-relaxed text-ink-dim">
              Пароль остаётся прежним и проверяется здесь, у вас: облако его не видит. Заводить
              сотрудников по-прежнему в разделе «Сотрудники» — отдельно ничего создавать не нужно.
            </p>
          </div>
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

      <StaffKeys data={data} onChange={load} />

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
          <li>
            Ключ сотрудника — не пароль: в нём только адрес вашей мастерской. Уволился человек или
            потерял телефон — отключите его учётную запись в разделе «Сотрудники»: и ключ, и вход с
            сайта перестанут что-либо давать.
          </li>
        </ul>
      </Card>
    </div>
  );
}

/**
 * Ключи для сотрудников.
 *
 * Адрес мастерской теперь случайный — /b/kn7tuw2m4p9xzq, и продиктовать его
 * по телефону нельзя: ошибутся на третьем знаке. Поэтому владелец выдаёт
 * каждому строку, а сотрудник вставляет её на странице «Подключение» — в
 * программе для Windows, на телефоне или на сайте, — и попадает на экран
 * входа своей мастерской.
 *
 * Прав такой ключ не даёт никаких: вход остаётся прежним, логином и паролем.
 * Поэтому и «отозвать» его нечем — отзывается учётная запись сотрудника.
 * Список выданных нужен только владельцу: вспомнить, кому уже отправлял.
 */
function StaffKeys({ data, onChange }: { data: State; onChange: () => Promise<void> }) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ key: string; label: string } | null>(null);

  async function issue(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ key: string }>("/settings/remote-access/staff-key", {
        label: label.trim(),
      });
      setIssued({ key: res.key, label: label.trim() });
      setLabel("");
      await onChange();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось выдать ключ");
    } finally {
      setBusy(false);
    }
  }

  async function forget(id: string) {
    await api.del(`/settings/remote-access/staff-key/${id}`);
    await onChange();
  }

  return (
    <Card>
      <SectionLabel>Ключи для сотрудников</SectionLabel>
      <p className="mt-2 text-[13.5px] leading-relaxed text-ink-muted">
        Нужны только для программы на Windows: при первом запуске сотрудник выбирает «Клиент» и
        вставляет ключ — адрес мастерской внутри, диктовать его не придётся. На сайте ключ не нужен:
        там входят почтой с именем мастерской.
      </p>

      {!data.connected ? (
        <p className="mt-3 text-[12.5px] text-ink-dim">
          Ключи появятся, когда мастерская будет подключена: адрес для них берётся отсюда же.
        </p>
      ) : (
        <>
          {error && (
            <div className="mt-3">
              <Banner tone="error">{error}</Banner>
            </div>
          )}
          <form onSubmit={issue} className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Кому: Иван, приёмщик"
              aria-label="Кому выдаётся ключ"
              maxLength={60}
            />
            <Button type="submit" disabled={busy || !label.trim()} className="sm:min-w-[170px]">
              {busy ? "Выдаём…" : "Выдать ключ"}
            </Button>
          </form>

          {data.staff.length > 0 && (
            <ul className="mt-4 divide-y divide-line border-t border-line">
              {data.staff.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] font-semibold">{s.label}</span>
                    <span className="text-[12.5px] text-ink-dim">выдан {formatDateTime(s.issuedAt)}</span>
                  </span>
                  <Button
                    variant="secondary"
                    className="min-h-[34px] shrink-0 px-3 text-[13px]"
                    onClick={() => void forget(s.id)}
                  >
                    Убрать
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-[12.5px] leading-relaxed text-ink-dim">
            Ключ можно выдать ещё раз в любой момент: он один и тот же для всех — это просто адрес
            вашей мастерской. «Убрать» стирает запись из списка, у сотрудника ничего не меняется.
            Через браузер — с телефона или с чужого компьютера — ключ не нужен вовсе.
          </p>
        </>
      )}

      {issued && <StaffKeyModal issued={issued} onClose={() => setIssued(null)} />}
    </Card>
  );
}

/** Ключ целиком — чтобы скопировать одной кнопкой и отправить человеку. */
function StaffKeyModal({
  issued,
  onClose,
}: {
  issued: { key: string; label: string };
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(issued.key);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Modal title={`Ключ для: ${issued.label}`} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-[13.5px] leading-relaxed text-ink-muted">
          Отправьте эту строку сотруднику. При первом запуске программы он выберет «Клиент» и
          вставит её в поле «Ключ подключения или адрес» — и увидит привычный вход.
        </p>
        <div className="break-all rounded-field border border-line bg-surface-input px-3 py-2.5 font-mono text-[13px]">
          {issued.key}
        </div>
        {copied && <p className="text-center text-[13px] text-state-done">Скопировано</p>}
        <Button type="button" onClick={() => void copy()} className="w-full">
          Скопировать ключ
        </Button>
        <Button type="button" variant="secondary" onClick={onClose} className="w-full">
          Готово
        </Button>
      </div>
    </Modal>
  );
}
