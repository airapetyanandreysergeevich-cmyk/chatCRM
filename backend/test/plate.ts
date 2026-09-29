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
import { BUILTIN, brandsByRules, buildDictionary, modelKeys, parsePlate, patternToRegExp, type OcrResult } from "../src/modules/plate/plate.parse";
import { decide } from "../src/modules/plate/plate.vote";

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

// ---------------------------------------------------------------- марка по модели

// Настоящий шильдик ASUS, у которого отрезан логотип и строка ASUSTeK.
const asusLines = fixtures["asus-d509"].lines.filter((l) => !/ASUS|^SUS$/i.test(l.text.replace(/\s+/g, "")));
const noBrand = parsePlate({ lines: asusLines, barcodes: fixtures["asus-d509"].barcodes });
check(noBrand.brand?.value === "ASUS" && noBrand.brandFrom === "model", `ASUS без логотипа — марка по модели D509D (${noBrand.brand?.value}, ${noBrand.brandFrom})`);
check(parsePlate(fixtures["asus-d509"]).brandFrom === "plate", "марка с логотипом помечена как прочитанная на шильдике");

const rules = buildDictionary().models;
const expectBrand: Array<[string, string | null]> = [
  ["X540UB", "ASUS"], ["X515EA-BQ1234", "ASUS"], ["UX305FA", "ASUS"], ["FX505DT", "ASUS"], ["E410MA", "ASUS"],
  ["M3407HA-SF088", "ASUS"], ["X1502ZA", "ASUS"], ["K513EA", "ASUS"], ["TP412FA", "ASUS"],
  ["A315-21", "Acer"], ["AN515-55", "Acer"], ["N19C1", "Acer"], ["E5-571G", "Acer"], ["SF314-57", "Acer"], ["ES1-512", "Acer"],
  ["TPN-C139", "HP"], ["TPNC139", "HP"], ["15-DA0123UR", "HP"], ["250 G7", "HP"],
  ["P89F", "Dell"], ["P112F", "Dell"],
  ["A1466", "Apple"], ["A2338", "Apple"],
  ["MS-16W1", "MSI"], ["GF63", "MSI"], ["GF63 Thin", "MSI"],
  ["NP-R710H", "Samsung"], ["SM-A505F", "Samsung"],
  ["PCG-71211V", "Sony"], ["SVF152A29V", "Sony"], ["VPCEB3M1R", "Sony"],
  ["330-15IKB", "Lenovo"], ["S145-15IWL", "Lenovo"], ["G580", "Lenovo"], ["G50-30", "Lenovo"], ["530S-14IKB", "Lenovo"], ["V15-IIL", "Lenovo"],
  ["TM1701", "Xiaomi"],
  // Похожее, но чужое или неясное — марку не выдумываем.
  ["E480", null], ["M720Q", null], ["A505F", null], ["20157", null], ["ZR7C", null], ["12345", null], ["X1", null],
];
for (const [model, brand] of expectBrand) {
  const got = brandsByRules(model, rules);
  check(brand === null ? got.length === 0 : got[0] === brand && got.length === 1, `правило: ${model} → ${brand ?? "ничего"} (${got.join(", ") || "—"})`);
}
check(BUILTIN.models.every((r) => r.patterns.every((p) => !!patternToRegExp(p))), "все встроенные шаблоны разбираются");
check(!patternToRegExp("*") && !patternToRegExp("-*") && !patternToRegExp("A*"), "слишком общие шаблоны отвергаются");

// Правило словаря платформы важнее встроенного и пишет марку, как она названа среди марок.
const dictRule = parsePlate(
  { lines: [{ text: "Model: X540UB" }], barcodes: [] },
  { dictionary: { brands: [], noise: [], models: [{ brand: "asus", patterns: ["X540*"] }, { brand: "Raybook", patterns: ["RB-1#"] }] } }
);
check(dictRule.brand?.value === "ASUS", `правило словаря «asus» даёт встроенное написание ASUS (${dictRule.brand?.value})`);
const rb = parsePlate(
  { lines: [{ text: "Model: RB-14" }], barcodes: [] },
  { dictionary: { brands: [], noise: [], models: [{ brand: "Raybook", patterns: ["RB-1#"] }] } }
);
check(rb.brand?.value === "Raybook" && rb.brandFrom === "model", `новая марка правилом словаря (${rb.brand?.value})`);
check(!parsePlate({ lines: [{ text: "Model: RB-14" }], barcodes: [] }).brand, "без правила незнакомая модель марку не получает");

// Ключи модели.
check(JSON.stringify(modelKeys("X515EA-BQ1234")) === JSON.stringify(["X515EABQ1234", "X515EA"]), `ключи X515EA-BQ1234 (${modelKeys("X515EA-BQ1234")})`);
check(JSON.stringify(modelKeys("NP-R710H")) === JSON.stringify(["NPR710H"]), `у NP-R710H основы нет (${modelKeys("NP-R710H")})`);
check(JSON.stringify(modelKeys("NP-R710H-FS06RU")) === JSON.stringify(["NPR710HFS06RU", "NPR710H"]), `основа NP-R710H-FS06RU — NPR710H (${modelKeys("NP-R710H-FS06RU")})`);
check(JSON.stringify(modelKeys("250 G7")) === JSON.stringify(["250G7"]), `у «250 G7» основы нет (${modelKeys("250 G7")})`);
check(modelKeys("Pro").length === 0, "без цифр — не модель");

// Голосование мастерских.
const pairs = (source: string, model: string, brand: string, uses = 1) => ({ source, model, brand, uses });
const k1 = decide([pairs("t1", "RB-1401", "Raybook"), pairs("t2", "RB-1401", "RAYBOOK")]);
check(k1.decided.get("RB1401") === "Raybook", `две мастерские — марка принята (${k1.decided.get("RB1401")})`);
const k2 = decide([pairs("t1", "RB-1401", "Raybook", 50)]);
check(!k2.decided.has("RB1401"), "одной мастерской мало, сколько бы аппаратов у неё ни было");
const k3 = decide([pairs("t1", "RB-1401", "Raybook"), pairs("t2", "RB-1401", "Raybook"), pairs("t3", "RB-1401", "Haier")]);
check(!k3.decided.has("RB1401"), "две против одной — спорно, не принимаем");
const k4 = decide([
  pairs("t1", "RB-1401", "Raybook"), pairs("t2", "RB-1401", "Raybook"), pairs("t3", "RB-1401", "Raybook"),
  pairs("t4", "RB-1401", "Haier"),
]);
check(k4.decided.get("RB1401") === "Raybook", "три против одной — принимаем");
const k5 = decide([pairs("t1", "X515EA-BQ1234", "ASUS"), pairs("t2", "X515EA-BQ9999", "ASUS")]);
check(k5.decided.get("X515EA") === "ASUS", "разная комплектация одной модели сходится по основе");
const k6 = decide([pairs("t1", "RB-1401", "Raybook", 1), pairs("t1", "RB-1401", "Haier", 9), pairs("t2", "RB-1401", "Haier")]);
check(k6.decided.get("RB1401") === "Haier", "мастерская голосует одной, самой частой своей маркой");

console.log(fails === 0 ? "\nвсе проверки прошли" : `\nпровалов: ${fails}`);
process.exitCode = fails === 0 ? 0 : 1;
