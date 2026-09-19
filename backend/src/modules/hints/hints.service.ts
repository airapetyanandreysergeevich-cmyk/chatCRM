/**
 * Память полей техники.
 *
 * Приёмщик печатает вид техники, марку и модель руками, и одна и та же
 * «Ноутбук Lenovo IdeaPad 5» набирается по десятому разу. Готового справочника
 * завести нельзя: марок и моделей на свете больше, чем можно перечислить, и у
 * каждой мастерской свой поток техники. Поэтому список не задаётся, а
 * накапливается сам — из того, что уже приняли.
 *
 * Вид техники сюда попал последним и по той же причине. Он был выпадающим
 * списком из девяти строк, и мастерская, которая чинит кофемашины или
 * автомагнитолы, выбирала «Прочее» — а потом не могла найти свои заказы ни
 * поиском, ни глазами.
 */

const MAX_LENGTH = 60;

/** Поля, у которых есть память. */
export type HintField = "kind" | "brand" | "model";

/**
 * Приводим строку к виду, в котором её стоит запоминать: без краёв, без
 * двойных пробелов. Регистр не трогаем — «IdeaPad» должен остаться
 * «IdeaPad», а не превратиться в «ideapad».
 */
export function normalizeHint(raw: string | null | undefined): string | null {
  const value = (raw ?? "").replace(/\s+/g, " ").trim();
  if (value.length < 2 || value.length > MAX_LENGTH) return null;
  return value;
}

/**
 * Запоминает одно значение.
 *
 * Сравниваем без учёта регистра: «lenovo» и «Lenovo» — одна и та же марка, и
 * в списке она должна быть одна. Первое написание остаётся за первым, кто
 * ввёл: дальше он же будет выбирать вариант из списка, а не печатать заново.
 *
 * Ошибку наружу не пускаем: не запомнить вариант — досадно, а потерять из-за
 * этого принятый заказ — недопустимо.
 */
async function remember(tx: any, field: HintField, scope: string, raw: string | null | undefined) {
  const value = normalizeHint(raw);
  if (!value) return;

  try {
    const existing = await tx.deviceHint.findFirst({
      where: { field, scope, value: { equals: value, mode: "insensitive" } },
      select: { id: true },
    });

    if (existing) {
      await tx.deviceHint.update({
        where: { id: existing.id },
        data: { uses: { increment: 1 }, lastUsedAt: new Date() },
      });
    } else {
      await tx.deviceHint.create({ data: { field, scope, value } });
    }
  } catch {
    /* память подсказок — удобство, а не часть приёма заказа */
  }
}

/**
 * Запоминает вид, марку и модель принятой техники.
 *
 * Модель привязываем к марке: «IdeaPad 5» не должен подсказываться, когда в
 * марке стоит ASUS. Если марку не указали, модель запомнится с пустой
 * привязкой и будет предлагаться, пока марка пустая.
 *
 * Вид ни к чему не привязан: ноутбуки бывают любой марки, и сужать тут
 * нечего.
 */
export async function rememberDevice(
  tx: any,
  device: { kind?: string | null; brand?: string | null; model?: string | null }
) {
  const brand = normalizeHint(device.brand);
  await remember(tx, "kind", "", device.kind);
  await remember(tx, "brand", "", device.brand);
  await remember(tx, "model", (brand ?? "").toLowerCase(), device.model);
}
