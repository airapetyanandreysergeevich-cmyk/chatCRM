import { useEffect, useState } from "react";
import { Button, Card, EmptyState, PageHeader, SectionLabel, Spinner } from "../../components/ui";
import { IconBell } from "../../components/icons";
import { api } from "../../lib/api";
import { KINDS, kindOf } from "../Feedback";

/**
 * Обращения мастерских.
 *
 * Список, а не почтовый ящик: здесь ничего не пишут в ответ. Задача одна —
 * увидеть, что пришло, и не потерять то, до чего ещё не дошли руки. Поэтому
 * единственное действие — «разобрано»: без него список через месяц
 * превращается в ленту, которую перестают открывать.
 *
 * Цвет несёт смысл, а не настроение, и совпадает с тем, что видел
 * отправитель: жёлтое — замечание, зелёное — пожелание, красное — баг.
 * Разговор о «красных» должен быть возможен без уточнений.
 */

type Kind = "REMARK" | "WISH" | "BUG";

interface Item {
  id: string;
  kind: Kind;
  text: string;
  handledAt: string | null;
  createdAt: string;
  tenant: { id: string; name: string; slug: string } | null;
  author: { fullName: string; email: string } | null;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });

type Filter = "new" | "all" | "handled";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "new", label: "Новые" },
  { value: "all", label: "Все" },
  { value: "handled", label: "Разобранные" },
];

export default function PlatformFeedback() {
  const [items, setItems] = useState<Item[] | null>(null);
  const [status, setStatus] = useState<Filter>("new");
  const [kind, setKind] = useState<Kind | "ALL">("ALL");
  const [busy, setBusy] = useState<string | null>(null);

  const load = (s: Filter, k: Kind | "ALL") => {
    setItems(null);
    api
      .get<Item[]>(`/platform/feedback?status=${s}&kind=${k}`)
      .then(setItems)
      .catch(() => setItems([]));
  };

  useEffect(() => {
    load(status, kind);
  }, [status, kind]);

  const mark = async (item: Item) => {
    setBusy(item.id);
    try {
      await api.patch(`/platform/feedback/${item.id}`, { handled: !item.handledAt });
      load(status, kind);
    } finally {
      setBusy(null);
    }
  };

  const tab = (on: boolean) =>
    "rounded-field border px-3 py-1.5 text-[13px] font-semibold transition-colors duration-150 " +
    (on ? "border-brand bg-surface-raised text-ink" : "border-line text-ink-muted hover:border-line-strong");

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Платформа"
        title="Замечания"
        subtitle="Что пишут владельцы мастерских из своих настроек."
      />

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button key={f.value} type="button" className={tab(status === f.value)} onClick={() => setStatus(f.value)}>
            {f.label}
          </button>
        ))}
        <span className="mx-1 w-px self-stretch bg-line" />
        <button type="button" className={tab(kind === "ALL")} onClick={() => setKind("ALL")}>
          Любые
        </button>
        {KINDS.map((k) => (
          <button key={k.value} type="button" className={tab(kind === k.value)} onClick={() => setKind(k.value)}>
            <span className={"mr-1.5 inline-block h-2 w-2 rounded-full align-middle " + k.dot} />
            {k.label}
          </button>
        ))}
      </div>

      {items === null ? (
        <Spinner label="Загружаю обращения" />
      ) : items.length === 0 ? (
        <EmptyState icon={<IconBell />} title="Пусто">
          {status === "new"
            ? "Новых обращений нет. Разобранные видны на соседней вкладке."
            : "Обращений пока не было."}
        </EmptyState>
      ) : (
        <div className="space-y-2">
          {items.map((item) => {
            const k = kindOf(item.kind);
            return (
              <Card
                key={item.id}
                // Цветная полоса слева, а не заливка всей карточки: тип видно
                // с расстояния, а читать текст на цветном фоне тяжело.
                className={`border-l-[3px] p-4 ${k.edge}${item.handledAt ? " opacity-60" : ""}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className={"rounded-field border px-2 py-0.5 text-[12px] font-semibold " + k.chip}>
                    {k.label}
                  </span>
                  <span className="text-[14px] font-bold">{item.tenant?.name ?? "мастерская удалена"}</span>
                  {item.author && <span className="text-[12.5px] text-ink-muted">{item.author.fullName}</span>}
                  <span className="text-[12.5px] text-ink-dim">{when(item.createdAt)}</span>
                </div>

                <p className="mt-2.5 whitespace-pre-wrap text-[14.5px] leading-relaxed">{item.text}</p>

                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className="text-[12.5px] text-ink-dim">
                    {item.handledAt ? `разобрано ${when(item.handledAt)}` : item.author?.email}
                  </span>
                  <Button
                    variant={item.handledAt ? "ghost" : "secondary"}
                    disabled={busy === item.id}
                    onClick={() => mark(item)}
                  >
                    {item.handledAt ? "Вернуть в новые" : "Разобрано"}
                  </Button>
                </div>
              </Card>
            );
          })}
          <SectionLabel>{items.length} обращений</SectionLabel>
        </div>
      )}
    </div>
  );
}
