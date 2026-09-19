/**
 * Справочники бланка приёма. Пока константы: у мастерских они почти одинаковые,
 * а собственные списки заведём, когда кто-то попросит — лишняя настройка
 * на старте только мешает начать работать.
 */
export const DEVICE_KINDS = [
  "Ноутбук",
  "Компьютер",
  "Моноблок",
  "Монитор",
  "Принтер / МФУ",
  "Планшет",
  "Телефон",
  "Сетевое оборудование",
  "Прочее",
] as const;

/** Что сдали вместе с техникой. Спор о забытой зарядке решается этим списком. */
export const COMPLETENESS_ITEMS = [
  { key: "power", label: "Блок питания" },
  { key: "cable", label: "Кабель" },
  { key: "bag", label: "Сумка или чехол" },
  { key: "battery", label: "Батарея" },
  { key: "disk", label: "Диск (HDD/SSD)" },
  { key: "ram", label: "Оперативная память" },
  { key: "sim", label: "SIM-карта" },
  { key: "memory_card", label: "Карта памяти" },
  { key: "stylus", label: "Стилус или мышь" },
  { key: "docs", label: "Документы, чек" },
] as const;

/** Внешнее состояние фиксируется при приёме и защищает обе стороны. */
export const APPEARANCE_ITEMS = [
  { key: "scratches", label: "Царапины" },
  { key: "chips", label: "Сколы" },
  { key: "cracks", label: "Трещины" },
  { key: "dents", label: "Вмятины" },
  { key: "worn", label: "Потёртости" },
  { key: "screen_defect", label: "Дефекты экрана" },
  { key: "missing_parts", label: "Отсутствуют элементы корпуса" },
] as const;

export const ORDER_KINDS = [
  { value: "REPAIR", label: "Ремонт" },
  { value: "DIAGNOSTICS", label: "Диагностика" },
  { value: "WARRANTY", label: "Гарантийный возврат" },
  { value: "REPEAT", label: "Повторное обращение" },
] as const;

/**
 * Комплектность и внешнее состояние — список пунктов, записанный строкой.
 *
 * Раньше это был чек-лист: десять пунктов из справочника, у каждого «да» или
 * «нет». Список кнопок под полем от этого и остался — по ним отмечается то,
 * что встречается каждый день. Но приёмщику постоянно нужно дописать своё:
 * «царапина на крышке у петли», «блок питания чужой». В чек-листе для этого
 * места нет, и такое уезжало в «Прочее по состоянию» или не записывалось
 * вовсе — а потом спор с клиентом решать нечем.
 *
 * Поэтому значение — просто перечисление через запятую, хоть с кнопок, хоть
 * набранное руками. Разбор один на всех: бланк приёма, выгрузка в файл,
 * загрузка из файла и старые заказы приходят сюда.
 */

/** Сколько пунктов держим и какой длины. Дальше это не список, а сочинение. */
const MAX_ITEMS = 40;
const MAX_ITEM_LENGTH = 120;

/**
 * Список пунктов из чего угодно: из строки «А, Б», из массива строк или из
 * старого чек-листа вида [{ label, checked }].
 *
 * Старый вид разбираем не ради совместимости вообще, а потому что в базе
 * лежат тысячи принятых заказов, и переписывать их миграцией ради формата
 * значит рисковать данными приёмки — теми самыми, которыми решается спор о
 * забытой зарядке.
 */
export function toLabels(input: unknown): string[] {
  const raw: string[] = [];

  if (typeof input === "string") {
    raw.push(...input.split(","));
  } else if (Array.isArray(input)) {
    for (const v of input) {
      if (typeof v === "string") {
        raw.push(...v.split(","));
      } else if (v && typeof v === "object") {
        const item = v as { label?: unknown; checked?: unknown };
        if (item.checked && typeof item.label === "string") raw.push(item.label);
      }
    }
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of raw) {
    const value = piece.replace(/\s+/g, " ").trim().slice(0, MAX_ITEM_LENGTH);
    if (!value) continue;
    // Повторы убираем без учёта регистра: «Кабель» и «кабель» — один пункт,
    // и в квитанции он должен стоять один раз.
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

/** Обратно строкой — для квитанции, выгрузки и всего, что читает человек. */
export const labelsText = (input: unknown): string => toLabels(input).join(", ");
