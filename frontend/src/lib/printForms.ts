import { api } from "./api";

/**
 * Бланки на печать: что в них пишет мастерская.
 *
 * Здесь — стандартные тексты и сборка того, что мастерская поменяла, поверх
 * них. Сервер хранит только отличия (см. settings.routes.ts, «/print»):
 * поле, равное стандартному, не записывается, и улучшенная формулировка
 * доходит до всех, кто свою не задавал.
 *
 * Всё, что заполняет заказ, — клиент, техника, работы, суммы, даты, — сюда
 * не входит и не правится: это данные, а не оформление.
 */

export interface DocTexts {
  title: string;
  /** Условия приёма в квитанции, условия гарантии в акте. */
  body: string;
  signClient: string;
  signStaff: string;
  /** Размер текста условий, пт. */
  size: number;
  /** Межстрочный интервал текста условий. */
  leading: number;
}

/** Пределы настроек текста условий — те же, что проверяет сервер. */
export const TEXT_SIZE = { min: 8, max: 14, step: 0.5 };
export const TEXT_LEADING = { min: 1.1, max: 2, step: 0.05 };

export interface PrintForms {
  /** Логотип на бумаге. Отдельный от логотипа окна программы. */
  logo: string | null;
  /** Название в шапке. Пусто — название мастерской. */
  name: string | null;
  /** Реквизиты под названием: адрес, телефоны, ИНН, часы работы. Несколько строк. */
  requisites: string | null;
  intake: DocTexts;
  act: DocTexts;
  /** Заголовок квитанции при приёме по гарантии. */
  warrantyTitle: string;
  /** Строка внизу листа. Пусто — строки нет. */
  footer: string | null;
  /** «М.П.» у подписи мастерской — для тех, кто ставит печать. */
  stamp: boolean;
  /** Поля верха квитанции и акта (акт доплаты — как акт). */
  layout: { intake: SheetSection[]; act: SheetSection[] };
  /** Отрезной талон под квитанцией. */
  talon: Talon;
}

/**
 * Поля верха листа (30.10.2026, «конфигуратор бланков»): какие строки
 * печатать, в каком порядке, под какими названиями и свои поля мастерской.
 *
 * Разделы стоят на своих местах (слева — клиент и техника, справа —
 * комплектность, состояние, неисправность, деньги); их можно выключить и
 * переименовать. Внутри раздела «пары» строки включаются, переименовываются
 * и переставляются, а «+ Своё поле» добавляет строку с постоянным текстом
 * или пустой чертой — заполнить от руки.
 */
export type SectionKey = "client" | "device" | "completeness" | "appearance" | "complaint" | "money";

export interface SheetField {
  key: string;
  on: boolean;
  label: string;
  /** Только у своих полей: что печатать. Пусто — черта, заполнить от руки. */
  text: string | null;
  custom: boolean;
}

export interface SheetSection {
  key: SectionKey;
  on: boolean;
  title: string;
  /** Раздел-текст (комплектность, состояние, неисправность): строк у него нет. */
  block: boolean;
  fields: SheetField[];
}

/** Отрезной талон под квитанцией: клиент уносит его, по нему выдают технику. */
export interface Talon {
  on: boolean;
  title: string;
  note: string | null;
  fields: SheetField[];
}

export const FIELD_LABELS: Record<string, string> = {
  customer: "Клиент",
  phone: "Телефон",
  phone2: "Второй телефон",
  email: "Эл. почта",
  address: "Адрес",
  outsource: "Номер аутсорса",
  device: "Устройство",
  serial: "Серийный номер",
  passcode: "Пароль устройства",
  acceptedAt: "Принята",
  dueAt: "Срок готовности",
  completedAt: "Ремонт завершён",
  issuedAt: "Выдана клиенту",
  acceptedBy: "Принял",
  master: "Мастер",
  storage: "Место хранения",
  estimate: "Ориентировочная стоимость",
  limit: "Согласовано клиентом до",
  prepayment: "Предоплата",
  complaint: "Неисправность",
  sign: "Подпись приёмщика",
};

