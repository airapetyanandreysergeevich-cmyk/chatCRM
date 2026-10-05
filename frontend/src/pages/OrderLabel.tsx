import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Label, type LabelData } from "../components/Label";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { labelData, labelItems, labelsApi, labelsFor, SAMPLE_LABEL, useLabelLogo, type LabelSettings, type LabelsView } from "../lib/labels";
import { ordersApi, type Order } from "../lib/orders";
import { isStationPage, STATION_FAILED, STATION_READY } from "../lib/printing";

/**
 * Наклейки заказа — по одной на каждую вещь, каждая своим листом.
 *
 * Как и бланки, живёт мимо основного интерфейса: это бумага. Лист — ровно
 * этикетка (@page по настройке), без полей. Программа FineCRM печатает эту
 * страницу молча (режим ?station=1), из браузера — обычным окном печати:
 * в нём надо выбрать принтер этикеток и «Поля: нет».
 *
 * /orders/:id/label?i=device&i=Блок питания — на какие вещи; без i — на все.
 * /label-test — пробная наклейка с выдуманным заказом.
 */
export default function OrderLabel({ test = false }: { test?: boolean }) {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { me } = useAuth();
  const [view, setView] = useState<LabelsView | null>(null);
  // ?t= — каким шаблоном (окно «Наклейки», пробная из конструктора); без него — основным.
  const settings: LabelSettings | null = view ? labelsFor(view, params.get("t")) : null;
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    labelsApi
      .get()
      .then(setView)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить настройку наклейки"));
    if (!test)
      ordersApi
        .get(id)
        .then(setOrder)
        .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось загрузить заказ"));
  }, [id, test]);

  const workshop = me?.kind === "tenant" ? (me.tenant?.name ?? "") : me?.kind === "platform" ? (me.impersonating?.name ?? "") : "";

  // Логотип — тот же, что на бланках, переведённый в чёрно-белый; без галочки не грузим.
  const logo = useLabelLogo(!!settings?.fields.logo);

  let labels: LabelData[] = [];
  if (settings && test) labels = [{ ...SAMPLE_LABEL, workshop: workshop || SAMPLE_LABEL.workshop, logo: logo.logo }];
  if (settings && order) {
    const all = labelItems(order, settings);
    const wanted = params.getAll("i");
    const items = wanted.length ? all.filter((x) => wanted.includes(x.key)) : all;
    labels = items.map((it, i) => ({ ...labelData(order, it, i + 1, items.length, workshop), logo: logo.logo }));
  }

  // Программа FineCRM ждёт сигнала «дорисовано» в заголовке (desktop/src/printing.js).
  const station = isStationPage();
  const ready = !!settings && (test || !!order) && logo.ready;
  useEffect(() => {
    if (!station) return;
    if (error) {
      document.title = STATION_FAILED + error;
      return;
    }
    if (!ready) return;
    if (!labels.length) {
      document.title = STATION_FAILED + "Не на что печатать: в заказе нет таких вещей";
      return;
    }
    let alive = true;
    void (async () => {
      await document.fonts?.ready;
      // Логотип — картинка: печатать, только когда она дорисована.
      await Promise.all(
        [...document.images].map((img) =>
          img.complete ? null : new Promise((r) => (img.addEventListener("load", r, { once: true }), img.addEventListener("error", r, { once: true })))
        )
      );
      requestAnimationFrame(() => requestAnimationFrame(() => alive && (document.title = STATION_READY)));
    })();
    return () => {
      alive = false;
    };
  }, [station, ready, error, labels.length]);

  if (error) return <div className="p-8 text-[14px]">{error}</div>;
  if (!ready || !settings) return <div className="p-8 text-[14px]">Готовим наклейки…</div>;

  const W = settings.width, H = settings.height;
  return (
    <div className="min-h-screen bg-[#6B7280] print:bg-white">
      {/* Лист — ровно этикетка, без полей: поля принтера этикеток съели бы половину наклейки. */}
      <style>{`@page { size: ${W}mm ${H}mm; margin: 0; } @media print { html, body { margin: 0 !important; padding: 0 !important; } .label-sheet { break-after: page; } .label-sheet:last-child { break-after: auto; } }`}</style>
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 bg-black/85 px-5 py-3 text-white print:hidden">
        <div className="flex flex-wrap items-center gap-3">
          {!test && (
            <button
              type="button"
              onClick={() => navigate(`/orders/${id}`)}
              className="rounded-[10px] border border-white/25 px-4 py-2 text-[13.5px] font-semibold hover:bg-white/10"
            >
              ‹ К заказу
            </button>
          )}
          <span className="text-[13.5px] text-white/80">
            {labels.length} {labels.length === 1 ? "наклейка" : labels.length < 5 ? "наклейки" : "наклеек"} · {W}×{H} мм. В окне печати —
            принтер этикеток и «Поля: нет».
          </span>
        </div>
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded-[10px] bg-white px-5 py-2 text-[13.5px] font-bold text-black hover:bg-white/90"
        >
          Печать
        </button>
      </div>
      <div className="flex flex-col items-center gap-6 p-8 print:block print:gap-0 print:p-0">
        {labels.map((d, i) => (
          <div key={i} className="label-sheet shadow-[0_6px_24px_rgba(0,0,0,0.35)] print:shadow-none">
            <Label settings={settings} data={d} />
          </div>
        ))}
      </div>
    </div>
  );
}
