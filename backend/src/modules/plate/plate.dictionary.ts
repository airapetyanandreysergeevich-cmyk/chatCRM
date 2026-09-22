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

const EMPTY: PlateDictionary = { brands: [], noise: [] };

const text = (max: number) => z.string().transform((s) => s.replace(/\s+/g, " ").trim()).pipe(z.string().max(max));

export const dictionarySchema = z.object({
  brands: z
    .array(
      z.object({
        name: text(40).pipe(z.string().min(2, "Слишком короткое название марки")),
        aliases: z.array(text(60)).max(20).default([]),
      })
    )
    .max(500, "Не больше 500 марок"),
  noise: z.array(text(60).pipe(z.string().min(2))).max(300, "Не больше 300 фраз"),
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
