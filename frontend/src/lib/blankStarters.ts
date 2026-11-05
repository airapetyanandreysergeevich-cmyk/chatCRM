import { DEFAULT_STROKE, DEFAULT_TEXT, emptyDesign, newId, type BlankDesign, type BlankEl, type TableCol, type TableEl, type TableSource, type TextEl, type TextStyle } from "./blankModel";
import { COL_LABEL, COLS_OF } from "./blankData";
import type { PrintForms, SheetField, SheetSection } from "./printForms";

/**
 * «Взять стандартный» (05.11.2026): нынешние квитанция, акт, акт доплаты и
 * товарный чек, разложенные на элементы редактора. Строки верха листа — как
 * настроены в «Бланках» (включённые, с их названиями и своими полями),
 * тексты условий и подписи — оттуда же. Дальше мастерская правит на листе.
 */

export type Starter = "intake" | "act" | "extra" | "sale" | "empty";
export const STARTERS: Array<{ key: Starter; label: string; target: "order" | "sale" }> = [
  { key: "intake", label: "Квитанция о приёме", target: "order" },
  { key: "act", label: "Акт выполненных работ", target: "order" },
  { key: "extra", label: "Акт доплаты", target: "order" },
  { key: "sale", label: "Товарный чек", target: "sale" },
  { key: "empty", label: "Пустой лист", target: "order" },
];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const multiline = (s: string) => esc(s).replace(/\n/g, "<br>");
const f = (key: string) => `<span data-f="${key}"></span>`;

export const text = (x: number, y: number, w: number, h: number, html: string, st: Partial<TextStyle> = {}, more: Partial<TextEl> = {}): TextEl => ({
  id: newId(),
  type: "text",
  x,
  y,
  w,
  h,
  html,
  st: { ...DEFAULT_TEXT, ...st },
  grow: false,
  hideEmpty: true,
  ...more,
});

export const hline = (x: number, y: number, w: number, width = 0.3, more: Partial<Extract<BlankEl, { type: "line" }>> = {}): BlankEl => ({
  id: newId(),
  type: "line",
  x,
  y: y - 1,
  w,
  h: 2,
  dir: "h",
  stroke: { ...DEFAULT_STROKE, w: width },
  cut: false,
  ...more,
});

export function table(x: number, y: number, w: number, source: TableSource, more: Partial<TableEl> = {}): TableEl {
  const keys = COLS_OF[source];
  const fixed: Record<string, number> = { no: 8, sku: 24, qty: 16, price: 24, sum: 26, warranty: 22 };
  const rest = w - keys.reduce((a, k) => a + (k === "name" ? 0 : fixed[k]), 0);
  const cols: TableCol[] = keys.map((k) => ({
    key: k,
    title: k === "name" ? (source === "items" ? "Товар" : "Наименование") : COL_LABEL[k],
    w: k === "name" ? Math.max(30, rest) : fixed[k],
    align: k === "name" || k === "sku" ? "left" : k === "no" ? "center" : "right",
  }));
  return {
    id: newId(),
    type: "table",
    x,
    y,
    w,
    h: 12,
    source,
    cols,
    st: { font: "pt-sans", size: 9.5, color: "#000000", grid: "rows", headBold: true, headFill: null, pad: 1.2 },
    total: false,
    totalLabel: "Итого",
    emptyText: "Нет",
    ...more,
  };
}

/** Ключ строки «Бланков» → поле редактора. */
const KEY: Record<string, string> = {
  customer: "customer",
  phone: "phone",
  phone2: "phone2",
  email: "email",
  address: "address",
  outsource: "outsource",
  device: "device",
  serial: "serial",
  passcode: "passcode",
  acceptedAt: "acceptedTime",
  dueAt: "dueAt",
  completedAt: "completedAt",
  issuedAt: "issuedTime",
  acceptedBy: "acceptedBy",
  master: "master",
  storage: "storage",
  estimate: "estimate",
  limit: "limit",
  prepayment: "prepayment",
  complaint: "complaint",
};

const head = (title: string) => `<div style="font-size: 8pt; color: #555555"><b>${esc(title.toUpperCase())}</b></div>`;
const pair = (label: string, html: string) => `<div><span style="color: #555555">${esc(label)}:</span> ${html}</div>`;
/** Подпись с полем внутри («Товаров, [N] шт.»). */
const pairHtml = (labelHtml: string, html: string) => `<div><span style="color: #555555">${labelHtml}:</span> ${html}</div>`;

