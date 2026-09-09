/**
 * Описание таблиц для выгрузки и загрузки.
 *
 * Одно описание на оба направления — иначе выгруженный файл однажды перестанет
 * загружаться обратно, и заметит это клиент, а не мы. Заголовки по-русски:
 * файл открывают в Excel живые люди, а не программа.
 */

export type DatasetKey = "customers" | "orders" | "stock";

export interface ColumnDef {
  /** Заголовок в файле. По нему же колонка узнаётся при загрузке. */
  title: string;
  /** Другие написания заголовка, которые встречаются в чужих выгрузках. */
  aliases?: string[];
  width?: number;
  /** Колонка обязательна при загрузке. */
  required?: boolean;
  /** Только для выгрузки: обратно не загружается (вычисляемое поле). */
  readOnly?: boolean;
  kind?: "text" | "number" | "date" | "phone";
}

export interface DatasetDef {
  key: DatasetKey;
  title: string;
  /** Как называется лист в книге xlsx и файл при выгрузке. */
  sheet: string;
  hint: string;
  /** По какой колонке узнаём, что запись уже есть. */
  matchBy: string;
  columns: ColumnDef[];
  /** Загрузка этой таблицы пока не поддержана — только выгрузка. */
  exportOnly?: boolean;
}

export const DATASETS: Record<DatasetKey, DatasetDef> = {
  customers: {
    key: "customers",
    title: "Клиенты и их техника",
    sheet: "Клиенты",
    hint: "Одна строка — один клиент. Техника перечисляется в отдельной колонке через точку с запятой.",
    matchBy: "Телефон",
    columns: [
      { title: "Тип", aliases: ["Тип клиента"], width: 12, kind: "text" },
      { title: "Имя", aliases: ["ФИО", "Название", "Клиент"], width: 28, required: true },
      { title: "Телефон", aliases: ["Тел", "Телефон основной"], width: 18, required: true, kind: "phone" },
      { title: "Ещё телефон", aliases: ["Телефон 2", "Доп. телефон"], width: 18, kind: "phone" },
      { title: "Email", aliases: ["Почта", "E-mail"], width: 24 },
      { title: "Адрес", width: 32 },
      { title: "ИНН", width: 14 },
      { title: "Источник", aliases: ["Откуда узнал"], width: 18 },
      { title: "Скидка, %", aliases: ["Скидка"], width: 11, kind: "number" },
      { title: "Примечание", aliases: ["Комментарий"], width: 30 },
      {
        title: "Техника",
        aliases: ["Устройства"],
        width: 40,
        // «ноутбук Lenovo IdeaPad 5 (PF2XK9LM); ПК HP»
        // Разбирается обратно, поэтому формат держим простым и предсказуемым.
      },
      { title: "Заказов", width: 10, readOnly: true, kind: "number" },
      { title: "Заведён", width: 18, readOnly: true, kind: "date" },
    ],
  },

  orders: {
    key: "orders",
    title: "Заказы",
    sheet: "Заказы",
    hint: "Одна строка — один заказ. Клиент и техника ищутся по телефону и серийному номеру; если их нет, заводятся.",
    matchBy: "Номер",
    columns: [
      { title: "Номер", aliases: ["№", "Номер заказа"], width: 18, required: true },
      { title: "Принят", aliases: ["Дата приёма"], width: 18, kind: "date" },
      { title: "Статус", width: 20 },
      { title: "Тип обращения", aliases: ["Тип"], width: 20 },
      { title: "Срочный", width: 10 },
      { title: "Клиент", aliases: ["Имя клиента"], width: 26, required: true },
      { title: "Телефон клиента", aliases: ["Телефон"], width: 18, required: true, kind: "phone" },
      { title: "Техника", aliases: ["Тип техники"], width: 16 },
      { title: "Бренд", width: 16 },
      { title: "Модель", width: 20 },
      { title: "Серийный номер", aliases: ["S/N", "Серийник"], width: 20 },
      { title: "Неисправность", aliases: ["Жалоба", "Со слов клиента"], width: 40, required: true },
      { title: "Примечание приёмщика", width: 30 },
      { title: "Диагноз", width: 34 },
      { title: "Мастер", width: 24 },
      { title: "Срок готовности", width: 18, kind: "date" },
      { title: "Завершён", width: 18, kind: "date" },
      { title: "Выдан", width: 18, kind: "date" },
      { title: "Работы, ₽", aliases: ["Сумма работ"], width: 13, kind: "number" },
      { title: "Запчасти, ₽", aliases: ["Сумма запчастей"], width: 13, kind: "number" },
      { title: "Скидка, ₽", width: 12, kind: "number" },
      { title: "Итого, ₽", aliases: ["Сумма"], width: 13, kind: "number" },
      { title: "Гарантия до", width: 18, kind: "date" },
    ],
  },

  stock: {
    key: "stock",
    title: "Склад",
    sheet: "Склад",
    hint: "Номенклатура и остатки. Слияние по артикулу, а если его нет — по названию.",
    matchBy: "Артикул",
    columns: [
      { title: "Артикул", aliases: ["SKU", "Код"], width: 18 },
      { title: "Наименование", aliases: ["Название", "Товар"], width: 40, required: true },
      { title: "Категория", width: 20 },
      { title: "Единица", aliases: ["Ед. изм.", "Ед"], width: 10 },
      { title: "Остаток", aliases: ["Количество", "Кол-во"], width: 12, kind: "number" },
      { title: "Себестоимость, ₽", aliases: ["Цена закупки", "Себестоимость"], width: 18, kind: "number" },
      { title: "Минимальный остаток", aliases: ["Мин. остаток"], width: 20, kind: "number" },
      { title: "Склад", aliases: ["Название склада"], width: 20 },
    ],
  },
};

export const DATASET_KEYS = Object.keys(DATASETS) as DatasetKey[];

export const isDatasetKey = (v: string): v is DatasetKey => v in DATASETS;

/**
 * Заголовок из файла → наша колонка. Сравниваем без учёта регистра, пробелов
 * и буквы ё: в чужих выгрузках заголовки пишут как придётся, и требовать
 * точного совпадения — значит отказывать людям без причины.
 */
export const normalizeHeader = (s: unknown): string =>
  String(s ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[\s._-]+/g, "")
    .trim();

export function matchColumns(headers: unknown[], def: DatasetDef): Map<number, ColumnDef> {
  const byName = new Map<string, ColumnDef>();
  for (const col of def.columns) {
    byName.set(normalizeHeader(col.title), col);
    for (const alias of col.aliases ?? []) byName.set(normalizeHeader(alias), col);
  }

  const found = new Map<number, ColumnDef>();
  headers.forEach((h, i) => {
    const col = byName.get(normalizeHeader(h));
    if (col && !col.readOnly) found.set(i, col);
  });
  return found;
}
