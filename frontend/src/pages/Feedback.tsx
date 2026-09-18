import { useEffect, useState } from "react";
import { Banner, Button, Card, Field, PageHeader, SectionLabel, Spinner, Textarea } from "../components/ui";
import { api } from "../lib/api";

/**
 * Обратная связь мастерской.
 *
 * Одно поле и одна кнопка — намеренно. Всё, что можно было бы спросить
 * дополнительно (версия, браузер, что человек делал до этого), либо не нужно,
 * либо мы знаем это сами. Каждое лишнее поле здесь — повод не написать вовсе.
 *
 * Тип выбирается тремя кнопками, а не выпадающим списком: их всего три, и
 * видеть все сразу полезнее, чем открывать список ради выбора из трёх.
 */

type Kind = "REMARK" | "WISH" | "BUG";

interface Sent {
  id: string;
  kind: Kind;
  text: string;
  handledAt: string | null;
  createdAt: string;
}

/**
 * Цвета одни и те же здесь и у владельца платформы. Это не украшение: если
 * «баг» у отправителя красный, а у получателя синий, разговор о «красных»
 * становится невозможным.
 */
export const KINDS: { value: Kind; label: string; hint: string; dot: string; chip: string; edge: string }[] = [
  {
    value: "REMARK",
    label: "Замечание",
    hint: "Что-то работает не так, как ожидалось, или мешает в работе",
    dot: "bg-state-waiting",
    chip: "border-state-waiting/30 bg-state-waiting/10 text-state-waiting",
    edge: "border-l-state-waiting",
  },
  {
    value: "WISH",
    label: "Пожелание",
    hint: "Чего не хватает: новая возможность, удобство, отчёт",
    dot: "bg-state-done",
    chip: "border-state-done/30 bg-state-done/10 text-state-done",
    edge: "border-l-state-done",
  },
  {
    value: "BUG",
    label: "Баг",
    hint: "Ошибка: что-то сломалось, пропало или показывает неправду",
    dot: "bg-state-off",
    chip: "border-state-off/30 bg-state-off/10 text-state-off",
    edge: "border-l-state-off",
  },
];

export const kindOf = (k: Kind) => KINDS.find((x) => x.value === k) ?? KINDS[0];

const when = (iso: string) =>
  new Date(iso).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });

export default function Feedback() {
  const [kind, setKind] = useState<Kind>("REMARK");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [history, setHistory] = useState<Sent[] | null>(null);

  const load = () =>
    api
      .get<Sent[]>("/feedback")
      .then(setHistory)
      .catch(() => setHistory([]));

  useEffect(() => {
    void load();
  }, []);

  const send = async () => {
    setError("");
    if (text.trim().length < 10) {
      setError("Опишите подробнее — хотя бы пару предложений");
      return;
    }
    setSending(true);
    try {
      await api.post("/feedback", { kind, text: text.trim() });
      setText("");
      setSent(true);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось отправить");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Настройки"
        title="Обратная связь"
        subtitle="Написать разработчику: что мешает, чего не хватает, что сломалось."
      />

      <Card className="space-y-4 p-4">
        <div>
          <SectionLabel>О чём речь</SectionLabel>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            {KINDS.map((k) => (
              <button
                key={k.value}
                type="button"
                onClick={() => setKind(k.value)}
                className={
                  "rounded-card border p-3 text-left transition-colors duration-150 " +
                  (kind === k.value
                    ? "border-brand bg-surface-raised"
                    : "border-line bg-surface hover:border-line-strong")
                }
              >
                <span className="flex items-center gap-2 text-[15px] font-bold">
                  <span className={"h-2.5 w-2.5 rounded-full " + k.dot} />
                  {k.label}
                </span>
                <span className="mt-1 block text-[12.5px] leading-relaxed text-ink-muted">{k.hint}</span>
              </button>
            ))}
          </div>
        </div>

        <Field label="Сообщение" error={error || undefined}>
          <Textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSent(false);
            }}
            maxLength={4000}
            invalid={!!error}
            placeholder="Например: при печати квитанции не помещается длинное название модели — переносится на вторую страницу."
            className="min-h-[160px]"
          />
        </Field>

        {sent && <Banner tone="info">Отправлено. Ответа в программе не будет — с вами свяжутся, если понадобятся подробности.</Banner>}

        <div className="flex items-center justify-between gap-3">
          <span className="text-[12.5px] text-ink-dim">{text.trim().length} из 4000</span>
          <Button onClick={send} disabled={sending}>
            {sending ? "Отправляю…" : "Отправить"}
          </Button>
        </div>
      </Card>

      {history === null ? (
        <Spinner label="Загружаю отправленное" />
      ) : history.length > 0 ? (
        <div className="space-y-2">
          <SectionLabel>Что уже отправляли</SectionLabel>
          {history.map((item) => {
            const k = kindOf(item.kind);
            return (
              <Card key={item.id} className="p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={"rounded-field border px-2 py-0.5 text-[12px] font-semibold " + k.chip}>
                    {k.label}
                  </span>
                  <span className="text-[12.5px] text-ink-dim">{when(item.createdAt)}</span>
                  {item.handledAt && (
                    <span className="text-[12.5px] font-semibold text-state-done">разобрано</span>
                  )}
                </div>
                <p className="mt-2 whitespace-pre-wrap text-[14px] leading-relaxed text-ink-muted">{item.text}</p>
              </Card>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
