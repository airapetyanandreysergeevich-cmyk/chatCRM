import type { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  QUICK_PICK_DEFAULTS,
  QUICK_PICK_FIELDS,
  isLockedPick,
  type QuickPickField,
} from "../../lib/dictionaries";

/**
 * Кнопки быстрого заполнения: чтение по частоте и учёт нажатий.
 *
 * Порядок кнопок считается при открытии бланка и дальше не меняется: кнопка,
 * уехавшая из-под пальца, пока человек отмечает комплектность, хуже, чем
 * вовсе без сортировки. Поэтому счёт растёт при сохранении заказа, а видно
 * новый порядок только на следующем бланке.
 */

export interface QuickPickView {
  id: string;
  label: string;
  uses: number;
  /** Нельзя удалить и переименовать — от кнопки зависят флаги гарантии. */
  locked: boolean;
}

export const isQuickPickField = (v: string): v is QuickPickField =>
  (QUICK_PICK_FIELDS as readonly string[]).includes(v);

/** Кнопки поля: частые первыми, при равном счёте — порядок справочника. */
export async function listQuickPicks(
  tx: Prisma.TransactionClient,
  field: QuickPickField
): Promise<QuickPickView[]> {
  const rows = await tx.quickPick.findMany({
    where: { field },
    orderBy: [{ uses: "desc" }, { sortOrder: "asc" }, { label: "asc" }],
    select: { id: true, label: true, uses: true },
  });
  return rows.map((r) => ({ ...r, locked: isLockedPick(field, r.label) }));
}

/** Стартовый набор для новой мастерской. */
export async function seedQuickPicks(tx: Prisma.TransactionClient, tenantId: string): Promise<void> {
  for (const field of QUICK_PICK_FIELDS) {
    await tx.quickPick.createMany({
      data: QUICK_PICK_DEFAULTS[field].map((label, i) => ({ tenantId, field, label, sortOrder: i })),
      skipDuplicates: true,
    });
  }
}

/**
 * Учесть нажатия: каждая кнопка, чей пункт попал в заказ, получает +1.
 *
 * Сличаем без учёта регистра — «кабель», набранный руками, это та же
 * кнопка «Кабель». Своё, чего среди кнопок нет, не считаем и в кнопки не
 * превращаем: «скол на крышке у петли» — это запись про одну технику, а не
 * пункт, который стоит держать под рукой.
 *
 * Ошибку наружу не пускаем: неучтённое нажатие — досадно, а потерянный из-за
 * него принятый заказ — недопустимо. Одного try здесь мало: в PostgreSQL
 * упавшая команда помечает сбойной всю транзакцию, и приём заказа рухнул бы
 * следующей же строкой. Точка возврата откатывает только счёт.
 */
export async function countQuickPicks(
  tx: Prisma.TransactionClient,
  field: QuickPickField,
  labels: string[]
): Promise<void> {
  if (labels.length === 0) return;
  await tx.$executeRawUnsafe("SAVEPOINT quick_picks");
  try {
    await tx.quickPick.updateMany({
      where: {
        field,
        OR: labels.map((label) => ({ label: { equals: label, mode: "insensitive" as const } })),
      },
      data: { uses: { increment: 1 } },
    });
    await tx.$executeRawUnsafe("RELEASE SAVEPOINT quick_picks");
  } catch {
    // Счёт кнопок — удобство, а не часть приёма заказа.
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT quick_picks");
    await tx.$executeRawUnsafe("RELEASE SAVEPOINT quick_picks");
  }
}

/**
 * Подпись кнопки.
 *
 * Без запятой: запятая разделяет пункты в строке, и кнопка «Документы, чек»
 * дописывала бы два пункта и никогда не подсвечивалась — так уже было.
 */
export const labelSchema = z
  .string()
  .transform((s) => s.replace(/\s+/g, " ").trim())
  .pipe(
    z
      .string()
      .min(2, "Слишком коротко для кнопки")
      .max(60, "Слишком длинно для кнопки — до 60 знаков")
      .refine((s) => !s.includes(","), "Без запятой: ею разделяются пункты, и кнопка развалится на две")
      // Жалобу делим ещё и по «; ! ?» и точке в конце фразы (complaintLabels):
      // кнопка «Не включается.» никогда не совпала бы сама с собой в счёте.
      .refine((s) => !/[;!?]|\.(\s|$)/.test(s), "Без «; ! ?» и точки в конце: они разделяют пункты")
  );
