/**
 * Разбор шильдика: из строк распознанного текста и штрихкодов — бренд,
 * модель, серийный номер и вид техники.
 *
 * Распознаватель (сервис ocr) отдаёт только текст. Что из него что — решается
 * здесь, потому что правила разбора меняются чаще распознавателя и
 * проверяются на настоящих шильдиках (test/plate.ts, test/fixtures/plates.json).
 *
 * Что приходится учитывать.
 *
 * Пробелы теряются. «MODELNO.（型号/型號）：ZR7C», «LenovoS20-30Touch»,
 * «S/N:WB06815442P/N:59337073» — две метки слиплись в одну строку. Поэтому
 * метки ищем в сжатой строке, а значение обрываем на следующей известной
 * метке, а не на пробеле, которого нет.
 *
 * Метки у всех разные. ASUS пишет «Model» и отдельной строкой полный код
 * (D509DJ-BQ068). Lenovo в «Model Name» пишет тип машины (20157), а модель —
 * в первой строке рядом с брендом (Lenovo G580). Acer в «MODEL NO.» пишет
 * регистрационный код (ZR7C), а модель — в строке «Aspire 5820T series».
 * Поэтому у кандидатов есть вес, и в ответе — все варианты: основной и
 * запасные, приёмщик выберет кнопкой.
 *
 * Серийный номер — поле, где ошибка дороже всего. Если штрихкод или QR
 * говорит то же, что текст, номер помечается подтверждённым. Штрихкод,
 * которого нет в тексте, идёт только запасным вариантом: на шильдике бывают
 * и чужие коды — ключ Windows, номер партии.
 */

export interface OcrLine {
  text: string;
  score?: number;
  box?: number[];
}
export interface OcrBarcode {
  format: string;
  text: string;
}
export interface OcrResult {
  lines: OcrLine[];
  barcodes: OcrBarcode[];
}

export interface PlateField {
  /** Основной вариант — его подставим. */
  value: string;
  /** Все варианты, основной первым. Больше одного — покажем кнопками. */
  options: string[];
}

export interface PlateResult {
  brand: PlateField | null;
  model: PlateField | null;
  serial: PlateField | null;
  /** Номер совпал со штрихкодом или QR — прочитан дважды разными способами. */
  serialConfirmed: boolean;
  kind: string | null;
  /** Весь распознанный текст — для случая, когда разбор промахнулся. */
  text: string[];
}

// ----------------------------------------------------------------- строки

/** Полноширинные знаки китайской части шильдика — в обычные. */
function normalize(s: string): string {
  return s
    .replace(/[：︰]/g, ":")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/[／]/g, "/")
    .replace(/[－—–]/g, "-")
    .replace(/[\u3000]/g, " ")
    .trim();
}

/** Японская и китайская части шильдика: для разбора в них ничего нет. */
const isCjk = (ch: string) => {
  const code = ch.charCodeAt(0);
  return code >= 0x3040 && code <= 0x9fff;
};
const skip = (ch: string) => /\s/.test(ch) || isCjk(ch);

/** Без пробелов и иероглифов: так метки находятся, как бы их ни слепило. */
const compact = (s: string) => [...s].filter((ch) => !skip(ch)).join("");

/**
 * Хвост исходной строки после n-го знака сжатой. Метку ищем в сжатой строке,
 * а значение берём из исходной: в «Model: HP 250 G7» пробелы — часть модели.
 */
function tailAfter(line: string, n: number): string {
  let seen = 0;
  for (let i = 0; i < line.length; i++) {
    if (skip(line[i])) continue;
    if (seen === n) return line.slice(i);
    seen += 1;
  }
  return "";
}

/** Строка без иероглифов, но с пробелами. */
const plain = (s: string) =>
  [...s].filter((ch) => !isCjk(ch)).join("").replace(/\s+/g, " ").trim();

/** Буква O в метке — частая ошибка распознавания: «MODELC0DE». */
const keyOf = (s: string) => s.toUpperCase().replace(/0/g, "O");

// ----------------------------------------------------------------- бренды