/** Пометка в настройках у строк, которые печатаются, только если в заказе заполнены. */
export const FIELD_HINTS: Record<string, string> = {
  phone2: "если есть",
  email: "если есть",
  address: "если есть",
  outsource: "только у заказов аутсорса",
  passcode: "если записан",
  acceptedBy: "",
  master: "если назначен",
  storage: "если указано",
};

/** Свои поля: ключ «x…», не больше стольких на раздел. */
export const CUSTOM_MAX = 10;
export const isCustomKey = (k: string) => /^x[a-z0-9]{1,20}$/.test(k);
export const newCustomKey = () => "x" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

type Def = [key: string, on: boolean];
type SectionDef = { key: SectionKey; title: string; block?: boolean; fields?: Def[] };

const LAYOUT_DEFS: Record<"intake" | "act", SectionDef[]> = {
  intake: [
    { key: "client", title: "Клиент", fields: [["customer", true], ["phone", true], ["phone2", false], ["email", false], ["address", false], ["outsource", true]] },
    {
      key: "device",
      title: "Техника",
      fields: [["device", true], ["serial", true], ["passcode", false], ["acceptedAt", true], ["dueAt", true], ["acceptedBy", false], ["master", false], ["storage", false]],
    },
    { key: "completeness", title: "Комплектность", block: true },
    { key: "appearance", title: "Внешнее состояние", block: true },
    { key: "complaint", title: "Неисправность со слов клиента", block: true },
    { key: "money", title: "Предварительно", fields: [["estimate", true], ["limit", true], ["prepayment", true]] },
  ],
  act: [
    { key: "client", title: "Клиент", fields: [["customer", true], ["phone", true], ["phone2", false], ["email", false], ["address", false], ["outsource", true]] },
    {
      key: "device",
      title: "Техника",
      fields: [["device", true], ["serial", true], ["acceptedAt", true], ["completedAt", true], ["issuedAt", true], ["acceptedBy", false], ["master", false], ["storage", false]],
    },
    { key: "complaint", title: "Заявленная неисправность", block: true },
  ],
};

const TALON_DEF: Def[] = [
  ["customer", true],
  ["phone", false],
  ["device", true],
  ["serial", false],
  ["acceptedAt", true],
  ["dueAt", true],
  ["complaint", false],
  ["sign", true],
];
export const DEFAULT_TALON_TITLE = "Талон на получение техники";

const builtin = ([key, on]: Def): SheetField => ({ key, on, label: FIELD_LABELS[key] ?? key, text: null, custom: false });

export function defaultLayout(kind: "intake" | "act"): SheetSection[] {
  return LAYOUT_DEFS[kind].map((d) => ({
    key: d.key,
    on: true,
    title: d.title,
    block: !!d.block,
    fields: (d.fields ?? []).map(builtin),
  }));
}

export function defaultTalon(): Talon {
  return { on: false, title: DEFAULT_TALON_TITLE, note: null, fields: TALON_DEF.map(builtin) };
}

export const DEFAULT_WARRANTY_TITLE = "Акт приема оборудования в ремонт по гарантии";

export const DEFAULT_TEXTS: { intake: DocTexts; act: DocTexts } = {
  intake: {
    title: "Квитанция о приёме техники",
    body:
      "Клиент подтверждает, что неисправность записана с его слов, комплектность и внешнее состояние " +
      "зафиксированы верно. Мастерская не отвечает за сохранность данных на носителях — их резервную копию " +
      "клиент делает самостоятельно. Срок готовности предварительный и может измениться после диагностики; " +
      "об изменении стоимости выше согласованной суммы мастерская сообщает до начала работ. Невостребованная " +
      "техника хранится не более шести месяцев с даты уведомления о готовности.",
    signClient: "Технику сдал, с условиями согласен (подпись клиента)",
    signStaff: "Технику принял",
    size: 9.5,
    leading: 1.45,
  },
  act: {
    title: "Акт выполненных работ",
    body:
      "Гарантия распространяется на выполненные работы и установленные запчасти. Она не действует при " +
      "механических повреждениях, попадании влаги и самостоятельном вскрытии после ремонта.",
    signClient: "Работы принял, претензий не имею (подпись клиента)",
    signStaff: "Работы сдал",
    size: 9.5,
    leading: 1.45,
  },
};

