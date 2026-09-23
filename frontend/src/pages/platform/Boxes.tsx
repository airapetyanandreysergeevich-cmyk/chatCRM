import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Modal } from "../../components/Modal";
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  Field,
  Input,
  List,
  ListRow,
  SectionLabel,
  Spinner,
  StatusGlyph,
} from "../../components/ui";
import { ApiError, api } from "../../lib/api";
import { formatDateTime } from "../../lib/format";

/**
 * Коробочные мастерские: кому открыт доступ к своей Основе из интернета.
 *
 * Мастерская работает у себя, на своём компьютере, и её база никуда не
 * уезжает. Здесь выдаётся только право подключиться к нашему серверу — одной
 * фразой, в которой и адрес, и ключ, и код мастерской. Выключатель рядом —
 * это и есть рубильник услуги: выключили, и адрес перестал работать, а
 * программа в мастерской продолжает работать по локальной сети как ни в чём
 * не бывало.
 *
 * Фраза показывается один раз, при выдаче: у нас хранится только отпечаток
 * ключа. Потерялась — выпускаем новую, прежняя сразу перестаёт действовать.
 */

interface Box {
  id: string;
  code: string;
  /** Почта того, кто запросил доступ: она же имя мастерской в списке. */
  email: string;
  keyHint: string;
  note: string | null;
  isActive: boolean;
  online: boolean;
  lastSeenAt: string | null;
  createdAt: string;
}

const addressOf = (code: string) => `${window.location.origin}/b/${code}/`;