interface Brand {
  name: string;
  /** Длинные уникальные слова: ищем подстрокой в сжатой строке. */
  words: string[];
  /** Короткие имена: только целой строкой или в начале строки. */
  short?: string[];
  /** Семейства моделей: по ним и бренд понятен, и модель находится. */
  families?: string[];
}

const BRANDS: Brand[] = [
  { name: "ASUS", words: ["ASUSTEK"], short: ["ASUS"], families: ["VivoBook", "ZenBook", "ROG", "TUF", "ExpertBook", "ProArt"] },
  { name: "Lenovo", words: ["LENOVO"], families: ["IdeaPad", "ThinkPad", "ThinkBook", "Yoga", "Legion"] },
  { name: "Acer", words: ["ACERINC", "ACERINCORPORATED"], short: ["ACER"], families: ["Aspire", "TravelMate", "Extensa", "Nitro", "Swift", "Predator"] },
  { name: "Samsung", words: ["SAMSUNG"], families: ["Galaxy"] },
  { name: "HP", words: ["HEWLETT", "HPINC"], short: ["HP"], families: ["Pavilion", "ProBook", "EliteBook", "Envy", "Omen", "Victus"] },
  { name: "Dell", words: ["DELLINC"], short: ["DELL"], families: ["Inspiron", "Latitude", "Vostro", "XPS", "Alienware"] },
  { name: "Apple", words: ["DESIGNEDBYAPPLE", "APPLEINC"], short: ["APPLE"], families: ["MacBook", "iMac", "iPad", "iPhone"] },
  { name: "MSI", words: ["MICRO-STAR", "MICROSTAR"], short: ["MSI"] },
  { name: "Huawei", words: ["HUAWEI"], families: ["MateBook"] },
  { name: "Honor", words: ["HONORDEVICE"], short: ["HONOR"], families: ["MagicBook"] },
  { name: "Xiaomi", words: ["XIAOMI"], families: ["Redmi", "RedmiBook"] },
  { name: "Toshiba", words: ["TOSHIBA"], families: ["Satellite", "Tecra"] },
  { name: "Sony", words: [], short: ["SONY"], families: ["VAIO"] },
  { name: "Fujitsu", words: ["FUJITSU"], families: ["Lifebook"] },
  { name: "Gigabyte", words: ["GIGABYTE"], families: ["AORUS"] },
  { name: "Packard Bell", words: ["PACKARDBELL"] },
  { name: "eMachines", words: ["EMACHINES"] },
  { name: "Microsoft", words: ["MICROSOFTSURFACE"], families: ["Surface"] },
  { name: "LG", words: ["LGELECTRONICS"], families: ["Gram"] },
  { name: "DEXP", words: [], short: ["DEXP"] },
  { name: "Irbis", words: [], short: ["IRBIS"] },
  { name: "Digma", words: [], short: ["DIGMA"] },
  { name: "Chuwi", words: [], short: ["CHUWI"] },
  { name: "Infinix", words: ["INFINIX"] },
  { name: "Tecno", words: [], short: ["TECNO"] },
  { name: "Realme", words: [], short: ["REALME"] },
];

// ----------------------------------------------------------------- словарь

/**
 * Словарь платформы: марки и лишние слова, которые собственник правит в
 * панели «Мастерские → Словарь шильдиков», не дожидаясь обновления программы.
 */
export interface PlateDictionary {
  /** Марка и её другие написания: «Hewlett-Packard» → HP. */
  brands: Array<{ name: string; aliases: string[] }>;
  /** Фразы, на которых модель обрывается: «Made in China», «Rated». */
  noise: string[];
}

export interface ParseOptions {
  dictionary?: PlateDictionary;
  /** Марки, которые мастерская уже вводила сама (память полей бланка). */
  knownBrands?: string[];
}

/**
 * Лишнее, что прилипает к модели, когда распознаватель сливает соседние
 * надписи в одну строку: «NP-R710H Made in China». Модель обрывается на
 * первой такой фразе — всё, что правее, к ней не относится.
 */