/** Как хранится на сервере: только то, что поменяли. */
interface StoredField {
  key: string;
  on: boolean;
  label?: string | null;
  text?: string | null;
}
interface StoredSection {
  on?: boolean;
  title?: string | null;
  fields?: StoredField[];
}
type StoredLayout = Partial<Record<SectionKey, StoredSection>>;
interface StoredTalon {
  on?: boolean;
  title?: string | null;
  note?: string | null;
  fields?: StoredField[];
}
interface StoredDoc {
  layout?: StoredLayout | null;
  talon?: StoredTalon | null;
  title?: string | null;
  warrantyTitle?: string | null;
  terms?: string | null;
  warranty?: string | null;
  signClient?: string | null;
  signStaff?: string | null;
  size?: number | null;
  leading?: number | null;
}
export interface StoredPrint {
  logo?: string | null;
  name?: string | null;
  requisites?: string | null;
  intake?: StoredDoc;
  act?: StoredDoc;
  footer?: string | null;
  stamp?: boolean;
}

interface PrintResponse {
  print: StoredPrint;
  fallback: { logo: string | null; requisites: string | null };
}

/**
 * Строки раздела из сохранённого: свои — как есть, стандартные — с
 * названием по умолчанию, если его не меняли. Стандартные, которых в
 * сохранённом нет (появились позже), — в конец, выключенными.
 */
function fieldsOf(stored: StoredField[] | undefined, defs: SheetField[]): SheetField[] {
  if (!Array.isArray(stored)) return defs.map((f) => ({ ...f }));
  const out: SheetField[] = [];
  const seen = new Set<string>();
  for (const f of stored) {
    if (!f || typeof f.key !== "string" || seen.has(f.key)) continue;
    const def = defs.find((d) => d.key === f.key);
    if (def) {
      out.push({ ...def, on: f.on !== false, label: clean(f.label) ?? def.label });
    } else if (isCustomKey(f.key)) {
      out.push({ key: f.key, on: f.on !== false, label: clean(f.label) ?? "Своё поле", text: clean(f.text), custom: true });
    } else continue;
    seen.add(f.key);
  }
  // Настроенный раздел не меняется сам: новая стандартная строка приходит выключенной.
  for (const d of defs) if (!seen.has(d.key)) out.push({ ...d, on: false });
  return out;
}

function layoutOf(stored: StoredLayout | null | undefined, kind: "intake" | "act"): SheetSection[] {
  return defaultLayout(kind).map((d) => {
    const s = stored?.[d.key];
    return {
      ...d,
      on: s?.on !== false,
      title: clean(s?.title) ?? d.title,
      fields: d.block ? [] : fieldsOf(s?.fields, d.fields),
    };
  });
}

function talonOf(stored: StoredTalon | null | undefined): Talon {
  const d = defaultTalon();
  return {
    on: stored?.on === true,
    title: clean(stored?.title) ?? d.title,
    note: clean(stored?.note),
    fields: fieldsOf(stored?.fields, d.fields),
  };
}

/** Строки к хранению: null — как по умолчанию. */
function storeFields(fields: SheetField[], defs: SheetField[]): StoredField[] | undefined {
  const same =
    fields.length === defs.length &&
    fields.every((f, i) => f.key === defs[i].key && f.on === defs[i].on && f.label.trim() === defs[i].label);
  if (same) return undefined;
  return fields.map((f) => {
    const def = defs.find((d) => d.key === f.key);
    const label = f.label.trim();
    return f.custom
      ? { key: f.key, on: f.on, label: label || null, text: f.text?.trim() || null }
      : { key: f.key, on: f.on, label: def && label !== def.label && label ? label : null };
  });
}

