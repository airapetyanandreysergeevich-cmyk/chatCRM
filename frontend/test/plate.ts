/**
 * Подстановка распознанного шильдика в бланк.
 *
 *   npx tsx test/plate.ts
 */
import { fitSize, mergeDevice } from "../src/lib/plate";

let bad = 0;
const ok = (c: boolean, m: string) => { console.log((c ? "ok    " : "БЕДА  ") + m); if (!c) bad++; };

const blank = { kind: "", brand: "", model: "", serial: "" };
const draft = { kind: "Ноутбук", brand: "ASUS", model: "D509D", serial: "M1N0CV151457038" };

const a = mergeDevice(blank, draft);
ok(a.brand === "ASUS" && a.model === "D509D" && a.serial === "M1N0CV151457038" && a.kind === "Ноутбук", "пустой бланк заполняется целиком");

const b = mergeDevice({ kind: "Игровой ноутбук", brand: "Asus", model: "", serial: "" }, draft);
ok(b.kind === "Игровой ноутбук", "выбранный приёмщиком тип не затирается");
ok(b.brand === "ASUS", "бренд заменяется распознанным");

const c = mergeDevice({ kind: "", brand: "HP", model: "250 G7", serial: "CND1" }, { ...draft, serial: "", model: "  " });
ok(c.serial === "CND1" && c.model === "250 G7", "пустое поле из окна ничего не стирает");

const extra = mergeDevice({ ...blank, id: "x" } as typeof blank & { id: string }, draft);
ok((extra as { id: string }).id === "x", "прочие поля бланка не теряются");

ok(JSON.stringify(fitSize(4000, 3000)) === JSON.stringify({ w: 2000, h: 1500 }), "снимок 12 Мп уменьшается до 2000 по длинной стороне");
ok(JSON.stringify(fitSize(1280, 720)) === JSON.stringify({ w: 1280, h: 720 }), "маленький кадр не растягивается");

console.log(bad === 0 ? "\nвсе проверки прошли" : `\nпровалов: ${bad}`);
process.exitCode = bad === 0 ? 0 : 1;