const NOISE = [
  "Made in", "Manufactured", "Assembled in", "Product of", "Designed by", "Designed in",
  "Rated", "Rating", "Input", "Output", "Class B", "RoHS", "CAN ICES",
  "Notebook PC", "Laptop", "Serial", "Warranty", "Mfg Date", "MFD",
  // Короткие «DC», «AC», «CE» сюда нарочно не входят: они встречаются
  // внутри настоящих моделей (X-AC12), и обрезка съела бы модель.
];

/**
 * Фраза — в выражения, нечувствительные к пробелам: «Made in» найдёт и
 * «MadeinChina».
 *
 * Два выражения. Первое — с границей слева: «Rated» не должно резать
 * «Generated». Второе — для слипшегося «…S0HRUMadeinChina», где слева
 * заглавная буква модели: там фраза ищется в своём написании, с заглавной и
 * строчными, — именно так она и отличается от модели.
 */
function phrase(p: string): RegExp[] {
  const letters = [...p.replace(/\s+/g, "")].map((ch) => ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));
  if (letters.length < 2) return [];
  const body = letters.join("\\s*");
  const out = [new RegExp(`(^|[^A-Za-z])${body}`, "i")];
  if (/^[A-Z][a-z]/.test(p)) out.push(new RegExp(`([A-Z0-9])${body}`));
  return out;
}

interface Dict {
  brands: Brand[];
  noise: RegExp[];
}

const brandByName = (brands: Brand[], name: string) => brands.find((b) => b.name === name) ?? null;

/** Встроенные марки плюс словарь платформы плюс марки мастерской. */
export function buildDictionary(options: ParseOptions = {}): Dict {
  const brands: Brand[] = BRANDS.map((b) => ({ ...b, words: [...b.words], short: [...(b.short ?? [])] }));
  const byUpper = (name: string) => brands.find((b) => b.name.toUpperCase() === name.trim().toUpperCase());

  const addNames = (b: Brand, names: string[]) => {
    for (const raw of names) {
      const n = compact(raw).toUpperCase();
      if (n.length < 2) continue;
      // Длинное и заметное — ищем подстрокой, короткое — только целиком.
      if (n.length >= 6) {
        if (!b.words.includes(n)) b.words.push(n);
      } else if (!(b.short ?? []).includes(n)) {
        (b.short ??= []).push(n);
      }
    }
  };

  for (const entry of options.dictionary?.brands ?? []) {
    const name = entry.name.replace(/\s+/g, " ").trim();
    if (name.length < 2) continue;
    const b = byUpper(name) ?? (brands.push({ name, words: [], short: [] }), brands[brands.length - 1]);
    addNames(b, [name, ...entry.aliases]);
  }

  // Марки из памяти бланка — только целой строкой или в начале: «Бытовая
  // техника» подстрокой нашлась бы где угодно.
  for (const raw of options.knownBrands ?? []) {
    const name = raw.replace(/\s+/g, " ").trim();
    const n = compact(name).toUpperCase();
    if (n.length < 3 || !/^[A-Z0-9-]+$/.test(n)) continue;
    const b = byUpper(name);
    if (b) continue;
    brands.push({ name, words: [], short: [n] });
  }

  const noise = [...NOISE, ...(options.dictionary?.noise ?? [])]
    .flatMap((p) => phrase(p));
  return { brands, noise };
}

/** Что встроено в программу — панель показывает это рядом со словарём. */
export const BUILTIN = {
  brands: BRANDS.map((b) => b.name),
  noise: NOISE,
};

