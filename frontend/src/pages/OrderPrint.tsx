import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDate, formatDateTime } from "../lib/format";
import { ordersApi, type Order } from "../lib/orders";
import { useTheme } from "../lib/useTheme";

/**
 * Печатные бланки: квитанция о приёме и акт выполненных работ.
 *
 * Страница живёт вне основного интерфейса и всегда чёрным по белому,
 * независимо от выбранной темы: это бумага, а не экран. Тёмная квитанция
 * съедает картридж и в мастерской выглядит поломкой.
 *
 * PDF не собираем: браузер печатает в файл сам, и любая мастерская умеет
 * это делать, не разбираясь в наших настройках.
 */

type Doc = "intake" | "act";

const money = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${v.toLocaleString("ru-RU")} ₽`;

const deviceLine = (o: Order) =>
  [o.device?.kind, o.device?.brand, o.device?.model].filter(Boolean).join(" ") || "Техника не указана";

/** Пустая строка для подписи от руки. */
function SignLine({ label }: { label: string }) {
  return (
    <div className="mt-10">
      <div className="h-[1px] w-full bg-black/60" />
      <p className="mt-1 text-[10.5px] text-black/60">{label}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-4 break-inside-avoid">
      <h2 className="border-b border-black/30 pb-1 text-[11px] font-bold uppercase tracking-[0.1em]">
        {title}
      </h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

function Pairs({ items }: { items: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k} className="flex gap-2 text-[12px]">
          <dt className="shrink-0 text-black/55">{k}:</dt>
          <dd className="min-w-0 font-medium">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Отмеченные пункты чек-листа строкой: в бланке галочки занимают полстраницы. */
function Checked({ items, empty }: { items: Array<{ label: string; checked: boolean }>; empty: string }) {
  const on = items.filter((i) => i.checked).map((i) => i.label);
  return <p className="text-[12px]">{on.length ? on.join(", ") : <span className="text-black/50">{empty}</span>}</p>;
}

function LineTable({
  rows,
  showMoney,
}: {
  rows: Array<{ name: string; qty: number; price: number }>;
  showMoney: boolean;
}) {
  if (rows.length === 0) return <p className="text-[12px] text-black/50">Нет</p>;
  return (
    <table className="w-full border-collapse text-[12px]">
      <thead>
        <tr className="border-b border-black/30 text-left text-black/55">
          <th className="py-1 font-medium">Наименование</th>
          <th className="w-[60px] py-1 text-right font-medium">Кол-во</th>
          {showMoney && <th className="w-[90px] py-1 text-right font-medium">Цена</th>}
          {showMoney && <th className="w-[100px] py-1 text-right font-medium">Сумма</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-black/10">
            <td className="py-1 pr-2">{r.name}</td>
            <td className="py-1 text-right tabular-nums">{r.qty}</td>
            {showMoney && <td className="py-1 text-right tabular-nums">{money(r.price)}</td>}
            {showMoney && <td className="py-1 text-right tabular-nums">{money(r.qty * r.price)}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function OrderPrint() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { me } = useAuth();
  const { branding } = useTheme();

  const doc: Doc = params.get("doc") === "act" ? "act" : "intake";
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ordersApi
      .get(id)
      .then(setOrder)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить заказ"));
  }, [id]);

  const workshop =
    me?.kind === "tenant"
      ? (me.tenant?.name ?? "Мастерская")
      : me?.kind === "platform"
        ? (me.impersonating?.name ?? "Мастерская")
        : "Мастерская";

  if (error) return <div className="p-8 text-[14px]">{error}</div>;
  if (!order) return <div className="p-8 text-[14px]">Готовим бланк…</div>;

  // Деньги печатаем только тому, кому они видны в системе. Мастер, у которого
  // в карточке нет сумм, не должен получить их через кнопку печати.
  const showMoney = order.total !== undefined;
  const works = order.works.map((w) => ({ name: w.name, qty: w.qty, price: w.price }));
  const parts = order.parts.map((p) => ({ name: p.name, qty: p.qty, price: p.price }));
  const title = doc === "intake" ? "Квитанция о приёме техники" : "Акт выполненных работ";

  return (
    <div className="min-h-screen bg-[#6B7280] print:bg-white">
      {/* Панель не печатается — на бумаге ей не место. */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 bg-black/85 px-5 py-3 text-white print:hidden">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => navigate(`/orders/${id}`)}
            className="rounded-[10px] border border-white/25 px-4 py-2 text-[13.5px] font-semibold hover:bg-white/10"
          >
            ‹ К заказу
          </button>
          <button
            type="button"
            onClick={() => navigate(`/orders/${id}/print?doc=intake`)}
            className={
              "rounded-[10px] px-4 py-2 text-[13.5px] font-semibold " +
              (doc === "intake" ? "bg-white text-black" : "border border-white/25 hover:bg-white/10")
            }
          >
            Квитанция
          </button>
          <button
            type="button"
            onClick={() => navigate(`/orders/${id}/print?doc=act`)}
            className={
              "rounded-[10px] px-4 py-2 text-[13.5px] font-semibold " +
              (doc === "act" ? "bg-white text-black" : "border border-white/25 hover:bg-white/10")
            }
          >
            Акт работ
          </button>
        </div>
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded-[10px] bg-white px-5 py-2 text-[13.5px] font-bold text-black hover:bg-white/90"
        >
          Печать
        </button>
      </div>

      {/* Лист A4. Ширина в миллиметрах, чтобы на экране было видно, как ляжет. */}
      <div className="mx-auto my-6 w-[210mm] max-w-full bg-white p-[14mm] text-black shadow-lg print:my-0 print:w-auto print:p-0 print:shadow-none">
        <header className="flex items-start justify-between gap-6 border-b-2 border-black pb-3">
          <div className="flex min-w-0 items-center gap-3">
            {branding.logo && (
              <img src={branding.logo} alt="" className="max-h-[52px] max-w-[150px] object-contain" />
            )}
            <div className="min-w-0">
              <p className="text-[17px] font-extrabold leading-tight">{workshop}</p>
              {branding.printNote && (
                <p className="mt-0.5 text-[11px] text-black/60">{branding.printNote}</p>
              )}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-[13px] font-bold">{title}</p>
            <p className="mt-0.5 font-mono text-[15px] font-bold">{order.number}</p>
            <p className="mt-0.5 text-[11px] text-black/60">
              от {formatDate(doc === "act" ? (order.completedAt ?? order.acceptedAt) : order.acceptedAt)}
            </p>
          </div>
        </header>

        <Section title="Клиент">
          <Pairs
            items={[
              ["Клиент", order.customer.name ?? "—"],
              ["Телефон", order.customer.phone ?? "—"],
            ]}
          />
        </Section>

        <Section title="Техника">
          <Pairs
            items={[
              ["Устройство", deviceLine(order)],
              ["Серийный номер", order.device?.serial || "—"],
              ["Принята", formatDateTime(order.acceptedAt)],
              [
                doc === "intake" ? "Срок готовности" : "Ремонт завершён",
                doc === "intake" ? formatDate(order.dueAt) : formatDate(order.completedAt),
              ],
            ]}
          />
        </Section>

        {doc === "intake" ? (
          <>
            <Section title="Комплектность">
              <Checked items={order.completeness} empty="Принято без дополнительных принадлежностей" />
            </Section>

            <Section title="Внешнее состояние">
              <Checked items={order.appearance} empty="Видимых дефектов не зафиксировано" />
              {order.appearanceNote && <p className="mt-1 text-[12px]">{order.appearanceNote}</p>}
              {(order.hasOpenTraces || order.hasWaterDamage) && (
                <p className="mt-1 text-[12px] font-semibold">
                  {[order.hasOpenTraces && "Следы вскрытия", order.hasWaterDamage && "Следы влаги"]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
            </Section>

            <Section title="Неисправность со слов клиента">
              <p className="text-[12px] leading-relaxed">{order.complaint || "—"}</p>
            </Section>

            {showMoney && (
              <Section title="Предварительно">
                <Pairs
                  items={[
                    ["Ориентировочная стоимость", money(order.estimatedCost)],
                    ["Согласовано клиентом до", money(order.approvedLimit)],
                    ["Предоплата", money(order.prepayment)],
                  ]}
                />
              </Section>
            )}

            <Section title="Условия">
              <p className="text-[10.5px] leading-relaxed text-black/70">
                Клиент подтверждает, что неисправность записана с его слов, комплектность и внешнее
                состояние зафиксированы верно. Мастерская не отвечает за сохранность данных на
                носителях — их резервную копию клиент делает самостоятельно. Срок готовности
                предварительный и может измениться после диагностики; об изменении стоимости выше
                согласованной суммы мастерская сообщает до начала работ. Невостребованная техника
                хранится не более шести месяцев с даты уведомления о готовности.
              </p>
            </Section>

            <div className="grid grid-cols-2 gap-10">
              <SignLine label="Технику сдал, с условиями согласен (подпись клиента)" />
              <SignLine label={`Технику принял${order.acceptedBy ? `: ${order.acceptedBy.fullName}` : ""}`} />
            </div>
          </>
        ) : (
          <>
            <Section title="Заявленная неисправность">
              <p className="text-[12px] leading-relaxed">{order.complaint || "—"}</p>
            </Section>

            <Section title="Что оказалось не так">
              <p className="text-[12px] leading-relaxed">{order.diagnosis || "—"}</p>
              {order.masterComment && (
                <p className="mt-1 text-[12px] leading-relaxed">{order.masterComment}</p>
              )}
            </Section>

            <Section title="Выполненные работы">
              <LineTable rows={works} showMoney={showMoney} />
            </Section>

            <Section title="Запчасти и материалы">
              <LineTable rows={parts} showMoney={showMoney} />
            </Section>

            {showMoney && (
              <section className="mt-4 flex justify-end break-inside-avoid">
                <table className="text-[12px]">
                  <tbody>
                    <tr>
                      <td className="py-0.5 pr-6 text-black/55">Работы</td>
                      <td className="py-0.5 text-right tabular-nums">{money(order.totalWork)}</td>
                    </tr>
                    {!!order.workDiscount && (
                      <tr>
                        <td className="py-0.5 pr-6 text-black/55">
                          Скидка на работы, {order.workDiscountPercent}%
                        </td>
                        <td className="py-0.5 text-right tabular-nums">−{money(order.workDiscount)}</td>
                      </tr>
                    )}
                    <tr>
                      <td className="py-0.5 pr-6 text-black/55">Запчасти</td>
                      <td className="py-0.5 text-right tabular-nums">{money(order.totalParts)}</td>
                    </tr>
                    {!!order.discount && (
                      <tr>
                        <td className="py-0.5 pr-6 text-black/55">Скидка при выдаче</td>
                        <td className="py-0.5 text-right tabular-nums">−{money(order.discount)}</td>
                      </tr>
                    )}
                    {!!order.prepayment && (
                      <tr>
                        <td className="py-0.5 pr-6 text-black/55">Предоплата</td>
                        <td className="py-0.5 text-right tabular-nums">−{money(order.prepayment)}</td>
                      </tr>
                    )}
                    <tr className="border-t border-black/40">
                      <td className="py-1 pr-6 font-bold">К оплате</td>
                      <td className="py-1 text-right text-[15px] font-extrabold tabular-nums">
                        {money(Math.max(0, (order.total ?? 0) - (order.prepayment ?? 0)))}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </section>
            )}

            <Section title="Гарантия и рекомендации">
              <Pairs
                items={[
                  [
                    "Гарантия на работы",
                    order.warrantyDays ? `${order.warrantyDays} дн. — до ${formatDate(order.warrantyUntil)}` : "—",
                  ],
                  ["Мастер", order.assignedMaster?.fullName ?? "—"],
                ]}
              />
              {order.recommendation && (
                <p className="mt-2 text-[12px] leading-relaxed">{order.recommendation}</p>
              )}
              <p className="mt-2 text-[10.5px] leading-relaxed text-black/70">
                Гарантия распространяется на выполненные работы и установленные запчасти. Она не
                действует при механических повреждениях, попадании влаги и самостоятельном вскрытии
                после ремонта.
              </p>
            </Section>

            <div className="grid grid-cols-2 gap-10">
              <SignLine label="Работы принял, претензий не имею (подпись клиента)" />
              <SignLine label={`Работы сдал${order.assignedMaster ? `: ${order.assignedMaster.fullName}` : ""}`} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
