import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Banner, Button, Card, Input, PageHeader, SectionLabel } from "../components/ui";
import { IconClose } from "../components/icons";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";

/**
 * «Настройки → Приём техники» (27.10.2026). Пока здесь одно: авторизованные
 * бренды. Мастерская — авторизованный сервис ASUS, Lenovo…: для их техники
 * при приёме тип заказа выбирают явно — платный ремонт или гарантия
 * производителя. Для остальных брендов — «Платный ремонт» без вопросов.
 */
export default function IntakeSettings() {
  const { can } = useAuth();
  const mayEdit = can("settings.manage");
  const [brands, setBrands] = useState<string[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ brands: string[] }>("/settings/authorized-brands")
      .then((r) => setBrands(r.brands))
      .catch((e) => setError(e instanceof ApiError ? e.message : "Не удалось загрузить настройки"));
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  async function save(next: string[], done: string) {
    setBusy(true);
    setError(null);
    try {
      const r = await api.put<{ brands: string[] }>("/settings/authorized-brands", { brands: next });
      setBrands(r.brands);
      setNotice(done);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  function add(e: FormEvent) {
    e.preventDefault();
    const names = draft
      .split(/[,;\n]/)
      .map((b) => b.trim().replace(/\s+/g, " "))
      .filter(Boolean);
    if (!names.length || !brands) return;
    const have = new Set(brands.map((b) => b.toLocaleLowerCase("ru-RU")));
    const fresh = names.filter((b) => !have.has(b.toLocaleLowerCase("ru-RU")));
    setDraft("");
    if (!fresh.length) return setNotice("Такой бренд уже в списке");
    void save([...brands, ...fresh], fresh.length === 1 ? `«${fresh[0]}» добавлен` : `Добавлено: ${fresh.join(", ")}`);
  }

  return (
    <div className="space-y-5">
      <Link to="/settings" className="text-[13.5px] font-semibold text-ink-muted hover:text-ink">
        ‹ Настройки
      </Link>
      <PageHeader eyebrow="Настройки" title="Приём техники" subtitle="Как принимать технику: что спросить у приёмщика, чтобы потом не разбираться." />

      {error && <Banner tone="error">{error}</Banner>}
      {notice && <Banner>{notice}</Banner>}

      <Card>
        <SectionLabel>Авторизованные бренды</SectionLabel>
        <p className="mt-2 max-w-[760px] text-[13.5px] leading-relaxed text-ink-muted">
          Бренды, у которых мастерская — авторизованный сервис. Для их техники при приёме нужно выбрать тип заказа:{" "}
          <b className="text-ink-soft">платный ремонт</b> или <b className="text-ink-soft">гарантия производителя</b> — без выбора заказ не
          примется. Гарантийные заказы видны фиолетовой плашкой «гарантия ASUS» в списке, в таблице, на доске и в карточке.
        </p>

        {brands === null ? (
          <p className="mt-4 text-[13.5px] text-ink-dim">Загружаем…</p>
        ) : (
          <>
            <div className="mt-4 flex flex-wrap gap-2" data-brands>
              {brands.length === 0 && <p className="text-[13.5px] text-ink-dim">Пока ни одного — техника любого бренда принимается платным ремонтом.</p>}
              {brands.map((b) => (
                <span key={b} className="inline-flex h-9 items-center gap-1.5 rounded-pill border border-line bg-surface-input pl-3.5 pr-1.5 text-[13.5px] font-semibold" data-brand={b}>
                  {b}
                  {mayEdit && (
                    <button
                      type="button"
                      aria-label={`Убрать ${b}`}
                      disabled={busy}
                      onClick={() => void save(brands.filter((x) => x !== b), `«${b}» убран`)}
                      className="flex h-6 w-6 items-center justify-center rounded-full text-ink-dim hover:bg-surface-raised hover:text-state-off [&>svg]:h-3.5 [&>svg]:w-3.5"
                    >
                      <IconClose />
                    </button>
                  )}
                </span>
              ))}
            </div>
            {mayEdit && (
              <form onSubmit={add} className="mt-4 flex max-w-[520px] gap-2">
                <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="ASUS, Lenovo, Acer…" maxLength={200} data-brand-input />
                <Button type="submit" disabled={busy || !draft.trim()} data-brand-add>
                  Добавить
                </Button>
              </form>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