function detectBrand(lines: string[], BRANDS: Brand[]): { brand: Brand | null; options: string[] } {
  const score = new Map<Brand, number>();
  const add = (b: Brand, n: number) => score.set(b, (score.get(b) ?? 0) + n);

  for (const line of lines) {
    const c = compact(line).toUpperCase().replace(/[.,;:!]+$/, "");
    if (!c) continue;
    for (const b of BRANDS) {
      if (b.words.some((w) => c.includes(w))) add(b, 4);
      for (const s of b.short ?? []) {
        if (c === s) add(b, 6); // логотип или надпись отдельной строкой
        // «AcerIncorporated», «ASUS Model…» — в начале строки и дальше не буква
        // строчная (иначе «ACERBIC» стал бы брендом).
        else if (c.startsWith(s) && /^[^a-z]/.test(compact(line).slice(s.length))) add(b, 2);
      }
      for (const f of b.families ?? []) if (c.startsWith(f.toUpperCase())) add(b, 3);
      // «Manufactured for Lenovo», «Product of Acer» — производитель прямым текстом.
      if (/MANUFACTUREDFOR|PRODUCTOF|TRADEMARKSOF/.test(c) && b.words.concat(b.short ?? []).some((w) => c.includes(w))) add(b, 3);
    }
    // Логотип ASUS с обрезанной «A» — частый случай на краю кадра.
    const asus = brandByName(BRANDS, "ASUS");
    if (c === "SUS" && asus) add(asus, 2);
    // Модели Samsung начинаются с «NP-».
    const samsung = brandByName(BRANDS, "Samsung");
    if (samsung && /MODEL.*:NP-/.test(keyOf(c))) add(samsung, 2);
  }

  const ranked = [...score.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  return { brand: ranked[0]?.[0] ?? null, options: ranked.map(([b]) => b.name) };
}

// ----------------------------------------------------------------- метки

/**
 * Метки, на которых обрывается значение соседней метки. «S/N:WB06815442P/N:…»
 * без этого списка дал бы серийный номер «WB06815442P».
 */
const STOP = /^(?:P\/N|PN:|MTM:?|MO:|MFD|MFG|CN:|FACTORY|FCC|IC:|SNID|S\/N|SN:|MODEL|INPUT|DATE|PRODUCT|SERIAL|WARRANTY)/i;

/**
 * Значение после метки: латиница, цифры, дефис; до следующей метки.
 * Пробелы — только в модели («HP 250 G7»), и не больше одного подряд: два
 * пробела на шильдике — это уже соседняя колонка.
 */
function valueAfter(rest: string, spaces = false): string {
  const src = rest.replace(/^\s+/, "");
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (i > 0 && STOP.test(src.slice(i).replace(/^\s+/, ""))) break;
    if (ch === " ") {
      if (!spaces || src[i + 1] === " ") break;
      out += ch;
      continue;
    }
    if (!/[A-Za-z0-9\-_.+/#]/.test(ch)) break;
    out += ch;
  }
  return out.replace(/[\s.\-_/]+$/, "");
}

interface Candidate {
  value: string;
  weight: number;
}

function push(list: Candidate[], value: string, weight: number) {
  const v = value.trim();
  if (v.length < 2) return;
  const same = list.find((c) => c.value.toUpperCase() === v.toUpperCase());
  if (same) same.weight = Math.max(same.weight, weight);
  else list.push({ value: v, weight });
}

const ranked = (list: Candidate[]): PlateField | null => {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => b.weight - a.weight);
  return { value: sorted[0].value, options: sorted.map((c) => c.value) };
};

/**
 * «S20-30Touch» → «S20-30 Touch», «Aspire5820T» → «Aspire 5820T».
 *
 * Пробел возвращаем только перед известными словами: «P613G32Miks» — это
 * код комплектации Acer, и «G32 Miks» в нём был бы выдумкой.
 */
function respace(v: string, family?: string): string {
  let s = v.replace(/(\d)(Touch|Pro|Plus|Ultra|Max|Mini|Air|Flip|Slim|Gaming)\b/g, "$1 $2");
  if (family && s.toUpperCase().startsWith(family.toUpperCase()) && s[family.length] !== " ") {
    s = s.slice(0, family.length) + " " + s.slice(family.length);
  }
  return s.replace(/\s+/g, " ").trim();
}

const hasDigit = (s: string) => /\d/.test(s);

// ----------------------------------------------------------------- серийник

const SERIAL_KEYS: Array<[RegExp, number]> = [
  // Dell: сервисный код — это и есть серийный номер, по нему ищут гарантию.
  [/(?:^|[^A-Z])(?:SERVICETAG|SVCTAG)(?:\([^)]*\))?:/, 11],
  [/(?:^|[^A-Z])(?:S\/N|SERIALNUMBER|SERIALNO\.?|SERIAL|SN)(?:\([^)]*\))?:/, 10],
  [/(?:^|[^A-Z])SNID:/, 5],
];

