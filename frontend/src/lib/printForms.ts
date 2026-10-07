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
interface StoredDoc {
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
    intake: { ...doc(f.intake, "intake"), warrantyTitle: diff(f.warrantyTitle, DEFAULT_WARRANTY_TITLE) },
    act: doc(f.act, "act"),
    footer: clean(f.footer),
    stamp: f.stamp,
  };
}

export const printFormsApi = {
  get: async () => resolveForms(await api.get<PrintResponse>("/settings/print")),
  save: (f: PrintForms) => api.put<{ ok: true }>("/settings/print", toStored(f)),
};
