import { useEffect, useRef, useState } from "react";
import { Panel } from "./Panel";
import { Banner, Button, Input, Select } from "./ui";
import { ApiError } from "../lib/api";
import { blanksApi, type Blank, type BlankTarget, type MarksCatalog } from "../lib/blanks";

/**
 * «Настройки → Бланки → Свои бланки из Excel» (03.11.2026).
 *
 *   1. в Excel рисуют бланк и ставят метки: {номер}, {клиент}, {работа}…
 *   2. загружают сюда — видно, какие метки узнали, а какие нет (опечатка?)
 *   3. в заказе: печать → вкладка с названием бланка → «Печать» или «Скачать .xlsx»
 */

const TARGET_LABEL: Record<BlankTarget, string> = { order: "для заказа", sale: "для продажи со склада" };

export function ExcelBlanks({ disabled }: { disabled: boolean }) {
  const [items, setItems] = useState<Blank[] | null>(null);
  const [catalog, setCatalog] = useState<{ order: MarksCatalog; sale: MarksCatalog } | null>(null);
  const [name, setName] = useState("");
  const [target, setTarget] = useState<BlankTarget>("order");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showMarks, setShowMarks] = useState<BlankTarget | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const replaceFor = useRef<string | null>(null);
  const replaceInput = useRef<HTMLInputElement>(null);

  const load = () =>
    blanksApi
      .list()
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  useEffect(() => {
    void load();
    blanksApi
      .marks()
      .then(setCatalog)
      .catch(() => setCatalog(null));
  }, []);

  async function act(key: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await load();
      if (done) setNotice(done);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Не получилось");
    } finally {
      setBusy(null);
    }
  }

  const upload = (f: File) =>
    act(
      "upload",
      async () => {
        const b = await blanksApi.upload(f, name.trim() || f.name.replace(/\.xlsx$/i, ""), target);
        setName("");
        setNotice(
          `«${b.name}» загружен: узнал меток — ${b.marks.known.length}` +
            (b.marks.unknown.length ? `, не узнал — ${b.marks.unknown.length} (ниже)` : "") +
            ". В заказе он появится вкладкой на странице печати."
        );
      }
    );

  const copy = (m: string) => {
    void navigator.clipboard?.writeText(m).catch(() => undefined);
    setCopied(m);
    setTimeout(() => setCopied(null), 1200);
  };

  const cat = showMarks && catalog ? catalog[showMarks] : null;

  return (
    <Panel id="print:Свои бланки из Excel" title="Свои бланки из Excel" summary={items?.length ? `Загружено: ${items.length}` : "Договор, талон, чек — свой вид"}>
      <div className="mt-4 space-y-4" data-excel-blanks>
        {error && <Banner tone="error">{error}</Banner>}
        {notice && <Banner>{notice}</Banner>}
        <ol className="space-y-1 text-[13px] leading-snug text-ink-muted">
          <li>
            1. Нарисуйте бланк в Excel как вам нужно и поставьте в ячейки метки в фигурных скобках: <code className="font-mono text-ink">{"{номер}"}</code>,{" "}
            <code className="font-mono text-ink">{"{клиент}"}</code>, <code className="font-mono text-ink">{"{итого прописью}"}</code>.
          </li>
          <li>
            2. Строка таблицы с метками <code className="font-mono text-ink">{"{работа}"}</code>, <code className="font-mono text-ink">{"{работа цена}"}</code> повторится для каждой работы
            заказа — со своими рамками и шрифтом.
          </li>
          <li>3. Загрузите файл сюда. В заказе он появится вкладкой на странице печати: «Печать» или «Скачать .xlsx».</li>
        </ol>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={!!busy} onClick={() => void act("ex1", () => blanksApi.example("order"))} data-excel-example="order">
            Образец для заказа
          </Button>
          <Button variant="secondary" disabled={!!busy} onClick={() => void act("ex2", () => blanksApi.example("sale"))}>
            Образец товарного чека
          </Button>
          <Button variant="ghost" onClick={() => setShowMarks(showMarks ? null : "order")} data-excel-marks-toggle>
            {showMarks ? "Скрыть метки" : "Все метки"}
          </Button>
        </div>

        {cat && (
          <div className="rounded-card border border-line p-3" data-excel-marks>
            <div className="mb-2 flex gap-1.5">
              {(["order", "sale"] as BlankTarget[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setShowMarks(t)}
                  className={"rounded-pill px-3 py-1 text-[12.5px] font-semibold " + (showMarks === t ? "bg-brand text-white" : "border border-line text-ink-muted")}
                >
                  {t === "order" ? "Заказ" : "Продажа"}
                </button>
              ))}
              <span className="ml-auto self-center text-[12px] text-ink-dim">щелчок — скопировать</span>
            </div>
            <div className="grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
              {cat.marks.map((m) => (
                <button key={m.key} type="button" onClick={() => copy(`{${m.key}}`)} className="flex min-w-0 items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-surface-raised">
                  <code className="shrink-0 font-mono text-[12.5px] text-ink">{copied === `{${m.key}}` ? "✓ скопировано" : `{${m.key}}`}</code>
                  <span className="truncate text-[12px] text-ink-dim">{m.hint}</span>
                </button>
              ))}
            </div>
            {cat.lists.map((l) => (
              <div key={l.key} className="mt-2.5">
                <p className="text-[12.5px] font-semibold text-ink-soft">Строка-список «{l.title}» — повторится для каждого:</p>
                <div className="mt-0.5 flex flex-wrap gap-1.5">
                  {[...l.fields.map((f) => f.key), cat.rowNo].map((k) => (
                    <button key={k} type="button" onClick={() => copy(`{${k}}`)} className="rounded-pill border border-line px-2 py-0.5 font-mono text-[12px] text-ink-muted hover:text-ink">
                      {copied === `{${k}}` ? "✓" : `{${k}}`}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {!disabled && (
          <div className="rounded-card border border-dashed border-line-strong p-3">
            <p className="mb-2 text-[13px] font-semibold text-ink-soft">Загрузить бланк</p>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_200px_auto]">
              <Input value={name} maxLength={60} placeholder="Название: Договор, Гарантийный талон" onChange={(e) => setName(e.target.value)} aria-label="Название бланка" />
              <Select value={target} onChange={(e) => setTarget(e.target.value as BlankTarget)} aria-label="Для чего">
                <option value="order">Для заказа</option>
                <option value="sale">Для продажи со склада</option>
              </Select>
              <input
                ref={file}
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className="hidden"
                data-excel-file
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void upload(f);
                }}
              />
              <Button disabled={!!busy} onClick={() => file.current?.click()} data-excel-upload>
                {busy === "upload" ? "Загружаем…" : "Выбрать .xlsx"}
              </Button>
            </div>
          </div>
        )}

        <input
          ref={replaceInput}
          type="file"
          accept=".xlsx"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            const id = replaceFor.current;
            if (f && id) void act("replace", () => blanksApi.replace(id, f), "Файл бланка заменён");
          }}
        />

        <div className="space-y-2">
          {items?.map((b) => (
            <div key={b.id} className="rounded-card border border-line p-3" data-excel-blank={b.name}>
              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-[14.5px] font-bold">{b.name}</p>
                  <p className="text-[12.5px] text-ink-dim">
                    {TARGET_LABEL[b.target]} · {b.fileName}
                  </p>
                  <p className="mt-1 text-[12.5px] text-state-done" data-excel-known>
                    ✓ Меток узнал: {b.marks.known.length}
                    {b.marks.lists.length ? ` · списки: ${b.marks.lists.join(", ")}` : ""}
                  </p>
                  {b.marks.unknown.length > 0 && (
                    <p className="mt-0.5 text-[12.5px] text-state-waiting" data-excel-unknown>
                      Не узнал:{" "}
                      {b.marks.unknown.map((u, i) => (
                        <span key={u.mark}>
                          {i > 0 && ", "}
                          <code className="font-mono">{`{${u.mark}}`}</code>
                          {u.suggest && <> — может, <code className="font-mono">{`{${u.suggest}}`}</code>?</>}
                        </span>
                      ))}
                      . Они останутся на бумаге как есть.
                    </p>
                  )}
                </div>
                {!disabled && (
                  <div className="flex flex-wrap gap-1.5">
                    <Button variant="ghost" className="min-h-[36px] px-2.5 text-[13px]" disabled={!!busy} onClick={() => void act("tpl", () => blanksApi.template(b.id))}>
                      Скачать шаблон
                    </Button>
                    <Button
                      variant="ghost"
                      className="min-h-[36px] px-2.5 text-[13px]"
                      disabled={!!busy}
                      onClick={() => {
                        replaceFor.current = b.id;
                        replaceInput.current?.click();
                      }}
                    >
                      Заменить файл
                    </Button>
                    <Button
                      variant="ghost"
                      className="min-h-[36px] px-2.5 text-[13px]"
                      disabled={!!busy}
                      onClick={() => {
                        const n = window.prompt("Название бланка", b.name);
                        if (n && n.trim() && n.trim() !== b.name) void act("rename", () => blanksApi.update(b.id, { name: n.trim() }));
                      }}
                    >
                      Переименовать
                    </Button>
                    <Button
                      variant="ghost"
                      className="min-h-[36px] px-2.5 text-[13px] text-state-off"
                      disabled={!!busy}
                      onClick={() => window.confirm(`Удалить бланк «${b.name}»?`) && void act("del", () => blanksApi.remove(b.id), "Бланк удалён")}
                      data-excel-remove
                    >
                      Удалить
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}
