import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ordersApi, type Order } from "../lib/orders";
import { printFormsApi, type PrintForms } from "../lib/printForms";
import { PrintSheet, type Doc } from "../components/PrintSheet";

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

export default function OrderPrint() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { me } = useAuth();

  const doc: Doc = params.get("doc") === "act" ? "act" : "intake";
  const [order, setOrder] = useState<Order | null>(null);
  const [forms, setForms] = useState<PrintForms | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ordersApi
      .get(id)
      .then(setOrder)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить заказ"));
    // Тексты и логотип бланков — из «Настройки → Бланки».
    printFormsApi
      .get()
      .then(setForms)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить настройки бланков"));
  }, [id]);

  const workshop =
    me?.kind === "tenant"
      ? (me.tenant?.name ?? "Мастерская")
      : me?.kind === "platform"
        ? (me.impersonating?.name ?? "Мастерская")
        : "Мастерская";

  if (error) return <div className="p-8 text-[14px]">{error}</div>;
  if (!order || !forms) return <div className="p-8 text-[14px]">Готовим бланк…</div>;

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

      <PrintSheet order={order} doc={doc} forms={forms} workshop={workshop} />
    </div>
  );
}
