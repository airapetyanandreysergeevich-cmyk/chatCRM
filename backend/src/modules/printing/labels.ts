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

export const labelSettingsSchema = z.object({
  width: size,
  height: size,
  rotate: z.boolean(),
  code: z.enum(["code128", "qr"]),
  fields: z.object(Object.fromEntries(LABEL_FIELDS.map((f) => [f, z.boolean()])) as Record<LabelField, z.ZodBoolean>),
  /** Пункты комплектности, на которые печатается своя наклейка: «Блок питания», «Сумка или чехол». */
  perItem: z.array(z.string().trim().min(1).max(60)).max(40),
  /** Компоновка: автоматическая или свой макет (layout). */
  mode: z.enum(["auto", "custom"]).default("auto"),
  layout: layoutSchema.nullable().default(null),
});
export type LabelSettings = z.infer<typeof labelSettingsSchema>;

export const DEFAULT_LABELS: LabelSettings = {
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
  perItem: ["Блок питания", "Сумка или чехол", "Стилус или мышь"],
  mode: "auto",
  layout: null,
};

/** Настройка из Tenant.settings — недостающее и испорченное берётся по умолчанию. */
export function readLabels(settings: unknown): LabelSettings {
  const s = (settings && typeof settings === "object" ? settings : {}) as Record<string, unknown>;
  const raw = (s.labels && typeof s.labels === "object" ? s.labels : {}) as Record<string, unknown>;
  const fields = (raw.fields && typeof raw.fields === "object" ? raw.fields : {}) as Record<string, unknown>;
  // Испорченный макет не должен стоить всей настройки: без него — автоматическая компоновка.
  const layout = layoutSchema.safeParse(raw.layout);
  const merged = {
    ...DEFAULT_LABELS,
    ...raw,
    layout: layout.success ? layout.data : null,
    mode: raw.mode === "custom" && layout.success ? "custom" : "auto",
    fields: { ...DEFAULT_LABELS.fields, ...Object.fromEntries(LABEL_FIELDS.filter((f) => typeof fields[f] === "boolean").map((f) => [f, fields[f]])) },
  };
  const r = labelSettingsSchema.safeParse(merged);
  return r.success ? r.data : DEFAULT_LABELS;
}

/**
 * Размер листа для печати — всегда сама этикетка, как на рулоне. «Повернуть»
 * поворачивает только то, что на ней напечатано (см. frontend Label).
 */
export function labelPage(l: LabelSettings): { width: number; height: number } {
  return { width: l.width, height: l.height };
}