function fieldRows(fields: SheetField[]): string {
  return fields
    .filter((x) => x.on && x.key !== "sign")
    .map((x) => (x.custom ? pair(x.label, x.text ? multiline(x.text) : "______________________") : KEY[x.key] ? pair(x.label, f(KEY[x.key])) : ""))
    .join("");
}

function sectionHtml(s: SheetSection): string {
  if (!s.on) return "";
  if (s.block) {
    const key = s.key === "completeness" ? "completeness" : s.key === "appearance" ? "appearance" : "complaint";
    return head(s.title) + `<div>${f(key)}</div>`;
  }
  const rows = fieldRows(s.fields);
  return rows ? head(s.title) + rows : "";
}

/** Шапка: логотип, название и реквизиты слева; заголовок, номер и дата справа. */
function header(forms: PrintForms, title: string, dateHtml: string): BlankEl[] {
  const els: BlankEl[] = [];
  const left = forms.logo ? 44 : 10;
  if (forms.logo) els.push({ id: newId(), type: "image", x: 10, y: 10, w: 30, h: 16, src: "logo", fit: "contain" });
  els.push(text(left, 10, 106 - left, 7, `<b>${f("workshop")}</b>`, { size: 14, leading: 1.15 }));
  els.push(text(left, 17.5, 106 - left, 11, f("requisites"), { size: 8.5, color: "#555555", leading: 1.25 }));
  els.push(text(110, 10, 90, 6, `<b>${esc(title)}</b>`, { size: 11, align: "right" }));
  els.push(text(110, 16, 90, 7, `<b>${f("number")}</b>`, { size: 14, align: "right", font: "pt-mono" }));
  els.push(text(110, 23, 90, 5, dateHtml, { size: 8.5, align: "right", color: "#555555" }));
  els.push(hline(10, 31, 190, 0.5));
  return els;
}

function terms(y: number, title: string, body: string, size: number, leading: number): BlankEl {
  return text(10, y, 190, 20, head(title) + `<div style="color: #222222">${multiline(body)}</div>`, { size, leading, pad: 3, border: { ...DEFAULT_STROKE, w: 0.25, color: "#999999", sides: "all" } }, { grow: true });
}

function signs(y: number, client: string, staff: string, stamp: boolean): BlankEl[] {
  const els: BlankEl[] = [
    hline(10, y, 85),
    text(10, y + 1, 85, 5, esc(client), { size: 8, color: "#555555" }),
    hline(115, y, 85),
    text(115, y + 1, 85, 5, esc(staff), { size: 8, color: "#555555" }),
  ];
  if (stamp) els.push(text(115, y + 8, 30, 5, "<b>М.П.</b>", { size: 9, color: "#444444" }));
  return els;
}

function footer(forms: PrintForms, y: number): BlankEl[] {
  return forms.footer ? [text(10, y, 190, 5, f("footer"), { size: 8.5, color: "#555555", align: "center" })] : [];
}

