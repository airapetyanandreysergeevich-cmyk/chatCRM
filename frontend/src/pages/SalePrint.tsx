import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDate, formatDateTime } from "../lib/format";
import { printFormsApi, type PrintForms } from "../lib/printForms";
import { PAYMENT_LABEL, salesApi, warrantyLabel, type Sale } from "../lib/salesApi";

/**
 * Товарный чек продажи со склада.
 *
 * Как и бланки заказа — чёрным по белому, с шапкой из «Настройки → Бланки»
 * (логотип, название, реквизиты). Половина листа A4: чек кладут в пакет с
 * товаром, лист целиком для него велик. ?print=1 — сразу окно печати
 * («Продать и напечатать чек»).
 */

/** На бумаге — с годом: чек хранят для гарантии. */
const fullDate = (iso: string) =>
  new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

const money = (v: number) => `${v.toLocaleString("ru-RU", { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 })} ₽`;

export default function SalePrint() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { me } = useAuth();
  const [sale, setSale] = useState<Sale | null>(null);
  const [forms, setForms] = useState<PrintForms | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    salesApi
      .get(id)
      .then(setSale)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить продажу"));
    printFormsApi
      .get()
      .then(setForms)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить настройки бланков"));
  }, [id]);

  const auto = params.get("print") === "1";
  useEffect(() => {
    if (!auto || !sale || !forms) return;
    const t = setTimeout(() => window.print(), 300);
    return () => clearTimeout(t);
  }, [auto, sale, forms]);

  const workshop =
    me?.kind === "tenant" ? (me.tenant?.name ?? "Мастерская") : me?.kind === "platform" ? (me.impersonating?.name ?? "Мастерская") : "Мастерская";

  if (error) return <div className="p-8 text-[14px]">{error}</div>;
  if (!sale || !forms) return <div className="p-8 text-[14px]">Готовим чек…</div>;

  const units = sale.items.reduce((n, i) => n + i.qty, 0);

  return (
    <div className="min-h-screen bg-[#6B7280] print:bg-white">
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 bg-black/85 px-5 py-3 text-white print:hidden">
        <button
          type="button"
          onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/stock"))}
          className="rounded-[10px] border border-white/25 px-4 py-2 text-[13.5px] font-semibold hover:bg-white/10"
        >
          ‹ Назад
        </button>
        <button type="button" onClick={() => window.print()} className="rounded-[10px] bg-white px-5 py-2 text-[13.5px] font-bold text-black hover:bg-white/90">
          Печать
        </button>
      </div>

      <div
        className="mx-auto my-6 w-[210mm] max-w-full overflow-hidden bg-white p-[12mm] text-black shadow-lg print:my-0 print:w-auto print:max-w-none print:p-[6mm] print:shadow-none"
        data-sale-receipt
      >
        <header className="flex items-start justify-between gap-6 border-b-2 border-black pb-3">
          <div className="flex min-w-0 items-center gap-3">
            {forms.logo && <img src={forms.logo} alt="" className="max-h-[48px] max-w-[140px] object-contain" />}
            <div className="min-w-0">
              <p className="text-[16px] font-extrabold leading-tight">{forms.name || workshop}</p>
              {forms.requisites && <p className="mt-0.5 whitespace-pre-line text-[10.5px] leading-snug text-black/60">{forms.requisites}</p>}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-[13px] font-bold">Товарный чек</p>
            <p className="mt-0.5 font-mono text-[15px] font-bold">{sale.number}</p>
            <p className="mt-0.5 text-[11px] text-black/60">от {fullDate(sale.createdAt)}</p>
          </div>
        </header>

        {sale.customer && (
          <p className="mt-3 text-[12px]">
            <span className="text-black/55">Покупатель:</span> <b>{sale.customer.name}</b>
          </p>
        )}

        <table className="mt-3 w-full border-collapse text-[12px]">
          <thead>
            <tr className="border-b border-black/40 text-left text-[10.5px] uppercase tracking-[0.06em] text-black/60">
              <th className="w-[7mm] py-1.5 pr-2 font-semibold">№</th>
              <th className="py-1.5 pr-2 font-semibold">Товар</th>
              <th className="w-[18mm] py-1.5 pr-2 text-right font-semibold">Кол-во</th>
              <th className="w-[26mm] py-1.5 pr-2 text-right font-semibold">Цена</th>
              <th className="w-[28mm] py-1.5 text-right font-semibold">Сумма</th>
            </tr>
          </thead>
          <tbody>
            {sale.items.map((i, n) => (
              <tr key={i.id} className="border-b border-black/15 align-top">
                <td className="py-1.5 pr-2 text-black/60">{n + 1}</td>
                <td className="py-1.5 pr-2">
                  {i.name}
                  {i.sku && <span className="ml-1.5 font-mono text-[10.5px] text-black/55">{i.sku}</span>}
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{i.qty} шт.</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{money(i.price)}</td>
                <td className="py-1.5 text-right font-semibold tabular-nums">{money(i.sum)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-3 flex justify-end">
          <dl className="w-[75mm] text-[12px]">
            <div className="flex justify-between py-0.5">
              <dt className="text-black/60">Товаров, {units} шт.</dt>
              <dd className="tabular-nums">{money(sale.subtotal)}</dd>
            </div>
            {sale.discount > 0 && (
              <div className="flex justify-between py-0.5">
                <dt className="text-black/60">Скидка</dt>
                <dd className="tabular-nums">− {money(sale.discount)}</dd>
              </div>
            )}
            <div className="mt-1 flex justify-between border-t-2 border-black pt-1.5 text-[15px] font-extrabold">
              <dt>Итого</dt>
              <dd className="tabular-nums">{money(sale.total)}</dd>
            </div>
            <div className="flex justify-between py-0.5 text-[11.5px]">
              <dt className="text-black/60">Оплата</dt>
              <dd>{PAYMENT_LABEL[sale.payment]}</dd>
            </div>
          </dl>
        </div>

        <p className="mt-3 text-[11.5px]">
          <span className="text-black/55">Гарантия:</span>{" "}
          {sale.warrantyDays ? (
            <>
              {warrantyLabel(sale.warrantyDays)}, до <b>{formatDate(sale.warrantyUntil)}</b>. Гарантия действует при сохранении этого чека.
            </>
          ) : (
            "без гарантии"
          )}
        </p>
        {sale.returnedAt && (
          <p className="mt-2 rounded-[3px] border border-black/40 px-2 py-1 text-[11.5px] font-semibold">
            Продажа возвращена {formatDateTime(sale.returnedAt)}
            {sale.returnReason ? `: ${sale.returnReason}` : ""}.
          </p>
        )}

        <div className="mt-8 grid grid-cols-2 gap-[10mm]">
          <div>
            <div className="h-[1px] w-full bg-black/60" />
            <p className="mt-1 text-[10.5px] text-black/60">Продавец{sale.soldBy ? `: ${sale.soldBy.fullName}` : ""}</p>
            {forms.stamp && <p className="mt-3 text-[11px] font-semibold text-black/70">М.П.</p>}
          </div>
          <div>
            <div className="h-[1px] w-full bg-black/60" />
            <p className="mt-1 text-[10.5px] text-black/60">Покупатель: товар получил, претензий нет</p>
          </div>
        </div>
        {forms.footer && <p className="mt-6 text-center text-[10.5px] text-black/55">{forms.footer}</p>}
      </div>
    </div>
  );
}
