import { z } from "zod";

/**
 * Наклейки на технику: что на них печатать и какого они размера.
 *
 * Настройка одна на мастерскую — Tenant.settings.labels. Наклейку видят все,
 * кто сдаёт и выдаёт технику, и она должна быть одинаковой на любом
 * компьютере: какой принтер печатает, решает назначение (см. printing.routes),
 * а что на ней — эта настройка.
 *
 * Размер — в миллиметрах, как написано на рулоне: ширина — поперёк рулона,
 * высота — вдоль. «Повернуть» нужен, когда этикетка идёт в принтер узкой
 * стороной вперёд, а текст хочется вдоль длинной.
 */

export const LABEL_FIELDS = [
  "logo",
  "workshop",
  "number",
  "item",
  "client",
  "phone",
  "device",
  "serial",
  "complaint",
  "date",
  "due",
] as const;
export type LabelField = (typeof LABEL_FIELDS)[number];

const size = z.number().min(15).max(150);

/**
 * Свой макет: элементы наклейки и их места в миллиметрах — внутри
 * содержимого (с «Повернуть» — уже повёрнутого). Размер шрифта — в пунктах.
 * w и h у самого макета — размер, под который он нарисован: сменили
 * этикетку — макет масштабируется (frontend lib/labelLayout.ts).
 */
export const LAYOUT_KINDS = [
  "logo",
  "workshop",
  "number",
  "counter",
  "item",
  "client",
  "phone",
  "device",
  "serial",
  "complaint",
  "date",
  "due",
  "code",
] as const;

const coord = z.number().min(-10).max(160);
export const layoutSchema = z.object({
  w: size,
  h: size,
  elements: z
    .array(
      z.object({
        kind: z.enum(LAYOUT_KINDS),
        x: coord,
        y: coord,
        w: z.number().min(0.5).max(160),
        h: z.number().min(0.5).max(160),
        size: z.number().min(3).max(72).optional(),
        bold: z.boolean().optional(),
        align: z.enum(["left", "center", "right"]).optional(),
        lines: z.number().int().min(1).max(3).optional(),
        upper: z.boolean().optional(),
      })
    )
    .max(LAYOUT_KINDS.length)
    // Каждый элемент — один раз: два «номера» на наклейке — это ошибка, а не замысел.
    .transform((els) => els.filter((e, i) => els.findIndex((x) => x.kind === e.kind) === i)),
});
export type LabelLayout = z.infer<typeof layoutSchema>;

/** Сама наклейка: размер, код, что на ней и как расставлено. Из таких состоят шаблоны. */
const templateBody = {
  width: size,
  height: size,
  rotate: z.boolean(),
  code: z.enum(["code128", "qr"]),
  fields: z.object(Object.fromEntries(LABEL_FIELDS.map((f) => [f, z.boolean()])) as Record<LabelField, z.ZodBoolean>),
  /** Компоновка: автоматическая или свой макет (layout). */
  mode: z.enum(["auto", "custom"]).default("auto"),
  layout: layoutSchema.nullable().default(null),
};

export const MAX_TEMPLATES = 6;

export const templateSchema = z.object({
  id: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1, "Назовите шаблон").max(40),
  ...templateBody,
});
export type LabelTemplate = z.infer<typeof templateSchema>;

/** Настройка одной наклейки — для рисования и печати: основной (или выбранный) шаблон + общие «вещи из комплекта». */
export const labelSettingsSchema = z.object({
  ...templateBody,
  /** Пункты комплектности, на которые печатается своя наклейка: «Блок питания», «Сумка или чехол». */
  perItem: z.array(z.string().trim().min(1).max(60)).max(40),
});
export type LabelSettings = z.infer<typeof labelSettingsSchema>;

/**
 * Что хранится: шаблоны (до шести, с названиями — «Основной», «Маленькая на
 * зарядку»), какой из них основной и общий список вещей со своей наклейкой.
 * Основной печатается сам после приёма; в окне «Наклейки» можно выбрать другой.
 */
export const labelsConfigSchema = z
  .object({
    perItem: labelSettingsSchema.shape.perItem,
    templates: z.array(templateSchema).min(1).max(MAX_TEMPLATES),
    main: z.string(),
  })
  .superRefine((c, ctx) => {
    if (!c.templates.some((t) => t.id === c.main)) ctx.addIssue({ code: "custom", path: ["main"], message: "Основной шаблон не найден" });
    const ids = new Set<string>();
    const names = new Set<string>();
    c.templates.forEach((t, i) => {
      if (ids.has(t.id)) ctx.addIssue({ code: "custom", path: ["templates", i, "id"], message: "Повтор шаблона" });
      if (names.has(t.name.toLowerCase())) ctx.addIssue({ code: "custom", path: ["templates", i, "name"], message: `Шаблон «${t.name}» уже есть` });
      ids.add(t.id);
      names.add(t.name.toLowerCase());
    });
  });
