/**
 * Разбор ответа клиента на согласование по SMS.
 *
 *   npx tsx test/sms-approval.ts
 */
import { parseAnswer } from "../src/modules/sms/sms.approval";
import { normalizePhone } from "../src/modules/sms/sms";

let bad = 0;
const check = (ok: boolean, what: string) => {
  console.log((ok ? "ok   " : "БЕДА ") + what);
  if (!ok) bad++;
};

const cases: Array<[string, "yes" | "no" | "unclear"]> = [
  ["Да", "yes"],
  ["да", "yes"],
  ["ДА!", "yes"],
  ["Да, делайте", "yes"],
  ["Да. Спасибо", "yes"],
  ["Ок", "yes"],
  ["Согласен", "yes"],
  ["согласна, жду звонка", "yes"],
  ["Хорошо", "yes"],
  ["Конечно", "yes"],
  ["Давайте", "yes"],
  ["+", "yes"],
  ["1", "yes"],
  ["Lf", "yes"],
  ["Yes", "yes"],
  ["Нет", "no"],
  ["нет, дорого", "no"],
  ["Не надо", "no"],
  ["Не нужно, заберу", "no"],
  ["не согласен", "no"],
  ["Отказываюсь", "no"],
  ["-", "no"],
  ["0", "no"],
  ["Ytn", "no"],
  ["Да, а сколько по времени?", "unclear"],
  ["А можно дешевле?", "unclear"],
  ["Да нет, не надо", "unclear"],
  ["Перезвоните мне", "unclear"],
  ["", "unclear"],
  ["   ", "unclear"],
];
for (const [text, want] of cases) {
  const got = parseAnswer(text);
  check(got === want, `«${text}» → ${want}${got === want ? "" : ` (получилось ${got})`}`);
}

check(normalizePhone("8 (921) 123-45-67") === "+79211234567", "номер с восьмёркой → +7");
check(normalizePhone("+7 921 123 45 67") === "+79211234567", "номер с +7 как есть");
check(normalizePhone("9211234567") === "+79211234567", "десять цифр → +7");
check(normalizePhone("900") === null, "короткий номер — не номер");

console.log(bad ? `\nБЕД: ${bad}` : "\nвсе проверки прошли");
process.exit(bad ? 1 : 0);
