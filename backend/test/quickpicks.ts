/**
 * Проверка кнопок быстрого заполнения.
 *
 * Три вещи, которые ломаются молча.
 *
 * Запятая: ею разделены пункты в строке комплектности. Кнопка с запятой в
 * подписи дописывает два пункта и никогда не подсвечивается — так и было с
 * «Документы, чек», пока это не заметил живой приёмщик.
 *
 * Флаги гарантии: «Следы вскрытия» и «Следы влаги» — не просто подписи, по
 * ним заказ получает флаги. Переименуй кнопку — флаг перестанет ставиться, и
 * узнают об этом в день спора с клиентом.
 *
 * Счёт нажатий: он живёт внутри приёма заказа, и его сбой не должен ронять
 * сам приём. В PostgreSQL для этого мало try — нужна точка возврата.
 *
 *   npx tsx test/quickpicks.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  complaintLabels,
  LOCKED_PICKS,
  QUICK_PICK_DEFAULTS,
  QUICK_PICK_FIELDS,
  flagsOf,
  isLockedPick,
} from "../src/lib/dictionaries";
import { countQuickPicks, labelSchema, listQuickPicks } from "../src/modules/quickpicks/quickpicks.service";

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log((ok ? "ok    " : "БЕДА  ") + msg);
  if (!ok) fails += 1;
};

async function main(): Promise<void> {
  // 1. Стартовые кнопки.
  for (const field of QUICK_PICK_FIELDS) {
    const withComma = QUICK_PICK_DEFAULTS[field].filter((l) => l.includes(","));
    check(withComma.length === 0, `${field}: в стартовых кнопках нет запятых${withComma.length ? " — " + withComma.join(" | ") : ""}`);
    const lower = QUICK_PICK_DEFAULTS[field].map((l) => l.toLowerCase());
    check(new Set(lower).size === lower.length, `${field}: стартовые кнопки не повторяются`);
    for (const locked of LOCKED_PICKS[field]) {
      check(QUICK_PICK_DEFAULTS[field].includes(locked), `${field}: защищённая «${locked}» есть среди стартовых`);
    }
  }

  // 2. Защищённые кнопки — ровно те, что ставят флаги.
  for (const label of LOCKED_PICKS.appearance) {
    const flags = flagsOf([label]);
    check(flags.hasOpenTraces || flags.hasWaterDamage, `«${label}» действительно ставит флаг — защищать есть что`);
  }
  check(isLockedPick("appearance", "  следы ВСКРЫТИЯ "), "защита не зависит от регистра и пробелов");
  check(!isLockedPick("appearance", "Царапины"), "обычная кнопка не защищена");
  check(!isLockedPick("completeness", "Следы вскрытия"), "защита — только в своём списке");

  // 3. Подпись кнопки.
  const ok = labelSchema.safeParse("  Сим-лоток  ");
  check(ok.success && ok.data === "Сим-лоток", "края обрезаются");
  check(labelSchema.safeParse("Документы, чек").success === false, "запятая не пропускается");
  check(labelSchema.safeParse("я").success === false, "слишком короткое не пропускается");
  check(labelSchema.safeParse("а".repeat(61)).success === false, "слишком длинное не пропускается");
  check(labelSchema.safeParse("Блок   питания").success && labelSchema.parse("Блок   питания") === "Блок питания", "двойные пробелы сжимаются");

  // 4. Порядок: частые первыми, при равном счёте — порядок справочника.
  let asked: unknown = null;
  const reader = {
    quickPick: {
      findMany: async (args: unknown) => {
        asked = args;
        return [
          { id: "1", label: "Царапины", uses: 40 },
          { id: "2", label: "Следы вскрытия", uses: 12 },
        ];
      },
    },
  };
  const list = await listQuickPicks(reader as never, "appearance");
  const order = JSON.stringify((asked as { orderBy: unknown }).orderBy);
  check(
    order === JSON.stringify([{ uses: "desc" }, { sortOrder: "asc" }, { label: "asc" }]),
    `сортировка: по частоте, затем справочник, затем алфавит (${order})`
  );
  check(list[1].locked === true && list[0].locked === false, "защищённая кнопка помечена для окна правки");

  // 5. Жалоба — живая речь: пункты для счёта режутся и точкой в конце фразы.
  const said = complaintLabels("Не включается. Залили 0.5 л чая; шумит\nне заряжается!  Не  включается");
  check(
    JSON.stringify(said) === JSON.stringify(["Не включается", "Залили 0.5 л чая", "шумит", "не заряжается"]),
    `жалоба делится на пункты, «0.5» цел, повтор не считается дважды (${said.join(" | ")})`
  );
  check(QUICK_PICK_DEFAULTS.complaint.length > 0, "у жалобы есть стартовые кнопки");
  check(LOCKED_PICKS.complaint.length === 0, "у жалобы защищённых кнопок нет");
  check(labelSchema.safeParse("Не включается.").success === false, "точка в конце кнопки не пропускается");
  check(labelSchema.safeParse("Замена 2.5\" диска").success, "точка внутри числа пропускается");
  const sql = readFileSync(join(__dirname, "../prisma/migrations/20260922100000_complaint_picks/migration.sql"), "utf8");
  const inSql = [...sql.matchAll(/\('([^']+)', \d+\)/g)].map((m) => m[1]);
  check(
    JSON.stringify(inSql) === JSON.stringify(QUICK_PICK_DEFAULTS.complaint),
    "стартовые жалобы в миграции и в коде совпадают — у старых и новых мастерских одни кнопки"
  );

  // 6. Счёт нажатий не роняет приём заказа.
  const log: string[] = [];
  const failing = {
    $executeRawUnsafe: async (sql: string) => {
      log.push(sql);
      return 0;
    },
    quickPick: {
      updateMany: async () => {
        log.push("updateMany");
        throw new Error("что-то с базой");
      },
    },
  };
  let threw = false;
  try {
    await countQuickPicks(failing as never, "completeness", ["Кабель"]);
  } catch {
    threw = true;
  }
  check(!threw, "сбой счёта не выходит наружу — приём заказа продолжается");
  check(
    log.join(" | ") === "SAVEPOINT quick_picks | updateMany | ROLLBACK TO SAVEPOINT quick_picks | RELEASE SAVEPOINT quick_picks",
    "и откатывается к точке возврата — иначе транзакция приёма стала бы сбойной"
  );

  const quiet: string[] = [];
  await countQuickPicks(
    { $executeRawUnsafe: async (s: string) => (quiet.push(s), 0), quickPick: { updateMany: async () => (quiet.push("u"), { count: 0 }) } } as never,
    "completeness",
    []
  );
  check(quiet.length === 0, "пустой список — ни одного запроса");

  console.log(fails === 0 ? "\nвсе проверки прошли" : `\nпровалов: ${fails}`);
  process.exitCode = fails === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("сорвалось:", err);
  process.exitCode = 1;
});
