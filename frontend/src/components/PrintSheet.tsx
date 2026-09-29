import { formatDate, formatDateTime } from "../lib/format";
import type { Order } from "../lib/orders";
import type { DocTexts, PrintForms } from "../lib/printForms";

/**
 * Лист бланка — квитанция о приёме или акт выполненных работ.
 *
 * Вынесен из страницы печати, чтобы тот же самый лист показывать в
 * «Настройки → Бланки» при правке текстов: предпросмотр, нарисованный
 * отдельно, в первый же день разошёлся бы с тем, что выходит из принтера.
 *
 * Всегда чёрным по белому, независимо от темы: это бумага, а не экран.
 */

export type Doc = "intake" | "act";

const money = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${v.toLocaleString("ru-RU")} ₽`;

const deviceLine = (o: Order) =>
  [o.device?.kind, o.device?.brand, o.device?.model].filter(Boolean).join(" ") || "Техника не указана";

/** Пустая строка для подписи от руки. «М.П.» — место для печати, если мастерская её ставит. */
function SignLine({ label, stamp = false }: { label: string; stamp?: boolean }) {
  return (
    <div className="mt-10">
      <div className="h-[1px] w-full bg-black/60" />
      <p className="mt-1 text-[10.5px] text-black/60">{label}</p>
      {stamp && <p className="mt-3 text-[11px] font-semibold text-black/70">М.П.</p>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-4 break-inside-avoid first:mt-0">
      <h2 className="border-b border-black/30 pb-1 text-[11px] font-bold uppercase tracking-[0.1em]">
        {title}
      </h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

/**
 * Пары «название: значение» — друг под другом: лист теперь в две колонки,
 * и в узкой колонке пары в два ряда разрывали бы строки на середине.
 */
function Pairs({ items }: { items: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="grid gap-y-1">
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
/**
 * Перечисление строкой. Пункты из strong выделяются жирным прямо в строке:
 * «следы вскрытия» и «следы влаги» решают гарантию, и на бумаге их должно
 * быть видно с первого взгляда — как было, когда они стояли отдельной строкой.
 */
function Checked({ items, empty, strong = [] }: { items: string[]; empty: string; strong?: string[] }) {
  if (!items.length) return <p className="text-[12px] text-black/50">{empty}</p>;
  const bold = new Set(strong.map((s) => s.toLowerCase()));
  return (
    <p className="text-[12px]">
      {items.map((item, i) => (
        <span key={item}>
          {i > 0 && ", "}
          {bold.has(item.toLowerCase()) ? <strong>{item}</strong> : item}
        </span>
      ))}
    </p>
  );
}

/**
 * Условия — во всю ширину листа, в рамке, с размером и интервалом из
 * «Бланков». Это то, под чем клиент расписывается, и читаться оно должно не
 * хуже остального листа. Подписи идут сразу под рамкой.
 */
function Terms({ title, texts }: { title: string; texts: DocTexts }) {
  return (
    <section className="mt-5 break-inside-avoid rounded-[3px] border border-black/30 px-[4mm] py-[3mm]">
      <h2 className="text-[10.5px] font-bold uppercase tracking-[0.1em] text-black/70">{title}</h2>
      <p
        className="mt-1.5 whitespace-pre-line text-black/85"
        style={{ fontSize: `${texts.size}pt`, lineHeight: texts.leading }}
      >
        {texts.body}
      </p>
    </section>
  );
}

/** Две колонки верха листа: слева кто и что, справа — в каком виде и с чем. */
function Columns({ left, right }: { left: React.ReactNode; right: React.ReactNode }) {
  return (
    <div className="mt-4 grid grid-cols-2 gap-x-[8mm]">
      <div className="min-w-0">{left}</div>
      <div className="min-w-0">{right}</div>
    </div>
  );
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

export function PrintSheet({
  order,
  doc,
  forms,
  workshop,
  preview = false,
}: {
  order: Order;
  doc: Doc;
  forms: PrintForms;
  workshop: string;
  preview?: boolean;
}) {
  // Деньги печатаем только тому, кому они видны в системе. Мастер, у которого
  // в карточке нет сумм, не должен получить их через кнопку печати.
  const showMoney = order.total !== undefined;
  const works = order.works.map((w) => ({ name: w.name, qty: w.qty, price: w.price }));
  const parts = order.parts.map((p) => ({ name: p.name, qty: p.qty, price: p.price }));
  const texts = doc === "intake" ? forms.intake : forms.act;
  const title = texts.title;

  // Лист A4. Ширина в миллиметрах, чтобы на экране было видно, как ляжет.
  // В предпросмотре настроек лист не ужимается под окно: его уменьшают
  // целиком, как картинку, иначе строки переносились бы не так, как на бумаге.
  return (
    <div
      className={
        preview
          ? "w-[210mm] bg-white p-[14mm] text-black"
          : "mx-auto my-6 w-[210mm] max-w-full overflow-hidden bg-white p-[14mm] text-black shadow-lg print:my-0 print:w-auto print:max-w-none print:p-[6mm] print:shadow-none"
      }
    >
      <header className="flex items-start justify-between gap-6 border-b-2 border-black pb-3">
        <div className="flex min-w-0 items-center gap-3">
          {forms.logo && (
            <img src={forms.logo} alt="" className="max-h-[52px] max-w-[150px] object-contain" />
          )}
          <div className="min-w-0">
            <p className="text-[17px] font-extrabold leading-tight">{forms.name || workshop}</p>
            {forms.requisites && (
              <p className="mt-0.5 whitespace-pre-line text-[11px] leading-snug text-black/60">{forms.requisites}</p>
            )}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[13px] font-bold">{title}</p>
          <p className="mt-0.5 font-mono text-[15px] font-bold">{order.number}</p>
          <p className="mt-0.5 text-[11px] text-black/60">
            {/* Акт — документ выдачи, поэтому и датирован выдачей. Раньше
                стояла дата готовности, и заказ, забранный через неделю,
                выглядел выданным в день ремонта. Ещё не выданный — сегодня:
                акт печатают у стойки, когда клиент уже пришёл. */}
            от {formatDate(doc === "act" ? (order.issuedAt ?? new Date().toISOString()) : order.acceptedAt)}
          </p>
        </div>
      </header>

      <Columns
        left={
          <>
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
                    doc === "intake" ? formatDate(order.dueAt) : formatDateTime(order.completedAt),
                  ],
                  ...(doc === "act" && order.issuedAt
                    ? ([["Выдана клиенту", formatDateTime(order.issuedAt)]] as Array<[string, string]>)
                    : []),
                ]}
              />
            </Section>
          </>
        }
        right={
          doc === "intake" ? (
            <>
              <Section title="Комплектность">
                <Checked items={order.completeness} empty="Принято без дополнительных принадлежностей" />
              </Section>
              <Section title="Внешнее состояние">
                <Checked
                  items={order.appearance}
                  empty="Видимых дефектов не зафиксировано"
                  strong={["Следы вскрытия", "Следы влаги"]}
                />
                {order.appearanceNote && <p className="mt-1 text-[12px]">{order.appearanceNote}</p>}
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
            </>
          ) : (
            <>
              <Section title="Заявленная неисправность">
                <p className="text-[12px] leading-relaxed">{order.complaint || "—"}</p>
              </Section>
              <Section title="Что оказалось не так">
                <p className="text-[12px] leading-relaxed">{order.diagnosis || "—"}</p>
                {order.masterComment && <p className="mt-1 text-[12px] leading-relaxed">{order.masterComment}</p>}
              </Section>
            </>
          )
        }
      />

      {doc === "intake" ? (
        <>
          <Terms title="Условия" texts={texts} />
          <div className="grid grid-cols-2 gap-10">
            <SignLine label={texts.signClient} />
            <SignLine
              label={`${texts.signStaff}${order.acceptedBy ? `: ${order.acceptedBy.fullName}` : ""}`}
              stamp={forms.stamp}
            />
          </div>
        </>
      ) : (
        <>
          <div className="mt-4">
            <Section title="Выполненные работы">
              <LineTable rows={works} showMoney={showMoney} />
            </Section>
          </div>

          <Section title="Запчасти и материалы">
            <LineTable rows={parts} showMoney={showMoney} />
          </Section>

          {/* Гарантия слева, итог справа — одной полосой, а не двумя
              разделами друг под другом с пустотой рядом. */}
          <div className="mt-4 grid grid-cols-2 items-start gap-x-[8mm] break-inside-avoid">
            <Section title="Гарантия">
              <Pairs
                items={[
                  [
                    "На работы",
                    order.warrantyDays ? `${order.warrantyDays} дн. — до ${formatDate(order.warrantyUntil)}` : "—",
                  ],
                  ["Мастер", order.assignedMaster?.fullName ?? "—"],
                ]}
              />
              {order.recommendation && (
                <p className="mt-2 text-[12px] leading-relaxed">
                  <span className="text-black/55">Рекомендации: </span>
                  {order.recommendation}
                </p>
              )}
            </Section>
            {showMoney ? (
              <table className="ml-auto text-[12px]">
                <tbody>
                  <tr>
                    <td className="py-0.5 pr-6 text-black/55">Работы</td>
                    <td className="py-0.5 text-right tabular-nums">{money(order.totalWork)}</td>
                  </tr>
                  {!!order.workDiscount && (
                    <tr>
                      <td className="py-0.5 pr-6 text-black/55">Скидка на работы, {order.workDiscountPercent}%</td>
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
            ) : (
              <div />
            )}
          </div>

          <Terms title="Условия гарантии" texts={texts} />
          <div className="grid grid-cols-2 gap-10">
            <SignLine label={texts.signClient} />
            <SignLine
              label={`${texts.signStaff}${order.assignedMaster ? `: ${order.assignedMaster.fullName}` : ""}`}
              stamp={forms.stamp}
            />
          </div>
        </>
      )}

      {/* Строка внизу листа — если мастерская её задала. */}
      {forms.footer && (
        <p className="mt-8 border-t border-black/20 pt-2 text-center text-[10.5px] text-black/60">{forms.footer}</p>
      )}
    </div>
  );
}
