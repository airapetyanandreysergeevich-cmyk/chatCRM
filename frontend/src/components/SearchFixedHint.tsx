/**
 * «Показаны результаты для «ноутбук»» — как в Яндексе.
 *
 * Появляется, когда по набранному не нашлось ничего, а в другой раскладке
 * нашлось. Ссылка рядом — на случай, когда человек и правда искал «yjen,er».
 */
export function SearchFixedHint({ fixed, onExact }: { fixed: string | null | undefined; onExact: () => void }) {
  if (!fixed) return null;
  return (
    <p className="px-1 text-[13.5px] text-ink-muted">
      Показаны результаты для «<span className="font-semibold text-ink">{fixed}</span>» — набрано в другой раскладке.{" "}
      <button type="button" onClick={onExact} className="font-semibold text-brand-ink underline-offset-2 hover:underline">
        Искать как набрано
      </button>
    </p>
  );
}