function serialCandidates(lines: string[], barcodes: OcrBarcode[]) {
  const list: Candidate[] = [];

  for (const line of lines) {
    const c = compact(line);
    const u = c.toUpperCase();
    for (const [re, weight] of SERIAL_KEYS) {
      const m = re.exec(u);
      if (!m) continue;
      const v = valueAfter(c.slice(m.index + m[0].length));
      if (v.length >= 5 && hasDigit(v)) push(list, v.toUpperCase(), weight);
    }
    // Acer: серийный номер — строка из 22 знаков без метки (LXR3F0…).
    if (/^(LX|NX|NH|DT|UN)[A-Z0-9]{18,20}$/.test(u)) push(list, u, 9);
  }

  // Штрихкоды. QR ASUS ведёт на qs.asus.com/<серийный номер>.
  const codes: string[] = [];
  for (const b of barcodes) {
    const t = b.text.trim();
    const url = /^https?:\/\/[^/]+\/([A-Za-z0-9]{6,30})\/?$/.exec(t);
    if (url) codes.push(url[1].toUpperCase());
    else if (/^[A-Za-z0-9-]{6,30}$/.test(t) && /[A-Za-z]/.test(t) && hasDigit(t)) codes.push(t.toUpperCase());
  }

  let confirmed = false;
  for (const code of codes) {
    const same = list.find((c) => c.value.toUpperCase() === code);
    if (same) {
      same.weight += 5;
      confirmed = true;
    } else {
      // Код без подтверждения текстом — только запасной вариант.
      push(list, code, list.length ? 3 : 8);
    }
  }

  const field = ranked(list);
  return { field, confirmed: confirmed && !!field && codes.includes(field.value.toUpperCase()) };
}

// ----------------------------------------------------------------- модель

/** «HP 250 G7 Notebook PC» → «250 G7»: бренд уже в своём поле, вид — в своём. */
function cleanModel(v: string, brand: Brand | null, noise: RegExp[] = []): string {
  let s = v.trim();
  // Обрезаем по первой лишней фразе. Совпадение в самом начале не режет:
  // модель «Power 5» — это модель, а не надпись о питании.
  let cut = s.length;
  for (const re of noise) {
    const m = re.exec(s);
    if (m) {
      const at = m.index + m[1].length;
      if (at > 0 && at < cut) cut = at;
    }
  }
  s = s.slice(0, cut).replace(/[\s,;:/-]+$/, "");
  for (const name of brand ? [brand.name, ...(brand.short ?? [])] : []) {
    if (s.toUpperCase().startsWith(name.toUpperCase() + " ")) s = s.slice(name.length + 1);
  }
  return s.replace(/\s+(Notebook(\s+PC)?|Laptop|Series|Touch\s*Screen)$/i, "").trim();
}

