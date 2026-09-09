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

export interface ChecklistValue {
  key: string;
  label: string;
  checked: boolean;
}

/**
 * Приводим присланное с фронтенда к справочнику: чужие ключи в базу не попадают,
 * а подпись пункта сохраняется вместе со значением — если справочник потом
 * поменяют, старый заказ останется читаемым.
 */
export function normalizeChecklist(
  input: unknown,
  dictionary: ReadonlyArray<{ key: string; label: string }>
): ChecklistValue[] {
  const checked = new Set(
    Array.isArray(input)
      ? input
          .map((v) => (typeof v === "string" ? v : (v as { key?: unknown })?.key))
          .filter((v): v is string => typeof v === "string")
      : []
  );
  return dictionary.map((d) => ({ key: d.key, label: d.label, checked: checked.has(d.key) }));
}
