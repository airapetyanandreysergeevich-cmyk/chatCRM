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
 * уезжает. Здесь выдаётся только право подключиться к нашему серверу: код в
 * адресе и ключ. Выключатель рядом — это и есть рубильник услуги: выключили,
 * и адрес перестал работать, а программа в мастерской продолжает работать по
 * локальной сети как ни в чём не бывало.
 *
 * Ключ показывается один раз, при выдаче: у нас хранится только его
 * отпечаток. Потерялся — перевыпускаем, старый сразу перестаёт действовать.
 */

interface Box {
  id: string;
  code: string;
  name: string;
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
  const [issued, setIssued] = useState<{ code: string; key: string } | null>(null);
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
    const { key } = await api.post<{ key: string }>(`/platform/boxes/${box.id}/key`, {});
    setConfirmKey(null);
    setIssued({ code: box.code, key });
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
          заходить и снаружи, выдайте ей ключ — он вводится в программе, в разделе «Доступ из интернета».
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
                  <span className={b.isActive ? "truncate" : "truncate text-ink-muted line-through"}>{b.name}</span>
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
                    Новый ключ
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
        <Modal title={`Новый ключ для «${confirmKey.name}»`} onClose={() => setConfirmKey(null)}>
          <div className="space-y-4">
            <Banner tone="warning">
              Старый ключ перестанет работать сразу, и мастерская отключится. Новый ключ придётся ввести
              в программе — до этого доступ из интернета работать не будет.
            </Banner>
            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              <Button variant="danger" onClick={() => void reissue(confirmKey)} className="sm:flex-1">
                Выпустить новый
              </Button>
              <Button variant="secondary" onClick={() => setConfirmKey(null)} className="sm:flex-1">
                Отмена
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {issued && <KeyModal code={issued.code} value={issued.key} onClose={() => setIssued(null)} />}
    </div>
  );
}

function NewBoxModal({ onClose, onDone }: { onClose: () => void; onDone: (b: { code: string; key: string }) => void }) {
  const [form, setForm] = useState({ name: "", code: "", note: "" });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const box = await api.post<{ code: string; key: string }>("/platform/boxes", form);
      onDone(box);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Доступ из интернета" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Banner tone="error">{error.message}</Banner>}
        <Field label="Мастерская" error={error?.field("name")} hint="Как называть её в этом списке">
          <Input value={form.name} onChange={set("name")} invalid={!!error?.field("name")} />
        </Field>
        <Field
          label="Код в адресе"
          error={error?.field("code")}
          hint="Латиницей: он станет частью адреса. Пусто — сделаем из названия."
        >
          <Input value={form.code} onChange={set("code")} autoCapitalize="none" placeholder="servis-na-lenina" />
        </Field>
        <Field label="Заметка" error={error?.field("note")} hint="Видно только вам: тариф, телефон, что угодно">
          <Input value={form.note} onChange={set("note")} />
        </Field>
        <div className="flex flex-col gap-2 pt-2 sm:flex-row-reverse">
          <Button type="submit" disabled={busy} className="sm:flex-1">
            {busy ? "Открываем…" : "Открыть доступ"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} className="sm:flex-1">
            Отмена
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Единственный раз, когда ключ виден целиком. Дальше — только хвост. */
function KeyModal({ code, value, onClose }: { code: string; value: string; onClose: () => void }) {
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
    <Modal title="Ключ выдан" onClose={onClose}>
      <div className="space-y-4">
        <Banner tone="warning">
          Ключ показывается один раз: у нас хранится только его отпечаток. Скопируйте и передайте
          мастерской — если потеряется, выпустите новый.
        </Banner>

        <div>
          <span className="text-[13px] font-semibold text-ink-soft">Адрес мастерской</span>
          <div className={box}>{addressOf(code)}</div>
        </div>

        <div>
          <span className="text-[13px] font-semibold text-ink-soft">Ключ доступа</span>
          <div className={box}>{value}</div>
        </div>

        {copied && <p className="text-center text-[13px] text-state-done">Скопировано: {copied}</p>}

        <div className="grid gap-2 sm:grid-cols-2">
          <Button type="button" variant="secondary" onClick={() => void copy(value, "ключ")}>
            Скопировать ключ
          </Button>
          <Button type="button" variant="secondary" onClick={() => void copy(addressOf(code), "адрес")}>
            Скопировать адрес
          </Button>
        </div>
        <Button type="button" onClick={onClose} className="w-full">
          Готово
        </Button>
      </div>
    </Modal>
  );
}
