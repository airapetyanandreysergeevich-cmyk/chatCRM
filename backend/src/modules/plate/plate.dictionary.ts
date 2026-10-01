import { z } from "zod";
import { prisma } from "../../lib/db";
import type { PlateDictionary } from "./plate.parse";

/**
 * Словарь распознавания шильдиков — один на всю платформу.
 *
 * Лежит в PlatformSetting и читается при каждом распознавании, но не из базы
 * каждый раз: кэш на минуту. Правка в панели доходит до приёмщиков не позже
 * чем через минуту — этого достаточно, а база не дёргается на каждый снимок.
 */

const KEY = "plateDictionary";
const TTL_MS = 60_000;

const EMPTY: PlateDictionary = { brands: [], noise: [], models: [] };

const text = (max: number) => z.string().transform((s) => s.replace(/\s+/g, " ").trim()).pipe(z.string().max(max));

export const dictionarySchema = z.object({
  brands: z
    .array(
      z.object({
        name: text(40).pipe(z.string().min(2, "Слишком короткое название марки")),
        // Другие написания и серии: «MSI: Cyborg, Raider, Katana…».
        aliases: z
          .array(
            z
              .string()
              .transform((s) => s.replace(/\s+/g, " ").trim())
              .pipe(z.string().max(60, "одно из написаний длиннее 60 знаков"))
          )
          .max(100, "больше 100 написаний и серий — оставьте самые нужные")
          .default([]),
      })
    )
    .max(500, "Не больше 500 марок"),
  noise: z.array(text(60).pipe(z.string().min(2))).max(300, "Не больше 300 фраз"),
  // Марка по модели. Словари, сохранённые до этого поля, его не содержат.
  models: z
    .array(
      z.object({
        brand: text(40).pipe(z.string().min(2, "Слишком короткое название марки")),
        patterns: z
          .array(
            z
              .string()
              .transform((s) => s.replace(/\s+/g, "").toUpperCase())
              .pipe(
                z
                  .string()
                  .max(40, "Шаблон модели длиннее 40 знаков")
                  .regex(/^[A-Z0-9*#@?\-/.+_]+$/, "В шаблоне модели — только латиница, цифры и знаки * # @ ? -")
                  .refine((p) => p.replace(/[*\-]/g, "").length >= 2, "Шаблон модели слишком общий — в нём меньше двух знаков")
              )
          )
          .max(100),
      })
    )
    .max(500, "Не больше 500 строк с моделями")
    .default([]),
});

let cache: { value: PlateDictionary; at: number } | null = null;

export async function loadDictionary(): Promise<PlateDictionary> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const row = await prisma.platformSetting.findUnique({ where: { key: KEY } });
  const parsed = dictionarySchema.safeParse(row?.value ?? EMPTY);
  const value = parsed.success ? parsed.data : EMPTY;
  cache = { value, at: Date.now() };
  return value;
}

export async function saveDictionary(value: PlateDictionary): Promise<PlateDictionary> {
  const clean = dictionarySchema.parse(value);
  await prisma.platformSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: clean },
    update: { value: clean },
  });
  cache = { value: clean, at: Date.now() };
  return clean;
}

/**
 * Ошибка словаря человеческими словами: не «Проверьте заполнение полей», а
 * у какой марки и что не так.
 */
export function dictionaryProblem(err: z.ZodError, body: unknown): string {
  const issue = err.issues[0];
  if (!issue) return "Словарь не сохранён";
  const [section, index] = issue.path;
  const raw = body as { brands?: Array<{ name?: string }>; models?: Array<{ brand?: string }> } | null;
  if (section === "brands" && typeof index === "number") {
    const name = raw?.brands?.[index]?.name?.trim() || `№${index + 1}`;
    return `Марки, строка «${name}»: ${issue.message}`;
  }
  if (section === "models" && typeof index === "number") {
    const name = raw?.models?.[index]?.brand?.trim() || `№${index + 1}`;
    return `Марка по модели, строка «${name}»: ${issue.message}`;
  }
  if (section === "noise") return `Лишние слова: ${issue.message}`;
  return issue.message;
}
