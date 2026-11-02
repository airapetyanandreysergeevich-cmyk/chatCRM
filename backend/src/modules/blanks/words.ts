/**
 * Сумма прописью: 4700 → «четыре тысячи семьсот рублей 00 копеек».
 * Для бланков из Excel (метка {итого прописью}) — договоры и акты её любят.
 */

const ONES_M = ["", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const ONES_F = ["", "одна", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const TEENS = ["десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать", "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать"];
const TENS = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто"];
const HUNDREDS = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот"];

/** 1 рубль, 2 рубля, 5 рублей. */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

function triad(n: number, female: boolean): string[] {
  const out: string[] = [];
  const h = Math.floor(n / 100);
  const t = Math.floor((n % 100) / 10);
  const o = n % 10;
  if (h) out.push(HUNDREDS[h]);
  if (t === 1) out.push(TEENS[o]);
  else {
    if (t) out.push(TENS[t]);
    if (o) out.push((female ? ONES_F : ONES_M)[o]);
  }
  return out;
}

const SCALES: Array<[string, string, string, boolean]> = [
  ["", "", "", false],
  ["тысяча", "тысячи", "тысяч", true],
  ["миллион", "миллиона", "миллионов", false],
  ["миллиард", "миллиарда", "миллиардов", false],
];

/** Целое число словами (мужской род): 4700 → «четыре тысячи семьсот». */
export function numberWords(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return "ноль";
  const parts: string[] = [];
  let scale = 0;
  while (n > 0 && scale < SCALES.length) {
    const t = n % 1000;
    if (t) {
      const [one, few, many, female] = SCALES[scale];
      const words = triad(t, female);
      if (scale > 0) words.push(plural(t, one, few, many));
      parts.unshift(words.join(" "));
    }
    n = Math.floor(n / 1000);
    scale++;
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** «Четыре тысячи семьсот рублей 00 копеек» — с заглавной, как пишут в документах. */
export function rublesWords(amount: number): string {
  const rub = Math.floor(Math.abs(amount) + 1e-9);
  const kop = Math.round((Math.abs(amount) - rub) * 100);
  const w = numberWords(rub);
  const s = `${w} ${plural(rub, "рубль", "рубля", "рублей")} ${String(kop).padStart(2, "0")} ${plural(kop, "копейка", "копейки", "копеек")}`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