export default function Boxes() {
  const [rows, setRows] = useState<Box[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<{ code: string; email: string; phrase: string; address: string } | null>(null);
  const [confirmKey, setConfirmKey] = useState<Box | null>(null);

  const load = useCallback(async () => {
    try {
      setRows(await api.get<Box[]>("/platform/boxes"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить список");
    }
  }, []);

  useEffect(() => {
    void load();
    // Кто на связи — меняется само по себе: у мастерской выключили компьютер,
    // пропал интернет. Обновляем раз в полминуты, чтобы список не врал.
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  async function toggle(box: Box) {
    await api.patch(`/platform/boxes/${box.id}`, { isActive: !box.isActive });
    await load();
  }

  async function reissue(box: Box) {
    const next = await api.post<{ code: string; email: string; phrase: string; address: string }>(
      `/platform/boxes/${box.id}/key`,
      {}
    );
    setConfirmKey(null);
    setIssued(next);
    await load();
  }

  if (error) return <Banner tone="error">{error}</Banner>;
  if (!rows) return <Spinner />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <SectionLabel>Платформа</SectionLabel>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight">Коробочные мастерские</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Доступ к своей Основе из интернета: {rows.filter((r) => r.online).length} на связи из {rows.length}
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>Открыть доступ</Button>
      </div>

      {rows.length === 0 ? (
        <EmptyState title="Пока никому не открыт">
          Мастерская с коробочной версией работает у себя по локальной сети. Чтобы сотрудники могли
          заходить и снаружи, выдайте доступ на почту владельца — он получит фразу подключения и
          вставит её в программе, в разделе «Настройки → Доступ из интернета».
        </EmptyState>
      ) : (
        <List>
          {rows.map((b) => (
            <ListRow
              key={b.id}
              glyph={
                <StatusGlyph
                  tone={b.online ? "done" : b.isActive ? "neutral" : "cancelled"}
                  title={b.online ? "На связи" : b.isActive ? "Нет связи" : "Доступ выключен"}
                />
              }
              title={
                <>
                  <span className={b.isActive ? "truncate" : "truncate text-ink-muted line-through"}>{b.email}</span>
                  {b.online && <Badge tone="brand">на связи</Badge>}
                  {!b.isActive && <Badge tone="danger">выключен</Badge>}
                </>
              }
              subtitle={
                <>
                  <a
                    href={addressOf(b.code)}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="font-mono text-[12.5px] text-brand-ink hover:underline"
                  >
                    /b/{b.code}/
                  </a>
                  <span className="text-ink-dim"> · ключ …{b.keyHint}</span>
                  {b.note && <span className="text-ink-dim"> · {b.note}</span>}
                </>
              }
              meta={
                <span className="whitespace-nowrap lg:w-[190px] lg:text-right">
                  {b.online ? "сейчас" : `была ${formatDateTime(b.lastSeenAt)}`}
                </span>
              }
              actions={
                <div className="flex flex-wrap gap-1.5 sm:min-w-[230px] sm:justify-end">
                  <Button
                    variant="secondary"
                    className="min-h-[34px] px-3 text-[13px]"
                    onClick={() => setConfirmKey(b)}
                  >
                    Новая фраза
                  </Button>
                  <Button
                    variant={b.isActive ? "danger" : "secondary"}
                    className="min-h-[34px] px-3 text-[13px]"
                    onClick={() => void toggle(b)}
                  >
                    {b.isActive ? "Выключить" : "Включить"}
                  </Button>
                </div>
              }
            />
          ))}
        </List>
      )}

      {creating && (
        <NewBoxModal
          onClose={() => setCreating(false)}
          onDone={(box) => {
            setCreating(false);
            setIssued(box);
            void load();
          }}
        />
      )}

      {confirmKey && (
        <Modal title={`Новая фраза для ${confirmKey.email}`} onClose={() => setConfirmKey(null)}>
          <div className="space-y-4">
            <Banner tone="warning">
              Прежняя фраза перестанет работать сразу, и мастерская отключится. Новую придётся вставить
              в программе — до этого доступ из интернета работать не будет.
            </Banner>
            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              <Button variant="danger" onClick={() => void reissue(confirmKey)} className="sm:flex-1">
                Выпустить новую
              </Button>
              <Button variant="secondary" onClick={() => setConfirmKey(null)} className="sm:flex-1">
                Отмена
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {issued && <PhraseModal issued={issued} onClose={() => setIssued(null)} />}
    </div>
  );
}

/**
 * Открыть доступ — одно поле.
 *
 * Спрашиваем только почту того, кто запросил доступ: она же подпись в списке
 * и адресат письма, когда фразу попросят прислать заново. Код в адресе сервер
 * придумывает сам и делает его случайным — из почты его не выводят нарочно,
 * чтобы по чужому адресу нельзя было догадаться, чья это мастерская.
 */
function NewBoxModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (b: { code: string; email: string; phrase: string; address: string }) => void;
}) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const box = await api.post<{ code: string; email: string; phrase: string; address: string }>(
        "/platform/boxes",
        { email }
      );
      onDone(box);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Открыть доступ из интернета" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Banner tone="error">{error.message}</Banner>}
        <Field
          label="Email владельца мастерской"
          error={error?.field("email")}
          hint="На эту почту выдаётся доступ: по ней видно, чей это ключ, и на неё же можно будет выслать фразу заново. Адрес мастерской сервер придумает сам — случайный, чтобы его нельзя было угадать по почте"
        >
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoCapitalize="none"
            autoFocus
            invalid={!!error?.field("email")}
            placeholder="master@servis.ru"
          />
        </Field>
        <div className="flex flex-col gap-2 pt-2 sm:flex-row-reverse">
          <Button type="submit" disabled={busy || !email.includes("@")} className="sm:flex-1">
            {busy ? "Открываем…" : "Получить фразу"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} className="sm:flex-1">
            Отмена
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Единственный раз, когда доступ виден целиком.
 *
 * Отдаём одной фразой: в ней и адрес узла связи, и ключ, и код мастерской.
 * Передавать три строки по телефону — это три возможности ошибиться, а одна
 * копируется кнопкой и вставляется целиком.
 */
function PhraseModal({
  issued,
  onClose,
}: {
  issued: { code: string; email: string; phrase: string; address: string };
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      setCopied(null);
    }
  };

  const box = "mt-1.5 break-all rounded-field border border-line bg-surface-input px-3 py-2.5 font-mono text-[13px]";

  return (
    <Modal title="Доступ открыт" onClose={onClose}>
      <div className="space-y-4">
        <Banner tone="warning">
          Фраза показывается один раз: у нас хранится только отпечаток ключа. Передайте её мастерской —
          там её вставляют в «Настройки → Доступ из интернета» и нажимают «Подключить».
        </Banner>

        <p className="text-[13.5px] text-ink-muted">
          Доступ выдан на почту <span className="font-semibold text-ink">{issued.email}</span>.
        </p>

        <div>
          <span className="text-[13px] font-semibold text-ink-soft">Фраза подключения</span>
          <div className={box}>{issued.phrase}</div>
        </div>

        <div>
          <span className="text-[13px] font-semibold text-ink-soft">Адрес мастерской после подключения</span>
          <div className={box}>{issued.address}</div>
        </div>

        {copied && <p className="text-center text-[13px] text-state-done">Скопировано: {copied}</p>}

        <Button type="button" onClick={() => void copy(issued.phrase, "фраза")} className="w-full">
          Скопировать фразу
        </Button>
        <div className="grid gap-2 sm:grid-cols-2">
          <Button type="button" variant="secondary" onClick={() => void copy(issued.address, "адрес")}>
            Скопировать адрес
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            Готово
          </Button>
        </div>
      </div>
    </Modal>
  );
}
