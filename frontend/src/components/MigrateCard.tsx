import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { migrateApi, type MigrateResult, type MigrateSummary } from "../lib/migrateApi";
import { IconUpload } from "./icons";
import { Banner, Button, Card, Checkbox, SectionLabel } from "./ui";

const n = (v: number) => v.toLocaleString("ru-RU");

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-field border border-line bg-surface-raised px-3 py-2.5">
      <div className="text-[12px] text-ink-dim">{label}</div>
      <div className="text-[18px] font-bold tabular-nums">{value}</div>
      {hint && <div className="text-[11.5px] text-ink-dim">{hint}</div>}
    </div>
  );
}

/**
 * Перенос из другой программы: выбрать файл базы — посмотреть, что и куда
 * переедет, — перенести. Одна карточка на весь путь, потому что человек
 * делает это один раз в жизни мастерской и инструкцию читать не станет.
 */
export function MigrateCard() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const isOwner = me?.kind === "tenant" && me.user.isOwner;
  const [state, setState] = useState<{ canMigrate: boolean; sources: string[] } | null>(null);
  const [busy, setBusy] = useState<"parse" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<{ token: string | null; fileName: string; summary: MigrateSummary } | null>(null);
  const [continueNumbering, setContinueNumbering] = useState(true);
  const [result, setResult] = useState<MigrateResult | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOwner) migrateApi.state().then(setState).catch(() => {});
  }, [isOwner]);

  if (!isOwner || !state) return null;

  async function pick(file: File) {
    setBusy("parse");
    setError(null);
    setParsed(null);
    try {
      setParsed(await migrateApi.parse(file));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось прочитать базу");
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (!parsed?.token) return;
    setBusy("apply");
    setError(null);
    try {
      setResult(await migrateApi.apply(parsed.token, continueNumbering));
      setParsed(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Перенос не удался — база осталась как была");
    } finally {
      setBusy(null);
    }
  }

  const s = parsed?.summary;
  const issues = s ? s.previews.reduce((k, p) => k + p.issuesTotal, 0) : 0;
  const titleOf = { customers: "Клиенты", stock: "Склад", orders: "Заказы" } as const;

  return (
    <Card>
      <SectionLabel>Перенос из другой программы</SectionLabel>

      {result ? (
        <div className="mt-3 space-y-3">
          <Banner>
            Перенесено за {result.seconds} с: заказов {n(result.orders)}, клиентов {n(result.customers)}
            {result.stock > 0 && `, позиций склада ${n(result.stock)}`}, оплат {n(result.payments)} на{" "}
            {n(result.paymentsSum)} ₽, записей истории {n(result.history)}.
            {result.nextNumber && ` Следующий заказ получит номер ${result.nextNumber}.`}
          </Banner>
          {result.staff.length > 0 && (
            <p className="text-[13.5px] leading-relaxed text-ink-muted">
              Мастера заведены <b className="text-ink">выключенными</b>:{" "}
              {result.staff.map((x) => x.name).join(", ")}. Кто из них работает — включите в разделе
              «Сотрудники» и задайте пароль.
              {result.staffSkipped.length > 0 &&
                ` Не хватило мест по тарифу для: ${result.staffSkipped.join(", ")} — их заказы остались без мастера.`}
            </p>
          )}
          {result.failedTotal > 0 && (
            <div>
              <p className="text-[13.5px] font-semibold text-state-off">Не перенеслось строк: {result.failedTotal}</p>
              <div className="mt-2 max-h-[220px] overflow-auto rounded-card border border-line">
                <table className="w-full text-[13px]">
                  <tbody className="divide-y divide-line">
                    {result.failed.map((f, i) => (
                      <tr key={i}>
                        <td className="w-[110px] px-3 py-1.5 text-ink-dim">{f.table === "orders" ? "заказ" : f.table === "customers" ? "клиент" : "склад"}, стр. {f.row}</td>
                        <td className="px-3 py-1.5 text-ink-soft">{f.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          <Button onClick={() => navigate("/orders")}>
            Открыть заказы
          </Button>
        </div>
      ) : !state.canMigrate ? (
        <p className="mt-2 text-[13.5px] leading-relaxed text-ink-muted">
          Перенос делается в пустую базу, а в этой уже есть заказы, клиенты или склад. Если это тестовые
          данные — уберите их кнопкой в полосе вверху, и перенос станет доступен.
        </p>
      ) : !s ? (
        <>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-muted">
            Выберите файл базы старой программы. Сначала покажем, что и куда переедет, и только после
            подтверждения перенесём — клиентов, заказы с суммами и историей, склад и мастеров. Умеем:{" "}
            {state.sources.join(", ")}. Другая программа — пришлите нам её базу, добавим.
          </p>
          <input
            ref={input}
            type="file"
            accept=".sqlite,.sqlite3,.db,.db3"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void pick(f);
              e.target.value = "";
            }}
          />
          {error && <div className="mt-3"><Banner tone="error">{error}</Banner></div>}
          <div className="mt-4">
            <Button variant="secondary" icon={<IconUpload />} disabled={busy !== null} onClick={() => input.current?.click()}>
              {busy === "parse" ? "Читаем базу…" : "Выбрать файл базы"}
            </Button>
          </div>
        </>
      ) : (
        <div className="mt-3 space-y-4">
          <p className="text-[14px]">
            <b>{parsed.fileName}</b> — узнали: {s.source}.
          </p>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Tile label="Клиенты" value={n(s.customers)} />
            <Tile label="Заказы" value={n(s.orders)} hint={s.statuses.filter((x) => x.name !== "Выдан").reduce((k, x) => k + x.count, 0) + " в работе"} />
            <Tile label="Склад" value={n(s.stock)} />
            <Tile label="Мастера" value={n(s.staff.length)} />
            <Tile label="Оплаты" value={`${n(s.paymentsSum)} ₽`} hint={`${n(s.payments)} платежей`} />
            <Tile label="История" value={n(s.history)} hint="смен статуса" />
          </div>

          <ul className="space-y-1.5 text-[13px] leading-relaxed text-ink-muted">
            <li>
              • Выданные заказы считаются оплаченными: деньги лягут в отдельную выключенную кассу «Старая
              программа». Обычная касса не изменится, долгов из ниоткуда не появится.
            </li>
            {s.staff.length > 0 && (
              <li>
                • Мастера ({s.staff.map((x) => `${x.name} — ${n(x.orders)}`).join(", ")}) заведутся
                выключенными: включите тех, кто работает, и задайте им пароли в «Сотрудниках».
              </li>
            )}
            {s.passcodes > 0 && <li>• Пароли устройств ({n(s.passcodes)}) — в своё поле заказа, а не в комментарий.</li>}
            {s.notes.map((t, i) => (
              <li key={i}>• {t}</li>
            ))}
          </ul>

          {issues > 0 && (
            <div>
              <p className="text-[13.5px] font-semibold text-state-off">Строки с замечаниями — не перенесутся: {issues}</p>
              <div className="mt-2 max-h-[200px] overflow-auto rounded-card border border-line">
                <table className="w-full text-[13px]">
                  <tbody className="divide-y divide-line">
                    {s.previews.flatMap((p) =>
                      p.issues.map((x, i) => (
                        <tr key={p.key + i}>
                          <td className="w-[120px] px-3 py-1.5 text-ink-dim">{titleOf[p.key]}, стр. {x.row}</td>
                          <td className="px-3 py-1.5 text-ink-soft">{x.message}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {s.lastNumber !== null && (
            <Checkbox
              checked={continueNumbering}
              onChange={setContinueNumbering}
              label={`Продолжить нумерацию заказов: следующий новый заказ — ${s.lastNumber + 1}`}
            />
          )}

          {!parsed.token && (
            <Banner tone="warning">База уже не пустая — перенести в неё нельзя. Посмотреть, что переедет, можно.</Banner>
          )}
          {error && <Banner tone="error">{error}</Banner>}
          {busy === "apply" && (
            <Banner>
              Переносим… На несколько тысяч заказов уходит около минуты. Не закрывайте страницу.
            </Banner>
          )}

          <div className="flex flex-wrap gap-2">
            <Button disabled={!parsed.token || busy !== null} onClick={() => void apply()}>
              {busy === "apply" ? "Переносим…" : `Перенести ${n(s.orders)} заказов`}
            </Button>
            <Button variant="secondary" disabled={busy !== null} onClick={() => setParsed(null)}>
              Отмена
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
