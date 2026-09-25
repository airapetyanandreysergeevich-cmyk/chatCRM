import type { SqlTable } from "../sqlite";
import { SOURCE as catalog } from "./catalog";
import type { MigrationSource } from "./types";

/**
 * Программы, из которых умеем переносить. Новая программа — новый файл рядом
 * и строка здесь; узнаётся по своему набору таблиц.
 */
export const SOURCES: MigrationSource[] = [catalog];

export const detectSource = (tables: Record<string, SqlTable>): MigrationSource | null =>
  SOURCES.find((s) => s.detect(tables)) ?? null;
