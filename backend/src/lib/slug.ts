const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya",
};

/** «Сервис на Ленина» → «servis-na-lenina». Пустой результат заменяем на «m». */
export function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .split("")
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28)
    .replace(/-+$/g, "");
  return base.length >= 3 ? base : `m${base}`.padEnd(3, "0");
}

/**
 * Подбирает свободный код: «servis», «servis-2», «servis-3»…
 * isTaken задаёт вызывающий — так функция не знает про базу и легко проверяется.
 */
export async function uniqueSlug(desired: string, isTaken: (s: string) => Promise<boolean>): Promise<string> {
  const base = slugify(desired);
  if (!(await isTaken(base))) return base;
  for (let i = 2; i < 200; i++) {
    const candidate = `${base.slice(0, 26)}-${i}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new Error("Не удалось подобрать свободный код мастерской");
}
