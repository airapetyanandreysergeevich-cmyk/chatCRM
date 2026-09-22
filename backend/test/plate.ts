/**
 * Проверка разбора шильдиков на настоящих снимках.
 *
 * test/fixtures/plates.json — ответы распознавателя (сервис ocr) на снимки
 * ASUS, Lenovo, Acer и Samsung. Распознаватель здесь не нужен: проверяется
 * разбор, то есть то, что меняется чаще всего и ломается тише всего.
 *
 * Серийный номер проверяется строже прочего: ошибка в нём — это чужой
 * аппарат в гарантийном споре.
 *
 *   npx tsx test/plate.ts
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePlate, type OcrResult } from "../src/modules/plate/plate.parse";

const fixtures: Record<string, OcrResult> = JSON.parse(
  readFileSync(join(__dirname, "fixtures/plates.json"), "utf8")
);

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log((ok ? "ok    " : "БЕДА  ") + msg);
  if (!ok) fails += 1;
};

const expected: Record<
  string,
  { brand: string; model: string; modelAlso?: string[]; serial: string; confirmed?: boolean; kind?: string | null }
> = {
  "asus-d509": { brand: "ASUS", model: "D509D", modelAlso: ["D509DJ-BQ068"], serial: "M1N0CV151457038", confirmed: true, kind: "Ноутбук" },
  "asus-m3407": { brand: "ASUS", model: "M3407H", modelAlso: ["M3407HA-SF088"], serial: "T6N0KD00W03025C", confirmed: true, kind: "Ноутбук" },
  "lenovo-g580": { brand: "Lenovo", model: "G580", modelAlso: ["20157", "59337073"], serial: "WB06815442", kind: null },
  "lenovo-s20": { brand: "Lenovo", model: "S20-30 Touch", modelAlso: ["20434", "59436224"], serial: "UB03123504" },
  "acer-5820": { brand: "Acer", model: "Aspire 5820T", modelAlso: ["Aspire 5820TZG-P613G32Miks", "ZR7C"], serial: "LXR3F01003036087732500", kind: "Ноутбук" },
  "samsung-rv520": { brand: "Samsung", model: "NP-RV520", modelAlso: ["NP-RV520-S0HRU"], serial: "HL1X93FB900378L", confirmed: false, kind: "Ноутбук" },
  "samsung-r710": { brand: "Samsung", model: "NP-R710H", modelAlso: ["NP-R710-FS06RU"], serial: "EX9493BQA00011W", confirmed: true },
};

for (const [name, want] of Object.entries(expected)) {
  const got = parsePlate(fixtures[name]);
  const tag = name.padEnd(14);
  check(got.brand?.value === want.brand, `${tag} бренд ${want.brand} (${got.brand?.options.join(", ") ?? "—"})`);
  check(got.model?.value === want.model, `${tag} модель ${want.model} (${got.model?.options.join(" | ") ?? "—"})`);
  for (const also of want.modelAlso ?? []) {
    check(!!got.model?.options.includes(also), `${tag} среди вариантов модели есть ${also}`);
  }
  check(got.serial?.value === want.serial, `${tag} серийный ${want.serial} (${got.serial?.options.join(" | ") ?? "—"})`);
  if (want.confirmed !== undefined) {
    check(got.serialConfirmed === want.confirmed, `${tag} подтверждён штрихкодом: ${want.confirmed ? "да" : "нет"}`);
  }
  if (want.kind !== undefined) check(got.kind === want.kind, `${tag} вид: ${want.kind ?? "не определён"} (${got.kind ?? "—"})`);
}

// Шильдики, которых нет среди снимков, — строками, как их отдаёт распознаватель.
const hp = parsePlate({
  lines: [
    { text: "hp" },
    { text: "Model: HP 250 G7 Notebook PC" },
    { text: "Product: 6MQ38EA#ACB" },
    { text: "Serial: CND9281XYZ  Warranty: 1y" },
  ],
  barcodes: [{ format: "Code128", text: "CND9281XYZ" }],
});
check(hp.brand?.value === "HP", `HP: бренд (${hp.brand?.value})`);
check(hp.model?.value === "250 G7", `HP: модель без бренда и «Notebook PC» (${hp.model?.options.join(" | ")})`);
check(!!hp.model?.options.includes("6MQ38EA#ACB"), "HP: номер продукта среди вариантов");
check(hp.serial?.value === "CND9281XYZ" && hp.serialConfirmed, `HP: серийный подтверждён штрихкодом (${hp.serial?.value})`);

const dell = parsePlate({
  lines: [
    { text: "DELL" },
    { text: "Inspiron 15 3000" },
    { text: "Service Tag: 7XK2L23" },
    { text: "Express Service Code: 162 345 678 90" },
    { text: "Reg Model: P89F" },
  ],
  barcodes: [],
});
check(dell.brand?.value === "Dell", `Dell: бренд (${dell.brand?.value})`);
check(dell.model?.value === "Inspiron 15 3000", `Dell: модель с пробелами (${dell.model?.options.join(" | ")})`);
check(dell.serial?.value === "7XK2L23", `Dell: Service Tag как серийный (${dell.serial?.options.join(" | ")})`);

// Лишнее, прилипшее к модели: соседние надписи распознаватель сливает в одну строку.
const glued = parsePlate({
  lines: [
    { text: "SAMSUNG" },
    { text: "MODEL : NP-R710H Made in China" },
    { text: "MODEL CODE:NP-RV520-S0HRUMadeinChina" },
    { text: "Model: X-AC12 Rated 19V" },
  ],
  barcodes: [],
});
check(glued.model?.value === "NP-R710H", `«Made in China» отрезано от модели (${glued.model?.options.join(" | ")})`);
check(!!glued.model?.options.includes("NP-RV520-S0HRU"), "и без пробелов тоже («…S0HRUMadeinChina»)");
check(!!glued.model?.options.includes("X-AC12"), "«AC» внутри модели не режется, «Rated 19V» — режется");

// Словарь платформы: своя марка и своя лишняя фраза.
const custom = { brands: [{ name: "Haier", aliases: ["Haier Electronics"] }], noise: ["Energy Star"] };
const haier = parsePlate(
  { lines: [{ text: "Haier" }, { text: "Model: HB-15 Pro Energy Star" }, { text: "S/N: HA12345678" }], barcodes: [] },
  { dictionary: custom }
);
check(haier.brand?.value === "Haier", `марка из словаря платформы (${haier.brand?.value})`);
check(haier.model?.value === "HB-15 Pro", `лишняя фраза из словаря отрезана (${haier.model?.value})`);
const noDict = parsePlate({ lines: [{ text: "Haier" }, { text: "Model: HB-15 Pro Energy Star" }], barcodes: [] });
check(!noDict.brand, "без словаря незнакомая марка не угадывается");

// Марки мастерской из памяти бланка.
const own = parsePlate({ lines: [{ text: "RAYBOOK" }, { text: "Model: RB-14" }], barcodes: [] }, { knownBrands: ["Raybook", "Бытовая техника"] });
check(own.brand?.value === "Raybook", `марка из памяти мастерской (${own.brand?.value})`);

// Синоним к встроенной марке, а не новая марка.
const alias = parsePlate({ lines: [{ text: "HEWLETTPACKARDENTERPRISE" }], barcodes: [] }, { dictionary: { brands: [{ name: "hp", aliases: ["HPE"] }], noise: [] } });
check(alias.brand?.value === "HP" && alias.brand.options.length === 1, `синоним добавляется к встроенной марке (${alias.brand?.options.join(", ")})`);

// Чужой штрихкод (ключ Windows у Samsung RV520) не подменяет серийный номер.
const rv = parsePlate(fixtures["samsung-rv520"]);
check(rv.serial?.value !== "00192486829429", "чужой штрихкод не становится серийным номером");

// Пустой снимок не роняет разбор.
const empty = parsePlate({ lines: [], barcodes: [] });
check(!empty.brand && !empty.model && !empty.serial && !empty.serialConfirmed, "пустой снимок — пустой ответ");

// Штрихкод без текста — единственный источник, но всё же вариант.
const onlyCode = parsePlate({ lines: [{ text: "SAMSUNG" }], barcodes: [{ format: "Code128", text: "AB12CD34EF" }] });
check(onlyCode.serial?.value === "AB12CD34EF" && !onlyCode.serialConfirmed, "штрихкод без подтверждения текстом подставляется, но не помечается подтверждённым");

console.log(fails === 0 ? "\nвсе проверки прошли" : `\nпровалов: ${fails}`);
process.exitCode = fails === 0 ? 0 : 1;
