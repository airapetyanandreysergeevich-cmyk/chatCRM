/**
 * Постраничная навигация под списком.
 *
 * Раньше списки просто обрывались на шестидесятой строке, и человек об этом
 * не знал: ни счётчика, ни намёка на продолжение. Мастерская с тремя тысячами
 * заказов видела шестьдесят и считала, что остальных нет.
 *
 * Поэтому здесь два сообщения, а не одно: сами страницы и строчка «показаны
 * 51–100 из 3214». Номера страниц без общего числа отвечают на вопрос «куда
 * идти», но не на вопрос «сколько всего», а именно он чаще и задаётся.
 */

/**
 * Какие номера показать.
 *
 * Всегда первая и последняя, соседи текущей и многоточия вместо пропусков.
 * Не «все подряд»: на шестидесяти страницах ряд номеров переносится на три
 * строки и перестаёт быть навигацией. И не «только вперёд-назад»: до конца
 * длинного списка иначе не добраться, а конец списка — это как раз самое
 * старое, куда и ходят.
 */
export function pageNumbers(page: number, pages: number, around = 1): Array<number | "…"> {
  if (pages <= 1) return [1];

  const wanted = new Set<number>([1, pages, page]);
  for (let i = 1; i <= around; i += 1) {
    if (page - i >= 1) wanted.add(page - i);
    if (page + i <= pages) wanted.add(page + i);
  }

  const sorted = [...wanted].sort((a, b) => a - b);
  const out: Array<number | "…"> = [];
  let prev = 0;
  for (const n of sorted) {
    // Многоточие ставим только за настоящий пропуск. Между 3 и 5 стоит 4, и
    // «3 … 5» вместо «3 4 5» — это не сокращение, а загадка.
    if (prev && n - prev > 1) out.push(n - prev === 2 ? prev + 1 : "…");
    out.push(n);
    prev = n;
  }
  return out;
}

export function Pager({
  page,
  pages,
  total,
  pageSize,
  onPage,
}: {
  page: number;
  pages: number;
  total: number;
  pageSize: number;
  onPage: (page: number) => void;
}) {
  // Одна страница — навигация не нужна, а вот сколько всего, знать полезно.
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  const button =
    "flex h-9 min-w-[36px] items-center justify-center rounded-field px-2.5 text-[13.5px] font-semibold " +
    "transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
      <p className="text-[13px] text-ink-dim">
        {total === 0 ? "Ничего не найдено" : `Показаны ${from}–${to} из ${total}`}
      </p>

      {pages > 1 && (
        <nav className="flex flex-wrap items-center gap-1" aria-label="Страницы">
          <button
            type="button"
            className={button + " text-ink-muted hover:bg-surface-raised hover:text-ink"}
            onClick={() => onPage(page - 1)}
            disabled={page <= 1}
            aria-label="Предыдущая страница"
          >
            ←
          </button>

          {pageNumbers(page, pages).map((n, i) =>
            n === "…" ? (
              <span key={`gap${i}`} className="px-1 text-[13.5px] text-ink-dim">
                …
              </span>
            ) : (
              <button
                key={n}
                type="button"
                aria-current={n === page ? "page" : undefined}
                className={
                  button +
                  (n === page
                    ? " bg-brand text-white"
                    : " text-ink-muted hover:bg-surface-raised hover:text-ink")
                }
                onClick={() => onPage(n)}
              >
                {n}
              </button>
            )
          )}

          <button
            type="button"
            className={button + " text-ink-muted hover:bg-surface-raised hover:text-ink"}
            onClick={() => onPage(page + 1)}
            disabled={page >= pages}
            aria-label="Следующая страница"
          >
            →
          </button>
        </nav>
      )}
    </div>
  );
}