function storeLayout(layout: SheetSection[], kind: "intake" | "act"): StoredLayout | null {
  const out: StoredLayout = {};
  for (const d of defaultLayout(kind)) {
    const s = layout.find((x) => x.key === d.key);
    if (!s) continue;
    const item: StoredSection = {};
    if (!s.on) item.on = false;
    const t = s.title.trim();
    if (t && t !== d.title) item.title = t;
    const fields = d.block ? undefined : storeFields(s.fields, d.fields);
    if (fields) item.fields = fields;
    if (Object.keys(item).length) out[d.key] = item;
  }
  return Object.keys(out).length ? out : null;
}

function storeTalon(t: Talon): StoredTalon | null {
  const d = defaultTalon();
  const out: StoredTalon = {};
  if (t.on) out.on = true;
  const title = t.title.trim();
  if (title && title !== d.title) out.title = title;
  if (t.note?.trim()) out.note = t.note.trim();
  const fields = storeFields(t.fields, d.fields);
  if (fields) out.fields = fields;
  return Object.keys(out).length ? out : null;
}

const clean = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Число в пределах, иначе — стандартное. */
const within = (v: unknown, min: number, max: number, d: number) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : d;

function docOf(stored: StoredDoc | undefined, key: "intake" | "act"): DocTexts {
  const d = DEFAULT_TEXTS[key];
  const bodyKey = key === "intake" ? "terms" : "warranty";
  return {
    title: clean(stored?.title) ?? d.title,
    body: clean(stored?.[bodyKey]) ?? d.body,
    signClient: clean(stored?.signClient) ?? d.signClient,
    signStaff: clean(stored?.signStaff) ?? d.signStaff,
    size: within(stored?.size, TEXT_SIZE.min, TEXT_SIZE.max, d.size),
    leading: within(stored?.leading, TEXT_LEADING.min, TEXT_LEADING.max, d.leading),
  };
}

/** Что печатать: сохранённое поверх стандартного. */
export function resolveForms({ print, fallback }: PrintResponse): PrintForms {
  const p = print ?? {};
  return {
    // Ключа нет — бланки не настраивали: как раньше, логотип интерфейса.
    logo: "logo" in p ? (p.logo ?? null) : fallback.logo,
    name: clean(p.name),
    requisites: "requisites" in p ? clean(p.requisites) : clean(fallback.requisites),
    intake: docOf(p.intake, "intake"),
    act: docOf(p.act, "act"),
    warrantyTitle: clean(p.intake?.warrantyTitle) ?? DEFAULT_WARRANTY_TITLE,
    footer: clean(p.footer),
    stamp: p.stamp === true,
    layout: { intake: layoutOf(p.intake?.layout, "intake"), act: layoutOf(p.act?.layout, "act") },
    talon: talonOf(p.intake?.talon),
  };
}

/** Обратно — к хранению: стандартное не пишем. */
export function toStored(f: PrintForms): StoredPrint {
  const diff = (v: string, d: string) => {
    const t = v.trim();
    return t && t !== d ? t : null;
  };
  const doc = (x: DocTexts, key: "intake" | "act"): StoredDoc => {
    const d = DEFAULT_TEXTS[key];
    return {
      title: diff(x.title, d.title),
      [key === "intake" ? "terms" : "warranty"]: diff(x.body, d.body),
      signClient: diff(x.signClient, d.signClient),
      signStaff: diff(x.signStaff, d.signStaff),
      size: x.size === d.size ? null : Math.round(x.size * 2) / 2,
      leading: x.leading === d.leading ? null : Math.round(x.leading * 100) / 100,
    };
  };
  return {
    logo: f.logo,
    name: clean(f.name),
    requisites: clean(f.requisites),
    intake: {
      ...doc(f.intake, "intake"),
      warrantyTitle: diff(f.warrantyTitle, DEFAULT_WARRANTY_TITLE),
      layout: storeLayout(f.layout.intake, "intake"),
      talon: storeTalon(f.talon),
    },
    act: { ...doc(f.act, "act"), layout: storeLayout(f.layout.act, "act") },
    footer: clean(f.footer),
    stamp: f.stamp,
  };
}

export const printFormsApi = {
  get: async () => resolveForms(await api.get<PrintResponse>("/settings/print")),
  save: (f: PrintForms) => api.put<{ ok: true }>("/settings/print", toStored(f)),
};
