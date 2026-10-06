import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../lib/api";
import { money } from "../lib/orders";
import { partsApi, STOCK_LABEL, type PartOffer, type PartShop, type ShopResult } from "../lib/partsApi";
import { forgetMarket, marketOffers, marketsBridge, matches, watchMarkets } from "../lib/markets";
import { IconExternal, IconSearch } from "./icons";
import { Modal } from "./Modal";
import { ShopLogo } from "./ShopLogo";
import { Banner, Button, SearchInput, Spinner } from "./ui";

const cx = (...p: Array<string | false | null | undefined>) => p.filter(Boolean).join(" ");

/**
 * Окно «Поиск запчасти по магазинам».
 *
 * Открывается со Склада и из запчастей заказа. Магазины спрашиваются
 * параллельно, по одному запросу на магазин: ответы встают в общий список
 * сразу, как приходят, — сначала в наличии и дешевле. Что магазин предложил
 * «похожим» (соседние модели, платы с этим чипом в описании), убрано под
 * «Ещё похожие»: не мешает и не теряется.
 *
 * Какие магазины спрашивать, сотрудник выбирает себе сам в Настройки → Агенты.
 */

export type PickedOffer = PartOffer & { shopName: string };

type ShopState = { status: "loading" } | { status: "done"; result: ShopResult } | { status: "error"; message: string };

const STOCK_RANK = { in: 0, order: 1, unknown: 2, out: 3 } as const;
const byStockPrice = (a: PartOffer, b: PartOffer) =>
  STOCK_RANK[a.stock] - STOCK_RANK[b.stock] || (a.price ?? Infinity) - (b.price ?? Infinity);

/** «NT156WHM-N10» → «NT156WHM»: запрос короче, если точного ничего нет. */
export function shorter(q: string): string | null {
  const t = q.trim();
  const cut = t.split(/[\s\-–_/.,]+/)[0];
  return cut && cut.length >= 3 && cut.length < t.length ? cut : null;
}

function StockBadge({ offer }: { offer: PartOffer }) {
  const tone = {
    in: "text-state-done",
    order: "text-state-waiting",
    unknown: "text-ink-muted",
    out: "text-state-off",
  }[offer.stock];
  return (
    <span className={cx("text-[12.5px] font-semibold", tone)}>
      {/* «уточняйте», «ожидается 20.10» — слова магазина сами по себе; «в 3 магазинах» — уточнение к «в наличии». */}
      {(offer.stock === "unknown" || offer.stock === "order") && offer.stockText ? offer.stockText : STOCK_LABEL[offer.stock]}
      {offer.stock !== "unknown" && offer.stock !== "order" && offer.stockText ? (
        <span className="font-normal text-ink-muted"> · {offer.stockText}</span>
      ) : null}
    </span>
  );
}

function OfferRow({
  offer,
  shopId,
  shopName,
  onPick,
  pickLabel,
}: {
  offer: PartOffer;
  shopId: string;
  shopName: string;
  onPick?: (o: PickedOffer) => void;
  pickLabel: string;
}) {
  return (
    <div data-offer className="grid grid-cols-[32px_1fr] gap-x-3 gap-y-1 border-t border-line py-2.5 first:border-t-0 sm:grid-cols-[32px_1fr_auto_auto] sm:items-center">
      <span className="row-span-3 pt-0.5 sm:row-span-1 sm:pt-0">
        <ShopLogo id={shopId} name={shopName} size={32} />
      </span>
      <div className="min-w-0">
        <span className="mr-2 inline-block rounded-pill bg-surface-raised px-2 py-0.5 text-[11.5px] font-bold text-ink-soft">{shopName}</span>
        <a
          href={offer.url}
          target="_blank"
          rel="noopener noreferrer"
          className="break-words text-[14px] font-semibold text-ink hover:text-brand hover:underline"
        >
          {offer.name}
        </a>
        {offer.article && <span className="ml-1.5 text-[12px] text-ink-dim">арт. {offer.article}</span>}
        <div className="mt-0.5">
          <StockBadge offer={offer} />
        </div>
      </div>
      <div className="text-left sm:text-right">
        <div className="text-[15px] font-bold tabular-nums">{offer.price !== null ? money(offer.price) : "—"}</div>
        {offer.priceNote && <div className="text-[12px] text-ink-muted">{offer.priceNote}</div>}
      </div>
      {onPick && (
        <Button
          type="button"
          variant="secondary"
          className="min-h-[38px] px-3 text-[13px]"
          onClick={() => onPick({ ...offer, shopName })}
        >
          {pickLabel}
        </Button>
      )}
    </div>
  );
}