function modelCandidates(lines: string[], brand: Brand | null, dict: Dict): Candidate[] {
  const list: Candidate[] = [];
  const clean = (v: string) => cleanModel(v, brand, dict.noise);
  const families = dict.brands.flatMap((b) => (b.families ?? []).map((f) => ({ f, b })));
  let official = "";

  for (const line of lines) {
    const c = compact(line);
    const k = keyOf(c);

    // «Model: D509D», «MODEL NO.(…): ZR7C», «Model Name(…): 20157», «MODEL CODE: NP-…»
    // Между меткой и двоеточием бывает что угодно: «Model/型號：», «MODEL(MODELO/Модель):».
    const m = /^(REG)?MODEL(CODE|NAME|NO\.?|NUMBER)?[^A-Z0-9:(]*(?:\([^)]*\))?[^A-Z0-9:]*:/.exec(k);
    if (m) {
      const v = clean(valueAfter(tailAfter(line, m[0].length), true));
      if (v && hasDigit(v)) {
        const kind = (m[2] ?? "").replace(".", "");
        let weight = kind === "CODE" ? 6 : 10;
        // Dell «Reg Model: P89F» — регистрационный код, не модель.
        if (m[1]) weight = 4;
        // Тип машины Lenovo — одни цифры; регистрационный код Acer — короткий.
        if (/^\d+$/.test(v)) weight = 3;
        else if (brand?.name === "Acer" && kind === "NO") weight = 4;
        push(list, v, weight);
        if (weight >= 10 && !official) official = v.toUpperCase();
      }
    }

    // Семейство: «Aspire 5820T series», «Aspire5820TZG-P613G32Miks».
    for (const { f } of families) {
      if (!c.toUpperCase().startsWith(f.toUpperCase())) continue;
      const p = plain(line);
      const series = /\s*series$/i.test(p);
      const raw = p.replace(/\s*series$/i, "");
      if (!hasDigit(raw) || raw.length > 40) continue;
      const value = clean(respace(raw, f));
      if (value && hasDigit(value)) push(list, value, series ? 11 : 7);
    }

    // Бренд и модель одной строкой: «Lenovo G580», «LenovoS20-30Touch».
    if (brand) {
      for (const name of [brand.name, ...(brand.short ?? [])]) {
        if (!c.toUpperCase().startsWith(name.toUpperCase())) continue;
        const rest = c.slice(name.length);
        if (!/^[A-Z0-9]/.test(rest) || !hasDigit(rest) || rest.length > 25) continue;
        if (/COMPUTER|INC|ELECTRON|CORP|MODEL|TEK/i.test(rest)) continue;
        // Из исходной строки: «HP 250 G7» с пробелами, «LenovoS20-30Touch» — без.
        const value = clean(plain(tailAfter(line, name.length)));
        if (value) push(list, respace(value), brand.name === "Lenovo" ? 12 : 8);
      }
    }

    // Партномера Lenovo и HP — последним запасным вариантом.
    const pn = /(?:^|[^A-Z])(P\/N|MTM|PRODUCT(?:NO\.?|NUMBER)?):/.exec(c.toUpperCase());
    if (pn) {
      const v = valueAfter(c.slice(pn.index + pn[0].length));
      if (v.length >= 5) push(list, v, 2);
    }
  }

  // Полный код ASUS и Samsung отдельной строкой: «D509DJ-BQ068» рядом с «D509D».
  if (official) {
    for (const line of lines) {
      const u = compact(line).toUpperCase();
      if (u !== official && u.startsWith(official) && /^[A-Z0-9]+-[A-Z0-9]+$/.test(u)) push(list, u, 7);
    }
  }
  return list;
}

// ----------------------------------------------------------------- вид

const KINDS: Array<[RegExp, string]> = [
  [/NOTEBOOK|LAPTOP|НОУТБУК|HOYT6YK|筆記型|笔记本|筆記本|便携式计算机/i, "Ноутбук"],
  [/TABLET|ПЛАНШЕТ/i, "Планшет"],
  [/SMARTPHONE|MOBILEPHONE|CELLULARPHONE|СМАРТФОН/i, "Телефон"],
  [/ALL-?IN-?ONE/i, "Моноблок"],
  [/LCDMONITOR|^MONITOR/i, "Монитор"],
  [/PRINTER|МФУ/i, "Принтер / МФУ"],
  [/ROUTER|WIRELESSAP|МАРШРУТИЗАТОР/i, "Сетевое оборудование"],
];

function detectKind(lines: string[]): string | null {
  for (const [re, kind] of KINDS) if (lines.some((l) => re.test(l.replace(/\s+/g, "")))) return kind;
  return null;
}

// ----------------------------------------------------------------- сборка

export function parsePlate(ocr: OcrResult, options: ParseOptions = {}): PlateResult {
  const dict = buildDictionary(options);
  const lines = ocr.lines.map((l) => normalize(l.text)).filter(Boolean);
  const { brand, options: brandOptions } = detectBrand(lines, dict.brands);
  const serial = serialCandidates(lines, ocr.barcodes ?? []);
  const model = ranked(modelCandidates(lines, brand, dict));

  return {
    brand: brand ? { value: brand.name, options: brandOptions } : null,
    model,
    serial: serial.field,
    serialConfirmed: serial.confirmed,
    kind: detectKind(lines),
    text: ocr.lines.map((l) => l.text),
  };
}
