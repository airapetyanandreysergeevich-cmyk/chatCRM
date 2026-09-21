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
  // Без запятой: запятая разделяет пункты в строке, и «Документы, чек»
  // разваливался на два пункта — кнопка не подсвечивалась никогда.
  { key: "docs", label: "Документы и чек" },
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
  // Два признака, от которых зависит гарантия: раньше были отдельными
  // галочками под списком, теперь — такие же кнопки. Флаги заказа
  // hasOpenTraces и hasWaterDamage выводятся из списка, см. flagsOf.
  { key: "open_traces", label: "Следы вскрытия" },
  { key: "water", label: "Следы влаги" },
] as const;

export const OPEN_TRACES = "Следы вскрытия";
export const WATER_DAMAGE = "Следы влаги";

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

/**
 * Признаки вскрытия и влаги — из списка внешнего состояния.
 *
 * Флаги в заказе остались: по ним решается гарантия, и искать их удобнее
 * полем, чем текстом. Но вводятся они теперь кнопками в том же списке, что и
 * царапины, и источник у них один — этот список. Два места ввода для одного
 * факта однажды разошлись бы: «следы влаги» в списке и снятая галочка рядом.
 */
export function flagsOf(labels: string[]): { hasOpenTraces: boolean; hasWaterDamage: boolean } {
  const low = labels.map((l) => l.toLowerCase());
  return {
    hasOpenTraces: low.includes(OPEN_TRACES.toLowerCase()),
    hasWaterDamage: low.includes(WATER_DAMAGE.toLowerCase()),
  };
}

/**
 * Список состояния вместе с признаками старых заказов.
 *
 * У заказов, принятых до кнопок, признак стоит флагом, а в списке его нет.
 * Показываем его в списке — иначе карточка и квитанция молча потеряли бы
 * «следы вскрытия», а это ровно то, чем мастерская защищается от претензии.
 */
export function withFlags(
  labels: string[],
  flags: { hasOpenTraces?: boolean | null; hasWaterDamage?: boolean | null }
): string[] {
  const have = flagsOf(labels);
  const out = [...labels];
  if (flags.hasOpenTraces && !have.hasOpenTraces) out.push(OPEN_TRACES);
  if (flags.hasWaterDamage && !have.hasWaterDamage) out.push(WATER_DAMAGE);
  return out;
}

// ------------------------------------------------------ кнопки быстрого заполнения

/**
 * Кнопки комплектности и внешнего состояния на бланке приёма.
 *
 * Список выше — только стартовый: у каждой мастерской он свой, лежит в
 * таблице QuickPick и правится шестерёнкой прямо на бланке. Мастерская,
 * которая чинит телефоны, уберёт «Диск (HDD/SSD)» и добавит «Сим-лоток».
 */
export type QuickPickField = "completeness" | "appearance";
export const QUICK_PICK_FIELDS: readonly QuickPickField[] = ["completeness", "appearance"];

export const QUICK_PICK_DEFAULTS: Record<QuickPickField, readonly string[]> = {
  completeness: COMPLETENESS_ITEMS.map((i) => i.label),
  appearance: APPEARANCE_ITEMS.map((i) => i.label),
};

/**
 * Кнопки, которые нельзя удалить или переименовать.
 *
 * «Следы вскрытия» и «Следы влаги» не просто подпись: по ним заказ получает
 * флаги, которыми решается гарантия (см. flagsOf). Переименуй кнопку в
 * «Вскрывали» — и флаг перестанет ставиться, а узнают об этом в день спора с
 * клиентом. Порядок у них при этом общий: по частоте, как у остальных.
 */
export const LOCKED_PICKS: Record<QuickPickField, readonly string[]> = {
  completeness: [],
  appearance: [OPEN_TRACES, WATER_DAMAGE],
};

export const isLockedPick = (field: QuickPickField, label: string): boolean =>
  LOCKED_PICKS[field].some((l) => l.toLowerCase() === label.trim().toLowerCase());