export function starterDesign(kind: Starter, forms: PrintForms): BlankDesign {
  const d = emptyDesign();
  if (kind === "empty") return d;

  if (kind === "intake") {
    const lay = forms.layout.intake;
    const left = lay.filter((s) => s.key === "client" || s.key === "device").map(sectionHtml).join("");
    const right = lay.filter((s) => s.key !== "client" && s.key !== "device").map(sectionHtml).join("");
    d.els.push(
      ...header(forms, forms.intake.title, `от ${f("acceptedAt")}`),
      text(10, 35, 92, 46, left, { size: 10, leading: 1.4 }, { grow: true }),
      text(108, 35, 92, 46, right, { size: 10, leading: 1.4 }, { grow: true }),
      terms(86, "Условия", forms.intake.body, forms.intake.size, forms.intake.leading),
      ...signs(128, forms.intake.signClient, forms.intake.signStaff, forms.stamp),
      ...footer(forms, 143)
    );
    if (forms.talon.on) {
      const t = forms.talon;
      const sign = t.fields.find((x) => x.key === "sign" && x.on);
      d.els.push(
        hline(10, 156, 190, 0.3, { cut: true, stroke: { ...DEFAULT_STROKE, style: "dashed", color: "#555555" } }),
        text(10, 161, 80, 6, `<b>${f("workshop")}</b>`, { size: 12 }),
        text(10, 167, 80, 6, `<b>${esc(t.title)}</b>`, { size: 10 }),
        text(10, 173, 80, 7, `<b>${f("number")}</b>`, { size: 14, font: "pt-mono" }),
        ...(t.note ? [text(10, 181, 80, 12, multiline(t.note), { size: 8.5, color: "#444444" })] : []),
        text(100, 161, 100, 26, fieldRows(t.fields), { size: 9.5, leading: 1.35 }, { grow: true }),
        ...(sign ? [hline(100, 196, 100), text(100, 197, 100, 5, esc(sign.label), { size: 8, color: "#555555" })] : [])
      );
    }
    return d;
  }

  if (kind === "act" || kind === "extra") {
    const lay = forms.layout.act;
    const left = lay.filter((s) => s.key === "client" || s.key === "device").map(sectionHtml).join("");
    const right =
      (kind === "extra" ? head("Повторное обращение") + `<div>${f("extraReason")}</div>` : "") + lay.filter((s) => s.key !== "client" && s.key !== "device").map(sectionHtml).join("");
    const title = kind === "extra" ? "Акт доплаты" : forms.act.title;
    const dateHtml = kind === "extra" ? `от ${f("issuedAt")}<br>к выдаче от ${f("extraPrev")}` : `от ${f("issuedAt")}`;
    d.els.push(...header(forms, title, dateHtml));
    if (kind === "extra") d.els[d.els.length - 2].h = 9;
    d.els.push(text(10, 35, 92, 50, left, { size: 10, leading: 1.4 }, { grow: true }), text(108, 35, 92, 50, right, { size: 10, leading: 1.4 }, { grow: true }));
    if (kind === "act") {
      d.els.push(text(10, 88, 190, 5, head("Выполненные работы и запчасти"), { size: 10 }), table(10, 94, 190, "lines"));
    } else {
      d.els.push(
        text(10, 88, 190, 5, head("Дополнительно выполненные работы"), { size: 10 }),
        table(10, 94, 190, "extraWorks"),
        text(10, 110, 190, 5, head("Дополнительные запчасти и материалы"), { size: 10 }),
        table(10, 116, 190, "extraParts")
      );
    }
    const y = kind === "act" ? 110 : 132;
    d.els.push(
      text(10, y, 100, 18, head("Гарантия") + pair("На работы", `${f("warranty")} — до ${f("warrantyUntil")}`) + pair("Мастер", f("master")) + (kind === "act" ? pair("Рекомендации", f("recommendation")) : ""), { size: 10, leading: 1.4 }, { grow: true }),
      kind === "act"
        ? text(120, y, 80, 30, pair("Работы", f("totalWork")) + pair("Скидка на работы", f("workDiscount")) + pair("Запчасти", f("totalParts")) + pair("Скидка при выдаче", f("discount")) + pair("Предоплата", f("prepayment")) + `<div style="font-size: 12pt"><b>К оплате: ${f("toPay")}</b></div>` + `<div style="font-size: 8.5pt; color: #444444">Оплата: ${f("payment")}</div>`, { size: 10, leading: 1.4, align: "right" }, { grow: true })
        : text(120, y, 80, 20, pair(`По выдаче`, f("extraBefore")) + pair("Итого по заказу", f("total")) + `<div style="font-size: 12pt"><b>К доплате: ${f("extraAmount")}</b></div>`, { size: 10, leading: 1.4, align: "right" }, { grow: true }),
      terms(y + 40, "Условия гарантии", forms.act.body, forms.act.size, forms.act.leading),
      ...signs(y + 72, forms.act.signClient, forms.act.signStaff, forms.stamp),
      ...footer(forms, y + 87)
    );
    return d;
  }

  // товарный чек
  d.els.push(
    ...header(forms, "Товарный чек", `от ${f("date")}`),
    text(10, 35, 190, 6, pair("Покупатель", `<b>${f("customer")}</b>`), { size: 10 }),
    table(10, 42, 190, "items", { total: false }),
    text(120, 58, 80, 24, pairHtml(`Товаров, ${f("units")} шт.`, f("subtotal")) + pair("Скидка", f("discount")) + `<div style="font-size: 13pt"><b>Итого: ${f("total")}</b></div>` + `<div style="font-size: 8.5pt; color: #444444">Оплата: ${f("payment")}</div>`, { size: 10, leading: 1.4, align: "right" }, { grow: true }),
    text(10, 86, 190, 6, `<span style="color: #555555">Гарантия:</span> ${f("warranty")}, до <b>${f("warrantyUntil")}</b>. Гарантия действует при сохранении этого чека.`, { size: 9.5 }, { grow: true }),
    text(10, 93, 190, 6, `<b>${f("returned")}</b>`, { size: 9.5 }),
    ...signs(112, "Продавец", "Покупатель: товар получил, претензий нет", forms.stamp),
    ...footer(forms, 126)
  );
  return d;
}