export type LabelsConfig = z.infer<typeof labelsConfigSchema>;

/** Отдаётся наружу: основной шаблон «плоско» (как раньше — по нему рисуют) + все шаблоны. */
export type LabelsView = LabelSettings & LabelsConfig;

const DEFAULT_TEMPLATE: LabelTemplate = {
  id: "main",
  name: "Основной",
  width: 58,
  height: 40,
  rotate: false,
  code: "code128",
  fields: {
    logo: false,
    workshop: false,
    number: true,
    item: true,
    client: true,
    phone: true,
    device: true,
    serial: false,
    complaint: false,
    date: true,
    due: false,
  },
  mode: "auto",
  layout: null,
};

const DEFAULT_PER_ITEM = ["Блок питания", "Сумка или чехол", "Стилус или мышь"];

export const DEFAULT_LABELS: LabelSettings = (() => {
  const { id: _id, name: _name, ...t } = DEFAULT_TEMPLATE;
  return { ...t, perItem: DEFAULT_PER_ITEM };
})();

/** Один шаблон из того, что лежит в базе: недостающее — по умолчанию, испорченный макет — без него. */
function readTemplate(raw: unknown, fallbackId: string, fallbackName: string): LabelTemplate | null {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const fields = (r.fields && typeof r.fields === "object" ? r.fields : {}) as Record<string, unknown>;
  // Испорченный макет не должен стоить всей настройки: без него — автоматическая компоновка.
  const layout = layoutSchema.safeParse(r.layout);
  const merged = {
    ...DEFAULT_TEMPLATE,
    ...r,
    id: typeof r.id === "string" && r.id.trim() ? r.id : fallbackId,
    name: typeof r.name === "string" && r.name.trim() ? r.name : fallbackName,
    layout: layout.success ? layout.data : null,
    mode: r.mode === "custom" && layout.success ? "custom" : "auto",
    fields: { ...DEFAULT_TEMPLATE.fields, ...Object.fromEntries(LABEL_FIELDS.filter((f) => typeof fields[f] === "boolean").map((f) => [f, fields[f]])) },
  };
  const out = templateSchema.safeParse(merged);
  return out.success ? out.data : null;
}

/**
 * Настройка из Tenant.settings — недостающее и испорченное берётся по
 * умолчанию. Старая настройка (одна наклейка, без шаблонов) становится
 * шаблоном «Основной» — ничего не теряется.
 */
export function readLabels(settings: unknown): LabelsView {
  const s = (settings && typeof settings === "object" ? settings : {}) as Record<string, unknown>;
  const raw = (s.labels && typeof s.labels === "object" ? s.labels : {}) as Record<string, unknown>;
  const perItemParsed = labelSettingsSchema.shape.perItem.safeParse(raw.perItem);
  const perItem = perItemParsed.success ? perItemParsed.data : DEFAULT_PER_ITEM;

  let templates: LabelTemplate[] = [];
  if (Array.isArray(raw.templates)) {
    const seen = new Set<string>();
    for (const [i, t] of raw.templates.slice(0, MAX_TEMPLATES).entries()) {
      const one = readTemplate(t, `t${i + 1}`, `Шаблон ${i + 1}`);
      if (one && !seen.has(one.id)) {
        seen.add(one.id);
        templates.push(one);
      }
    }
  }
  if (!templates.length) templates = [readTemplate({ ...raw, id: "main", name: "Основной" }, "main", "Основной") ?? DEFAULT_TEMPLATE];
  const main = typeof raw.main === "string" && templates.some((t) => t.id === raw.main) ? raw.main : templates[0].id;
  return { ...flat(templates.find((t) => t.id === main)!), perItem, templates, main };
}

const flat = (t: LabelTemplate) => {
  const { id: _id, name: _name, ...rest } = t;
  return rest;
};

/** Настройка для печати шаблоном: выбранный (если есть такой) или основной. */
export function labelsFor(v: LabelsView, templateId?: string | null): LabelSettings {
  const t = (templateId && v.templates.find((x) => x.id === templateId)) || v.templates.find((x) => x.id === v.main) || v.templates[0];
  return { ...flat(t), perItem: v.perItem };
}

/**
 * Размер листа для печати — всегда сама этикетка, как на рулоне. «Повернуть»
 * поворачивает только то, что на ней напечатано (см. frontend Label).
 */
export function labelPage(l: LabelSettings): { width: number; height: number } {
  return { width: l.width, height: l.height };
}
