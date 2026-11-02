import type { RenderedSheet } from "../lib/blanks";

/**
 * Свой бланк из Excel на листе A4 (03.11.2026). Таблицу собирает сервер
 * (blanks/excel.ts → toHtml): ширины столбцов, высоты строк, объединения,
 * шрифты, рамки, заливка, картинки. Здесь — бумага вокруг неё: каждый лист
 * книги — своя страница, шире листа — уменьшается целиком, как «Вписать по
 * ширине» в Excel.
 *
 * HTML приходит от нашего же сервера и собран из ячеек с экранированием;
 * своих скриптов в нём нет.
 */

/** Ширина A4 без полей (210 − 2×12 мм) в пикселях при 96 dpi. */
const PRINT_W = Math.round(((210 - 24) / 25.4) * 96);
const PRINT_W_LAND = Math.round(((297 - 24) / 25.4) * 96);

const CSS = `
.xl-page table.xl { border-collapse: collapse; table-layout: fixed; font-family: Calibri, Carlito, "Segoe UI", Arial, sans-serif; font-size: 11pt; color: #000; }
.xl-page table.xl td { padding: 0 2px; line-height: 1.15; }
@media print { .xl-page { break-after: page; } .xl-page:last-child { break-after: auto; } }
`;

export function ExcelPages({ sheets, preview = false }: { sheets: RenderedSheet[]; preview?: boolean }) {
  return (
    <>
      <style>{CSS}</style>
      {sheets.map((s, i) => {
        const avail = s.landscape ? PRINT_W_LAND : PRINT_W;
        const zoom = Math.min(1, avail / Math.max(1, s.width));
        return (
          <div
            key={i}
            data-excel-sheet={s.name}
            className={
              "xl-page bg-white text-black " +
              (preview
                ? "p-[12mm]"
                : (s.landscape ? "w-[297mm]" : "w-[210mm]") +
                  " mx-auto my-6 max-w-full overflow-hidden p-[12mm] shadow-lg print:my-0 print:w-auto print:max-w-none print:p-0 print:shadow-none")
            }
          >
            <div style={{ zoom }} dangerouslySetInnerHTML={{ __html: s.html }} />
          </div>
        );
      })}
    </>
  );
}
