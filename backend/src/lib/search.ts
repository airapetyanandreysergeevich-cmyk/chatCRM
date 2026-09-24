/**
 * Поиск по словам — одно правило для заказов, клиентов и склада.
 *
 * Строку делим на слова, и **каждое слово должно найтись хоть где-нибудь**:
 * «ноутбук xiaomi bd9» находит заказ, где «ноутбук» — тип техники, «xiaomi» —
 * марка, а «bd9» — модель. Какое слово что значит, угадывать не нужно: марки и
 * модели из нескольких слов («Redmi Note 12») и опечатки в словаре сломали бы
 * любой разбор, а «каждое слово где-нибудь» с ними справляется.
 *
 * Раньше вся строка искалась одним куском, и такой запрос не находил ничего:
 * ни в одном поле не написано «ноутбук xiaomi bd9» целиком.
 */

/** Слов в запросе — не больше восьми: дальше это уже не поиск, а абзац. */
const MAX_WORDS = 8;

export function searchWords(raw: string | undefined | null): string[] {
  const words = String(raw ?? "")
    .trim()
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    const key = w.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
    if (out.length >= MAX_WORDS) break;
  }
  return out;
}

/*
 * Раскладка.
 *
 * Набрал «yjen,er» вместо «ноутбук» — у стойки это случается постоянно:
 * переключил язык для серийного номера и забыл вернуть. Таблица — клавиши
 * ЙЦУКЕН и QWERTY, стоящие на одних и тех же местах, включая знаки: на месте
 * «б» стоит запятая, на месте «ю» — точка.
 */
const EN = "`qwertyuiop[]asdfghjkl;'zxcvbnm,.";
const RU = "ёйцукенгшщзхъфывапролджэячсмитьбю";

const EN_TO_RU = new Map<string, string>();
const RU_TO_EN = new Map<string, string>();
for (let i = 0; i < EN.length; i += 1) {
  EN_TO_RU.set(EN[i], RU[i]);
  RU_TO_EN.set(RU[i], EN[i]);
  // Заглавные — только у букв: у запятой заглавной нет, и строка
  // «, → Б» затёрла бы «, → б».
  if (EN[i].toUpperCase() !== EN[i]) {
    EN_TO_RU.set(EN[i].toUpperCase(), RU[i].toUpperCase());
    RU_TO_EN.set(RU[i].toUpperCase(), EN[i].toUpperCase());
  }
}

/**
 * Слово в другой раскладке — или null, если переводить нечего.
 *
 * Переводим только слово, набранное целиком в одной раскладке: «bd9» → «ив9»
 * имеет смысл попробовать, а «ноутbook» — нет, это не опечатка раскладки.
 * Цифры и знаки, которых нет в таблице, остаются как есть.
 */
export function otherLayout(word: string): string | null {
  const latin = /[a-z]/i.test(word);
  const cyrillic = /[а-яё]/i.test(word);
  if (latin === cyrillic) return null;
  const map = latin ? EN_TO_RU : RU_TO_EN;
  let out = "";
  for (const ch of word) out += map.get(ch) ?? ch;
  return out === word ? null : out;
}

/**
 * Выбрать слова для поиска с исправлением раскладки.
 *
 * Слово, которое находится как набрано, не трогаем никогда: серийный номер
 * и модель латиницей не должны превращаться в кириллицу. Только слово, по
 * которому не нашлось ничего, пробуем в другой раскладке — и берём её, если
 * по ней нашлось. `fixed` — исправленная строка для подсказки «Показаны
 * результаты для …», или null, если исправлять не пришлось.
 */
export async function fixLayout(
  words: string[],
  found: (word: string) => Promise<boolean>
): Promise<{ words: string[]; fixed: string | null }> {
  const out = [...words];
  let changed = false;
  for (let i = 0; i < out.length; i += 1) {
    const alt = otherLayout(out[i]);
    if (!alt) continue;
    if (await found(out[i])) continue;
    if (await found(alt)) {
      out[i] = alt;
      changed = true;
    }
  }
  return { words: out, fixed: changed ? out.join(" ") : null };
}

/** «1», «true», «on» — да; всё остальное — нет. Для параметра адреса. */
export const truthy = (v: unknown) => /^(1|true|on|yes)$/i.test(String(v ?? ""));
