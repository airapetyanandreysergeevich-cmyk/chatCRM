import type { TableRow } from "../../data/tableFile";
import type { SqlTable } from "../sqlite";

/**
 * Перенос из чужой программы: общий вид того, что умеет каждая «программа-источник».
 *
 * Источник только читает чужие таблицы и раскладывает их по нашим — в тот же
 * вид, что у файлов из «Баз» (шапка + строки). Дальше всё идёт обычной
 * загрузкой: с проверкой строк, слиянием и нашими правилами. Писать напрямую
 * в базу источник не умеет нарочно.
 */

export interface MigrationStaff {
  /** Как сотрудник будет называться у нас — и как его найдут заказы в колонке «Мастер». */
  name: string;
  /** Часть логина до @: латиницей, из имени. */
  local: string;
  orders: number;
  lastAt: Date | null;
}

export interface MigrationPayment {
  /** Номер заказа у нас — такой же, как в файле заказов. */
  number: string;
  amount: number;
  at: Date;
  comment: string;
}

export interface MigrationHistory {
  number: string;
  /** Наш статус, по имени. */
  status: string;
  at: Date;
}

export interface Converted {
  source: { id: string; title: string };
  staff: MigrationStaff[];
  customers: TableRow[];
  stock: TableRow[];
  orders: TableRow[];
  /** Деньги, прошедшие в старой программе, — в отдельную кассу «Старая программа». */
  payments: MigrationPayment[];
  /** Предоплата по номеру заказа — полем заказа, как при обычном приёме. */
  prepayments: Map<string, number>;
  /** Предварительная стоимость по номеру заказа — полем заказа «Предварительно». */
  estimates: Map<string, number>;
  /** Пароль от устройства по номеру заказа — в своё поле, не в текст. */
  passcodes: Map<string, string>;
  history: MigrationHistory[];
  /** Самый большой номер заказа — чтобы продолжить нумерацию. */
  lastNumber: number | null;
  /** Цветная метка клиента по номеру: чёрный список старой программы — красным. */
  colors: Map<string, string>;
  /** Что сказать человеку до переноса: что склеено, что пропущено, что странно. */
  notes: string[];
}

export interface MigrationSource {
  id: string;
  /** Как назвать программу человеку. */
  title: string;
  /** Узнать свою базу по набору таблиц. */
  detect(tables: Record<string, SqlTable>): boolean;
  convert(tables: Record<string, SqlTable>): Converted;
}
