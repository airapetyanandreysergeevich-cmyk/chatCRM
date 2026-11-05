import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { ordersApi, type Order } from "../lib/orders";
import { printFormsApi, type PrintForms } from "../lib/printForms";
import { PrintSheet, type Doc } from "../components/PrintSheet";
import { isStationPage, STATION_FAILED, STATION_READY } from "../lib/printing";
import { blanksApi, type Blank, type RenderedSheet } from "../lib/blanks";
import { ExcelPages } from "../components/ExcelSheet";
import { BlankPages } from "../components/blank/BlankRender";
import { layoutsApi, type Layout, type LayoutMeta } from "../lib/docLayouts";
import { orderData } from "../lib/blankData";

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

/** Картинка дорисована или не загрузилась — ждать её больше нечего. */
const settled = (img: HTMLImageElement) =>
  img.complete
    ? null
    : new Promise((r) => {
        img.addEventListener("load", r, { once: true });
        img.addEventListener("error", r, { once: true });
      });

export default function OrderPrint() {
  const { id = "" } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { me } = useAuth();

  const asked = params.get("doc");
  const doc: Doc = asked === "act" || asked === "extra" ? asked : "intake";
  // Свой бланк из Excel (03.11.2026): ?doc=x:<id>.
  const custom = asked?.startsWith("x:") ? asked.slice(2) : null;
  // Бланк из «Редактора бланков» (05.11.2026): ?doc=d:<id> — отдельной вкладкой;
  // заменяющий документ (квитанцию, акт…) печатается вместо стандартного сам.
  const designId = asked?.startsWith("d:") ? asked.slice(2) : null;
  const [layouts, setLayouts] = useState<{ active: Partial<Record<string, Layout>>; tabs: LayoutMeta[] } | null>(null);
  const [tabLayout, setTabLayout] = useState<Layout | null>(null);
  const [blankReady, setBlankReady] = useState(false);
  const [order, setOrder] = useState<Order | null>(null);
  const [forms, setForms] = useState<PrintForms | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blanks, setBlanks] = useState<Blank[]>([]);
  const [sheets, setSheets] = useState<RenderedSheet[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    blanksApi
      .list("order")
      .then((r) => setBlanks(r.items))
      .catch(() => setBlanks([]));
  }, []);
  useEffect(() => {
    layoutsApi
      .forPrint("order")
      .then(setLayouts)
      .catch(() => setLayouts({ active: {}, tabs: [] }));
  }, []);
  useEffect(() => {
    setTabLayout(null);
    setBlankReady(false);
    if (!designId) return;
    layoutsApi
      .get(designId)
      .then(setTabLayout)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Бланк не найден"));
  }, [designId]);
  useEffect(() => setBlankReady(false), [asked]);

  useEffect(() => {
    setSheets(null);
    if (!custom) return;
    blanksApi
      .render(custom, { orderId: id })
      .then((r) => setSheets(r.sheets))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Бланк не заполнился"));
  }, [custom, id]);

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

  // Бланк открыт программой FineCRM для печати без окна: когда он
  // дорисован, говорим ей об этом заголовком страницы (desktop/src/printing.js).
  const station = isStationPage();
  const design = custom ? null : designId ? (tabLayout?.design ?? null) : (layouts?.active[doc]?.design ?? null);
  const blankData = useMemo(() => (order && forms && design ? orderData(order, forms, workshop, designId ? null : doc) : null), [order, forms, design, workshop, designId, doc]);
  const onBlankReady = useCallback(() => setBlankReady(true), []);
  const ready = !!order && !!forms && !!layouts && (!custom || !!sheets) && (!designId || !!tabLayout) && (!design || blankReady);
  useEffect(() => {
    if (!station) return;
    if (error) {
      document.title = STATION_FAILED + error;
      return;
    }
    if (!ready) return;
    let alive = true;
    void (async () => {
      await document.fonts?.ready;
      await Promise.all([...document.images].map(settled));
      requestAnimationFrame(() => requestAnimationFrame(() => alive && (document.title = STATION_READY)));
    })();
    return () => {
      alive = false;
    };
  }, [station, ready, error]);

  if (error) return <div className="p-8 text-[14px]">{error}</div>;
  if (!order || !forms || !layouts) return <div className="p-8 text-[14px]">Готовим бланк…</div>;

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
              (doc === "intake" && !custom && !designId ? "bg-white text-black" : "border border-white/25 hover:bg-white/10")
            }
          >
            Квитанция
          </button>
          <button
            type="button"
            onClick={() => navigate(`/orders/${id}/print?doc=act`)}
            className={
              "rounded-[10px] px-4 py-2 text-[13.5px] font-semibold " +
              (doc === "act" && !custom && !designId ? "bg-white text-black" : "border border-white/25 hover:bg-white/10")
            }
          >
            Акт работ
          </button>
          {layouts.tabs.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => navigate(`/orders/${id}/print?doc=d:${l.id}`)}
              data-print-layout={l.name}
              className={
                "rounded-[10px] px-4 py-2 text-[13.5px] font-semibold " +
                (designId === l.id ? "bg-white text-black" : "border border-white/25 hover:bg-white/10")
              }
            >
              {l.name}
            </button>
          ))}
          {blanks.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => navigate(`/orders/${id}/print?doc=x:${b.id}`)}
              data-print-blank={b.name}
              className={
                "rounded-[10px] px-4 py-2 text-[13.5px] font-semibold " +
                (custom === b.id ? "bg-white text-black" : "border border-white/25 hover:bg-white/10")
              }
            >
              {b.name}
            </button>
          ))}
          {order.extra && (
            <button
              type="button"
              onClick={() => navigate(`/orders/${id}/print?doc=extra`)}
              className={
                "rounded-[10px] px-4 py-2 text-[13.5px] font-semibold " +
                (doc === "extra" && !custom && !designId ? "bg-white text-black" : "border border-white/25 hover:bg-white/10")
              }
            >
              Акт доплаты
            </button>
          )}
        </div>
        <div className="flex gap-2">
          {custom && (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                blanksApi
                  .fill(custom, { orderId: id })
                  .catch((err) => setError(err instanceof ApiError ? err.message : "Не скачалось"))
                  .finally(() => setBusy(false));
              }}
              className="rounded-[10px] border border-white/25 px-4 py-2 text-[13.5px] font-semibold hover:bg-white/10"
              data-print-blank-xlsx
            >
              {busy ? "Готовим…" : "Скачать .xlsx"}
            </button>
          )}
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded-[10px] bg-white px-5 py-2 text-[13.5px] font-bold text-black hover:bg-white/90"
          >
            Печать
          </button>
        </div>
      </div>

      {custom ? (
        sheets ? (
          <ExcelPages sheets={sheets} />
        ) : (
          <div className="p-8 text-[14px] text-white">Заполняем бланк…</div>
        )
      ) : designId ? (
        tabLayout && blankData ? (
          <BlankPages design={tabLayout.design} data={blankData} target="order" onReady={onBlankReady} />
        ) : (
          <div className="p-8 text-[14px] text-white">Готовим бланк…</div>
        )
      ) : design && blankData ? (
        <BlankPages design={design} data={blankData} target="order" onReady={onBlankReady} />
      ) : (
        <PrintSheet order={order} doc={doc} forms={forms} workshop={workshop} />
      )}
    </div>
  );
}