export function PartsSearch({
  onClose,
  initialQuery = "",
  onPick,
  pickLabel = "В заказ",
}: {
  onClose: () => void;
  initialQuery?: string;
  /** Есть — у строк кнопка «В заказ». Нет (Склад) — только ссылки на магазины. */
  onPick?: (o: PickedOffer) => void;
  pickLabel?: string;
}) {
  const [shops, setShops] = useState<PartShop[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [q, setQ] = useState(initialQuery);
  const [asked, setAsked] = useState<string | null>(null);
  const [state, setState] = useState<Record<string, ShopState>>({});
  const [showSimilar, setShowSimilar] = useState(false);
  const run = useRef(0);
  // Площадки в окне программы: что прислала кнопка «Показать списком».
  const markets = marketsBridge();
  const [, setMarketTick] = useState(0);
  const [marketError, setMarketError] = useState<string | null>(null);
  useEffect(() => (markets ? watchMarkets(() => setMarketTick((n) => n + 1)) : undefined), [markets]);

  useEffect(() => {
    partsApi
      .shops()
      .then((r) => setShops(r.shops))
      .catch((e) => setLoadError(e instanceof ApiError ? e.message : "Не удалось загрузить список магазинов"));
  }, []);

  const enabled = useMemo(() => (shops ?? []).filter((s) => s.enabled), [shops]);
  const readable = enabled.filter((s) => !s.linkOnly);
  const linkOnly = enabled.filter((s) => s.linkOnly);
  const nameOf = (id: string) => shops?.find((s) => s.id === id)?.name ?? id;

  // Окно открыли с готовым запросом (из строки запчасти, из поиска склада) — ищем сразу.
  // Нажали «Найти» раньше, чем пришёл список магазинов, — ищем, как только он придёт.
  const pending = useRef<string | null>(initialQuery.trim().length >= 2 ? initialQuery : null);
  useEffect(() => {
    if (!shops || pending.current === null) return;
    const text = pending.current;
    pending.current = null;
    search(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shops]);

  function search(text: string, fresh = false) {
    const query = text.trim();
    if (query.length < 2) return;
    if (!shops) {
      pending.current = query;
      setQ(query);
      setAsked(query);
      return;
    }
    const id = ++run.current;
    setQ(query);
    setAsked(query);
    setShowSimilar(false);
    setState(Object.fromEntries(enabled.map((s) => [s.id, { status: "loading" } as ShopState])));
    for (const s of enabled) {
      partsApi
        .search(s.id, query, fresh)
        .then((result) => {
          if (run.current !== id) return;
          setState((cur) => ({ ...cur, [s.id]: result.error ? { status: "error", message: result.error } : { status: "done", result } }));
        })
        .catch((e) => {
          if (run.current !== id) return;
          setState((cur) => ({
            ...cur,
            [s.id]: { status: "error", message: e instanceof ApiError ? e.message : "нет связи с сервером" },
          }));
        });
    }
  }

  const fromServer = Object.entries(state).flatMap(([id, st]) => (st.status === "done" && !st.result.linkOnly ? [{ id, r: st.result }] : []));
  // Товары из окна площадок — как ответ ещё одного магазина; совпадение считаем тем же правилом.
  const fromMarkets = asked
    ? linkOnly.flatMap((s) => {
        const m = marketOffers(s.id, asked);
        if (!m) return [];
        const r: ShopResult = {
          shop: s.id,
          url: m.url,
          offers: m.offers.map((o) => ({ ...o, exact: matches(asked, o) })),
          more: 0,
          ms: 0,
        };
        return [{ id: s.id, r }];
      })
    : [];
  const results = [...fromServer, ...fromMarkets];
  const openMarket = async (s: PartShop) => {
    if (!markets || !asked) return;
    const urls: Record<string, string> = {};
    for (const x of linkOnly) {
      const u = searchUrlOf(x);
      if (u) urls[x.id] = u;
    }
    if (!urls[s.id]) return;
    setMarketError(null);
    forgetMarket(s.id);
    const r = await markets.open({ shop: s.id, query: asked, urls });
    if (!r.ok) setMarketError(r.error ?? "Окно площадки не открылось");
  };
  const exact = results
    .flatMap(({ id, r }) => r.offers.filter((o) => o.exact).map((o) => ({ o, id })))
    .sort((a, b) => byStockPrice(a.o, b.o));
  const similar = results
    .flatMap(({ id, r }) => r.offers.filter((o) => !o.exact).map((o) => ({ o, id })))
    .sort((a, b) => byStockPrice(a.o, b.o));
  const similarMore = results.reduce((n, { r }) => n + r.more, 0);
  const loading = (!shops && !loadError) || readable.some((s) => state[s.id]?.status === "loading");
  const searchUrlOf = (s: PartShop) => {
    const st = state[s.id];
    return st?.status === "done" ? st.result.url : null;
  };
  const short = asked ? shorter(asked) : null;

  return (
    <Modal title="Поиск запчасти по магазинам" onClose={onClose} wide>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          search(q);
        }}
      >
        <SearchInput
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Название или маркировка: IT5571VG, NT156WHM-N10…"
          aria-label="Что ищем"
          autoComplete="off"
          enterKeyHint="search"
        />
        <Button type="submit" icon={<IconSearch />} disabled={q.trim().length < 2 || !!loadError}>
          Найти
        </Button>
      </form>

      {loadError && (
        <div className="mt-3">
          <Banner tone="error">{loadError}</Banner>
        </div>
      )}

      {shops && (
        <p className="mt-2 text-[12.5px] text-ink-dim">
          {enabled.length ? (
            <>
              Ищем в: {enabled.map((s) => s.name).join(", ")}.{" "}
            </>
          ) : (
            <>Все магазины выключены. </>
          )}
          <Link to="/settings/agents" className="font-semibold text-brand hover:underline">
            Выбрать магазины
          </Link>
        </p>
      )}

      {asked && (
        <div className="mt-4 space-y-4">
          {/* Состояние магазинов: кто ещё думает, кто не ответил, ссылки на их поиск. */}
          <div className="flex flex-wrap gap-1.5" data-shops>
            {readable.map((s) => {
              const st = state[s.id];
              const url = searchUrlOf(s);
              const count = st?.status === "done" ? st.result.offers.filter((o) => o.exact).length : 0;
              const label =
                !st || st.status === "loading"
                  ? "ищет…"
                  : st.status === "error"
                    ? st.message
                    : count
                      ? String(count)
                      : "нет";
              const tone =
                st?.status === "error"
                  ? "border-state-off/40 text-state-off"
                  : st?.status === "done" && count
                    ? "border-state-done/50 text-ink"
                    : "border-line text-ink-muted";
              const body = (
                <>
                  <ShopLogo id={s.id} name={s.name} size={16} />
                  <b className="font-bold">{s.name}</b> · {label}
                  {url && <IconExternal className="h-3.5 w-3.5 shrink-0" />}
                </>
              );
              return url ? (
                <a
                  key={s.id}
                  data-shop={s.id}
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Открыть поиск на сайте магазина"
                  className={cx("inline-flex items-center gap-1 rounded-pill border px-2.5 py-1 text-[12.5px] hover:border-line-strong", tone)}
                >
                  {body}
                </a>
              ) : (
                <span key={s.id} data-shop={s.id} className={cx("inline-flex items-center gap-1 rounded-pill border px-2.5 py-1 text-[12.5px]", tone)}>
                  {body}
                </span>
              );
            })}
            {markets
              ? linkOnly.map((s) => {
                  const got = asked ? marketOffers(s.id, asked) : null;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      data-shop={s.id}
                      disabled={!searchUrlOf(s)}
                      onClick={() => void openMarket(s)}
                      title="Открыть площадку в окне программы"
                      className={cx(
                        "inline-flex items-center gap-1 rounded-pill border px-2.5 py-1 text-[12.5px] hover:border-line-strong hover:text-ink",
                        got ? "border-state-done/50 text-ink" : "border-dashed border-line text-ink-muted"
                      )}
                    >
                      <ShopLogo id={s.id} name={s.name} size={16} />
                      <b className="font-bold">{s.name}</b> · {got ? `${got.offers.filter((o) => matches(asked ?? "", o)).length} из окна` : "открыть"}
                    </button>
                  );
                })
              : linkOnly.map((s) => (
              <a
                key={s.id}
                data-shop={s.id}
                href={searchUrlOf(s) ?? `https://${s.site}/`}
                target="_blank"
                rel="noopener noreferrer"
                title="Этот магазин смотрим только на его сайте"
                className="inline-flex items-center gap-1 rounded-pill border border-dashed border-line px-2.5 py-1 text-[12.5px] text-ink-muted hover:border-line-strong hover:text-ink"
              >
                <ShopLogo id={s.id} name={s.name} size={16} />
                <b className="font-bold">{s.name}</b> · открыть поиск
                <IconExternal className="h-3.5 w-3.5 shrink-0" />
              </a>
            ))}
          </div>
          {markets && linkOnly.length > 0 && (
            <p className="-mt-2 text-[12.5px] leading-relaxed text-ink-dim" data-markets-hint>
              {linkOnly.map((s) => s.name).join(", ")} открываются в окне программы: найдите нужное и нажмите там
              «Показать списком в FineCRM» — товары появятся здесь{onPick ? `, с кнопкой «${pickLabel}»` : ""}.
            </p>
          )}
          {marketError && <Banner tone="error">{marketError}</Banner>}

          {exact.length > 0 ? (
            <div data-exact>
              {exact.map(({ o, id }, i) => (
                <OfferRow key={`${id}-${i}`} offer={o} shopId={id} shopName={nameOf(id)} onPick={onPick} pickLabel={pickLabel} />
              ))}
            </div>
          ) : loading ? (
            <div className="py-6">
              <Spinner label="Спрашиваем магазины" />
            </div>
          ) : (
            <div className="rounded-field border border-line bg-surface-raised p-4 text-[14px]">
              <p className="font-semibold">Точных совпадений нет.</p>
              <p className="mt-1 text-ink-muted">
                Проверьте маркировку или поищите короче — магазины пишут название по-разному.
              </p>
              {short && (
                <Button type="button" variant="secondary" className="mt-3" onClick={() => search(short)}>
                  Искать «{short}»
                </Button>
              )}
            </div>
          )}

          {loading && exact.length > 0 && <p className="text-[12.5px] text-ink-dim">Ещё отвечают другие магазины…</p>}

          {similar.length > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setShowSimilar((v) => !v)}
                className="text-[13px] font-semibold text-brand hover:underline"
                aria-expanded={showSimilar}
              >
                {showSimilar ? "Скрыть похожие" : `Ещё похожие — ${similar.length + similarMore}`}
              </button>
              {showSimilar && (
                <div className="mt-2 opacity-90" data-similar>
                  {similar.map(({ o, id }, i) => (
                    <OfferRow key={`s-${id}-${i}`} offer={o} shopId={id} shopName={nameOf(id)} onPick={onPick} pickLabel={pickLabel} />
                  ))}
                  {similarMore > 0 && (
                    <p className="pt-2 text-[12.5px] text-ink-dim">И ещё {similarMore} — на сайтах магазинов по ссылкам выше.</p>
                  )}
                </div>
              )}
            </div>
          )}

          {!loading && results.some(({ r }) => r.cached) && (
            <p className="text-[12.5px] text-ink-dim">
              Цены запомнены до часа назад.{" "}
              <button type="button" className="font-semibold text-brand hover:underline" onClick={() => search(asked, true)}>
                Спросить заново
              </button>
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
