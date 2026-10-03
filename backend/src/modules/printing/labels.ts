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

export const labelSettingsSchema = z.object({
  width: size,
  height: size,
  rotate: z.boolean(),
  code: z.enum(["code128", "qr"]),
  fields: z.object(Object.fromEntries(LABEL_FIELDS.map((f) => [f, z.boolean()])) as Record<LabelField, z.ZodBoolean>),
  /** Пункты комплектности, на которые печатается своя наклейка: «Блок питания», «Сумка или чехол». */
  perItem: z.array(z.string().trim().min(1).max(60)).max(40),
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
};

/** Настройка из Tenant.settings — недостающее и испорченное берётся по умолчанию. */
export function readLabels(settings: unknown): LabelSettings {
  const s = (settings && typeof settings === "object" ? settings : {}) as Record<string, unknown>;
  const raw = (s.labels && typeof s.labels === "object" ? s.labels : {}) as Record<string, unknown>;
  const fields = (raw.fields && typeof raw.fields === "object" ? raw.fields : {}) as Record<string, unknown>;
  const merged = {
    ...DEFAULT_LABELS,
    ...raw,
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
