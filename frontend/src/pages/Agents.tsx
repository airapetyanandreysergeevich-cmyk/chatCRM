import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { IconAgent, IconExternal } from "../components/icons";
import { Banner, Button, Card, Checkbox, PageHeader, SectionLabel, Spinner } from "../components/ui";
import { ApiError } from "../lib/api";
import { partsApi, type PartShop } from "../lib/partsApi";

/**
 * Настройки → Агенты.
 *
 * Агент — помощник, который сам сходит и узнает. Пока один: поиск запчастей
 * по магазинам (кнопки на Складе и в запчастях заказа). Магазины у каждого
 * сотрудника свои: мастеру по телефонам незачем ждать магазин матриц.
 *
 * Галочка сохраняется сразу — отдельной «Сохранить» нет, забыть её нажать
 * нельзя.
 */

type Probe = { status: "loading" } | { status: "ok"; count: number; ms: number } | { status: "error"; message: string };

export default function Agents() {
  const [shops, setShops] = useState<PartShop[] | null>(null);
  const [personal, setPersonal] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [probe, setProbe] = useState<Record<string, Probe>>({});

  useEffect(() => {
    partsApi
      .shops()
      .then((r) => {
        setShops(r.shops);
        setPersonal(r.personal);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Не удалось загрузить магазины"));
  }, []);

  async function toggle(id: string, on: boolean) {
    if (!shops) return;
    const prev = shops;
    const next = shops.map((s) => (s.id === id ? { ...s, enabled: on } : s));
    setShops(next);
    setSaved(false);
    setError(null);
    try {
      await partsApi.saveShops(next.filter((s) => !s.enabled).map((s) => s.id));
      setSaved(true);
    } catch (e) {
      setShops(prev);
      setError(e instanceof ApiError ? e.message : "Не сохранилось — нет связи с сервером");
    }
  }

  function check() {
    if (!shops) return;
    const list = shops.filter((s) => !s.linkOnly);
    setProbe(Object.fromEntries(list.map((s) => [s.id, { status: "loading" } as Probe])));
    for (const s of list) {
      partsApi
        .search(s.id, s.probe, true)
        .then((r) =>
          setProbe((cur) => ({
            ...cur,
            [s.id]: r.error
              ? { status: "error", message: r.error }
              : r.offers.length
                ? { status: "ok", count: r.offers.length, ms: r.ms }
                : { status: "error", message: "товаров не нашлось — возможно, сайт поменялся" },
          }))
        )
        .catch((e) =>
          setProbe((cur) => ({ ...cur, [s.id]: { status: "error", message: e instanceof ApiError ? e.message : "нет связи с сервером" } }))
        );
    }
  }

  const checking = Object.values(probe).some((p) => p.status === "loading");

  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Настройки" title="Агенты" subtitle="Помощники, которые сами сходят и узнают за вас." />

      <Card>
        <div className="flex items-start gap-3.5">
          <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-field bg-surface-raised text-ink-muted [&>svg]:h-[19px] [&>svg]:w-[19px]">
            <IconAgent />
          </span>
          <div className="min-w-0">
            <h2 className="text-[17px] font-bold">Агент поиска запчастей</h2>
            <p className="mt-1 text-[13.5px] leading-relaxed text-ink-muted">
              Набираете маркировку детали — агент спрашивает магазины и показывает, где есть, почём и в наличии ли.
              Кнопка «Найти у поставщиков» есть на <Link to="/stock" className="font-semibold text-brand hover:underline">Складе</Link> и
              в запчастях заказа. Отметьте магазины, в которых искать вам, — у каждого сотрудника свой список.
            </p>
          </div>
        </div>

        <div className="mt-5">
          {error && (
            <div className="mb-3">
              <Banner tone="error">{error}</Banner>
            </div>
          )}
          {!personal && (
            <div className="mb-3">
              <Banner tone="info">Магазины выбирает себе сотрудник мастерской. Здесь показан список по умолчанию.</Banner>
            </div>
          )}
          {!shops && !error && <Spinner label="Загружаем магазины" />}
          {shops && (
            <>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <SectionLabel>Где искать</SectionLabel>
                <span className="text-[12.5px] text-ink-dim" aria-live="polite">
                  {saved ? "Сохранено" : `Включено ${shops.filter((s) => s.enabled).length} из ${shops.length}`}
                </span>
              </div>
              <div className="mt-3 grid gap-2 lg:grid-cols-2" data-agent-shops>
                {shops.map((s) => {
                  const p = probe[s.id];
                  return (
                    <div key={s.id} data-shop={s.id}>
                      <Checkbox
                        checked={s.enabled}
                        disabled={!personal}
                        onChange={(on) => toggle(s.id, on)}
                        label={
                          <span className="min-w-0 py-2">
                            <span className="block font-semibold text-ink">
                              {s.name} <span className="font-normal text-ink-dim">· {s.site}</span>
                            </span>
                            <span className="block text-[12.5px] text-ink-muted">
                              {s.about}
                              {s.linkOnly && " — откроется его сайт"}
                            </span>
                            {p && (
                              <span
                                data-probe
                                className={
                                  "block text-[12.5px] font-semibold " +
                                  (p.status === "ok" ? "text-state-done" : p.status === "error" ? "text-state-off" : "text-ink-dim")
                                }
                              >
                                {p.status === "loading"
                                  ? "проверяем…"
                                  : p.status === "ok"
                                    ? `работает · ${p.count} ${p.count === 1 ? "товар" : p.count < 5 ? "товара" : "товаров"} · ${(p.ms / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} с`
                                    : p.message}
                              </span>
                            )}
                          </span>
                        }
                      />
                    </div>
                  );
                })}
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Button type="button" variant="secondary" onClick={check} disabled={checking}>
                  {checking ? "Проверяем…" : "Проверить магазины"}
                </Button>
                <span className="text-[12.5px] text-ink-dim">
                  Пробный поиск в каждом магазине: отвечает ли сайт и находит ли агент товары.
                </span>
              </div>
              <p className="mt-4 flex items-start gap-1.5 text-[12.5px] text-ink-dim">
                <IconExternal className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Нужен ещё магазин — владелец мастерской может прислать адрес сайта через «Обратную связь»: добавим в следующей версии.
              </p>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
