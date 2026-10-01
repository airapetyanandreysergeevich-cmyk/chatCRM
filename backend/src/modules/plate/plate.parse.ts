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
  /**
   * Откуда марка: прочитана на шильдике или выведена из модели — по правилу
   * словаря или по тому, что мастерские уже вписывали для этой модели.
   * Выведенную приёмщику стоит глянуть: на шильдике её не было.
   */
  brandFrom: "plate" | "model" | null;
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
  /**
   * Серии: по ним понятна и марка, и где начинается модель. Ищутся в любом
   * месте строки, с границы слова и с заглавной буквы: «SKU:Cyborg 15A13UDX»,
   * «ASUS VivoBook 15».
   */
  families?: string[];
  /**
   * Серии с общими словами (Modern, Flex, Envy, Surface): в середине строки
   * — только если сразу за ними номер («Modern 14», «Flex 5», «Pulse GL66»),
   * иначе «Modern» нашлось бы в любой фразе. В начале строки — как раньше.
   */
  weak?: string[];
}

/*
 * Серии марок собраны по списку Андрея от 30.09.2026. Убрано то, что
 * встречается у нескольких марок (Chromebook, G/P/X/M Series, Titan у
 * Maibenben, Zero), и сочетания серии с цифрами (VivoBook15, ThinkPadT14):
 * модель после серии находится сама.
 */
const BRANDS: Brand[] = [
  { name: "ASUS", words: ["ASUSTEK"], short: ["ASUS"],
    families: ["VivoBook", "ZenBook", "ExpertBook", "ProArt", "Zephyrus", "Strix", "StudioBook", "Republic of Gamers", "TUF Gaming"],
    weak: ["ROG", "TUF", "Transformer"] },
  { name: "Lenovo", words: ["LENOVO"], families: ["IdeaPad", "ThinkPad", "ThinkBook", "Legion"], weak: ["Yoga", "LOQ", "Flex"] },
  { name: "Acer", words: ["ACERINC", "ACERINCORPORATED"], short: ["ACER"],
    families: ["Aspire", "TravelMate", "Extensa", "Predator", "ConceptD", "Ferrari"], weak: ["Nitro", "Swift", "Spin", "Enduro"] },
  { name: "Samsung", words: ["SAMSUNG"], weak: ["Galaxy"] },
  { name: "HP", words: ["HEWLETT", "HPINC"], short: ["HP"],
    families: ["Pavilion", "ProBook", "EliteBook", "Victus", "Spectre", "Dragonfly", "ZBook", "EliteFolio"],
    weak: ["Envy", "Omen", "Stream", "Fortis"] },
  { name: "Dell", words: ["DELLINC"], short: ["DELL"], families: ["Inspiron", "Latitude", "Vostro", "Alienware"], weak: ["XPS", "Precision"] },
  { name: "Apple", words: ["DESIGNEDBYAPPLE", "APPLEINC"], short: ["APPLE"], families: ["MacBook", "PowerBook"], weak: ["iMac", "iPad", "iPhone", "iBook"] },
  { name: "MSI", words: ["MICRO-STAR", "MICROSTAR"], short: ["MSI"],
    families: ["Cyborg", "Raider", "Stealth", "Katana", "Crosshair", "Prestige", "Leopard", "Apache"],
    weak: ["Titan", "Vector", "Pulse", "Sword", "Thin", "Creator", "Summit", "Modern", "Venture", "Alpha", "Bravo", "Delta"] },
  { name: "Huawei", words: ["HUAWEI"], families: ["MateBook"] },
  { name: "Honor", words: ["HONORDEVICE"], short: ["HONOR"], families: ["MagicBook"] },
  { name: "Xiaomi", words: ["XIAOMI"], families: ["RedmiBook", "Mi Notebook"], weak: ["Redmi"] },
  { name: "Toshiba", words: ["TOSHIBA"], families: ["Satellite"], weak: ["Tecra"] },
  { name: "Sony", words: [], short: ["SONY"], weak: ["VAIO"] },
  { name: "Fujitsu", words: ["FUJITSU"], families: ["Lifebook"] },
  { name: "Gigabyte", words: ["GIGABYTE"], families: ["AORUS"], weak: ["Aero", "Sabre"] },
  { name: "Packard Bell", words: ["PACKARDBELL"] },
  { name: "eMachines", words: ["EMACHINES"] },
  { name: "Microsoft", words: ["MICROSOFTSURFACE"], weak: ["Surface"] },
  { name: "LG", words: ["LGELECTRONICS"], weak: ["Gram"] },
  { name: "Maibenben", words: ["MAIBENBEN"] },
  { name: "Thunderobot", words: ["THUNDEROBOT"] },
  { name: "DEXP", words: [], short: ["DEXP"] },
  { name: "Irbis", words: [], short: ["IRBIS"] },
  { name: "Digma", words: [], short: ["DIGMA"] },
  { name: "Chuwi", words: [], short: ["CHUWI"] },
  { name: "Infinix", words: ["INFINIX"] },
  { name: "Tecno", words: [], short: ["TECNO"] },
  { name: "Realme", words: [], short: ["REALME"] },
];

// ----------------------------------------------------------------- марка по модели

/**
 * Марка по модели — для шильдиков, где марки нет вовсе: наклейка без
 * логотипа, логотип отрезан краем кадра, стёрт.
 *
 * Шаблон сравнивается с моделью целиком, без учёта регистра и пробелов:
 *   *  — любые знаки, в том числе никаких;
 *   #  — одна цифра;
 *   @  — одна латинская буква;
 *   ?  — одна буква или цифра.
 * Дефис в шаблоне необязателен в модели: распознаватель его теряет.
 *
 * Встроенные правила нарочно осторожные: неверная марка хуже пустой — пустую
 * приёмщик заметит сам. Поэтому почти везде после цифр требуется буква:
 * «E410MA» — ASUS, а «E480» — ThinkPad, и его правило не трогает. Серии без
 * надёжного признака (MateBook и MagicBook, ThinkCentre, телефоны) сюда не
 * входят — их марку дадут словарь платформы и память мастерских.
 */
export interface ModelRule {
  brand: string;
  patterns: RegExp[];
}

const MODEL_RULES: Array<{ brand: string; patterns: string[] }> = [
  {
    brand: "ASUS",
    patterns: [
      "X4##@*", "X5##@*", "X7##@*", "X1###@*", "K5##@*", "K3###@*", "K6###@*",
      "D5##@*", "D7##@*", "M5##@*", "M1###@*", "M3###@*", "M6###@*",
      "E2##@*", "E4##@*", "E5##@*", "F5##@*", "S4##@*", "S5##@*", "S5###@*", "R5##@*", "N5##@*", "N7##@*",
      "UX###*", "UM###*", "GL###*", "GU###*", "GA###*", "GV###*", "GX###*", "FX###*", "FA###*",
      "TP###*", "B1###@*", "P1###@*",
    ],
  },
  {
    brand: "Acer",
    patterns: [
      "N##@#", "A###-##*", "AN###-##*", "SF###-##*", "SP###-##*", "PH###-##*", "EX2##-##*", "TMP2##-##*",
      "ES1-###*", "E1-###*", "E5-###*", "V3-###*", "V5-###*", "MS2###",
    ],
  },
  { brand: "HP", patterns: ["TPN-*", "1#-@@#*", "1#S-@@#*", "2##G#*", "3##G#*", "4##G#*"] },
  { brand: "Dell", patterns: ["P##F*", "P##G*", "P##E*", "P##T*", "P###F*", "P###G*"] },
  { brand: "Apple", patterns: ["A1###", "A2###", "A3###"] },
  {
    brand: "MSI",
    patterns: ["MS-1#??*", "MS-7#??*", "GF##", "GF##@*", "GP##", "GP##@*", "GE##", "GE##@*", "GS##", "GS##@*", "GL##", "GL##@*"],
  },
  { brand: "Samsung", patterns: ["NP-*", "SM-@###*"] },
  { brand: "Sony", patterns: ["PCG-*", "SVF###*", "SVE###*", "SVS###*", "SVP###*", "VPC@@*"] },
  {
    brand: "Lenovo",
    patterns: [
      "###-1#@*", "@###-1#@*", "###@-1#@*", "V1#-@@@*", "B5#-##*", "G5#-##*", "G7#-##*", "Z5#-##*",
      "B5#0", "G5#0", "G7#0", "Z5#0",
    ],
  },
  { brand: "Xiaomi", patterns: ["TM1###*", "XMA####*"] },
];

/** Шаблон — в выражение. Пустой или из одних звёздочек не годится: совпал бы со всем. */
export function patternToRegExp(pattern: string): RegExp | null {
  const p = pattern.replace(/\s+/g, "").toUpperCase();
  if (p.replace(/[*\-]/g, "").length < 2) return null;
  let body = "";
  for (const ch of p) {
    if (ch === "*") body += ".*";
    else if (ch === "#") body += "\\d";
    else if (ch === "@") body += "[A-Z]";
    else if (ch === "?") body += "[A-Z0-9]";
    else if (ch === "-") body += "-?";
    else body += ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^${body}$`);
}

/** Модель в вид, с которым сравниваются шаблоны: заглавные, без пробелов. */
const ruleForm = (model: string) => model.replace(/\s+/g, "").toUpperCase();

/** Марки, чьи правила подходят к модели, — по порядку правил. */
export function brandsByRules(model: string, rules: ModelRule[]): string[] {
  const m = ruleForm(model);
  if (!m) return [];
  const out: string[] = [];
  for (const r of rules) {
    if (!out.includes(r.brand) && r.patterns.some((re) => re.test(m))) out.push(r.brand);
  }
  return out;
}

/**
 * Ключи модели для сравнения с тем, что уже вписано в заказах: сама модель
 * без знаков и её основа — начало до разделителя. «X515EA-BQ1234» и «X515EA»,
 * «NP-R710H-FS06RU» и «NP-R710H» — одна модель в разной комплектации, и марка
 * у них одна.
 *
 * Основа — самое короткое начало до разделителя, в котором есть и буква, и
 * цифра и не меньше четырёх знаков: «NP» от «NP-R710H» или «250» от
 * «250 G7» ничего не значат, поэтому берётся следующее — «NPR710H».
 */
export function modelKeys(model: string): string[] {
  const up = model.trim().toUpperCase();
  const full = up.replace(/[^A-Z0-9]/g, "");
  if (full.length < 3 || !/\d/.test(full)) return [];
  const keys = [full];
  const parts = up.split(/[\s\-/(_.]+/);
  let base = "";
  for (let i = 0; i < parts.length - 1; i++) {
    base += parts[i].replace(/[^A-Z0-9]/g, "");
    if (base.length >= 4 && /\d/.test(base) && /[A-Z]/.test(base)) {
      if (base !== full) keys.push(base);
      break;
    }
  }
  return keys;
}

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
  /**
   * Марка по модели — для шильдиков, где марки нет: «ASUS: X5##@*, D5##@*».
   * Необязательное: словари, сохранённые до этого поля, остаются рабочими.
   */
  models?: Array<{ brand: string; patterns: string[] }>;
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
  /** Правила «модель → марка»: сначала словарь платформы, потом встроенные. */
  models: ModelRule[];
}

const brandByName = (brands: Brand[], name: string) => brands.find((b) => b.name === name) ?? null;

/** Встроенные марки плюс словарь платформы плюс марки мастерской. */
export function buildDictionary(options: ParseOptions = {}): Dict {
  const brands: Brand[] = BRANDS.map((b) => ({
    ...b,
    words: [...b.words],
    short: [...(b.short ?? [])],
    families: [...(b.families ?? [])],
    weak: [...(b.weak ?? [])],
  }));
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
    const b = byUpper(name) ?? (brands.push({ name, words: [], short: [], families: [], weak: [] }), brands[brands.length - 1]);
    addNames(b, [name, ...entry.aliases]);
    // Другое написание — это и серия: «MSI: Cyborg» даёт не только марку, но
    // и модель из строки «Cyborg 15 A13UDX». Короткое — осторожной серией.
    for (const raw of entry.aliases) {
      const a = raw.replace(/\s+/g, " ").trim();
      if (compact(a).length < 3 || !/[A-Za-z]/.test(a)) continue;
      const known = [...(b.families ?? []), ...(b.weak ?? [])].some((f) => compact(f).toUpperCase() === compact(a).toUpperCase());
      if (known) continue;
      if (compact(a).length >= 6) (b.families ??= []).push(a);
      else (b.weak ??= []).push(a);
    }
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

  // Марку из правила словаря пишем так, как она названа среди марок: правило
  // «asus: …» не должно заводить в бланке вторую «asus» рядом с «ASUS».
  const models: ModelRule[] = [];
  for (const rule of [...(options.dictionary?.models ?? []), ...MODEL_RULES]) {
    const name = rule.brand.replace(/\s+/g, " ").trim();
    if (name.length < 2) continue;
    const patterns = rule.patterns.map(patternToRegExp).filter((re): re is RegExp => !!re);
    if (patterns.length) models.push({ brand: byUpper(name)?.name ?? name, patterns });
  }
  return { brands, noise, models };
}

/** Что встроено в программу — панель показывает это рядом со словарём. */
export const BUILTIN = {
  brands: BRANDS.map((b) => b.name),
  series: BRANDS.filter((b) => b.families?.length || b.weak?.length).map((b) => ({
    brand: b.name,
    series: [...(b.families ?? []), ...(b.weak ?? [])],
  })),
  noise: NOISE,
  models: MODEL_RULES.map((r) => ({ brand: r.brand, patterns: [...r.patterns] })),
};

// ----------------------------------------------------------------- серии

const esc = (ch: string) => ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const seriesCache = new Map<string, RegExp>();

/**
 * Где в строке начинается серия, или -1.
 *
 * Регистр не важен, пробелы внутри серии тоже («Mi Notebook», «MiNotebook»),
 * но серия должна начинаться словом: слева не буква — или строчная буква
 * перед заглавной, как в слипшемся «LenovoIdeaPad». И начинаться с той же
 * буквы, что в названии серии, в верхнем регистре: «surface» в «do not place
 * on soft surface» — это не Microsoft.
 *
 * Осторожная серия в середине строки считается, только если за ней номер:
 * «Modern 14», «Pulse GL66», «Flex 5».
 */
export function seriesAt(line: string, series: string, weak: boolean): number {
  const letters = [...compact(series)];
  if (letters.length < 2) return -1;
  let re = seriesCache.get(series);
  if (!re) {
    re = new RegExp(letters.map(esc).join("\\s*"), "gi");
    seriesCache.set(series, re);
  }
  re.lastIndex = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    const at = m.index;
    const first = line[at];
    const prev = at > 0 ? line[at - 1] : "";
    const next = line.slice(at + m[0].length);
    re.lastIndex = at + 1;
    // Серия с заглавной — и в тексте с заглавной; «iPad» — как угодно.
    const wantLower = letters[0] !== letters[0].toUpperCase();
    if (!wantLower && first !== first.toUpperCase()) continue;
    const boundary = !prev || !/[A-Za-z]/.test(prev) || (/[a-z]/.test(prev) && /[A-Z]/.test(first));
    if (!boundary) continue;
    if (/^[a-z]/.test(next)) continue; // «Aspired», «Modernized»
    if (weak && at > 0 && !/^\s*[A-Za-z]{0,3}\d/.test(next)) continue;
    return at;
  }
  return -1;
}

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
      const p = plain(line);
      if ((b.families ?? []).some((f) => seriesAt(p, f, false) >= 0)) add(b, 3);
      else if ((b.weak ?? []).some((f) => c.startsWith(compact(f).toUpperCase()) || seriesAt(p, f, true) >= 0)) add(b, 3);
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
const STOP = /^(?:P\/N|PN:|MTM:?|MO:|MFD|MFG|CN:|FACTORY|FCC|IC:|SNID|S\/N|SN:|MODEL|INPUT|DATE|PRODUCT|SERIAL|WARRANTY|CHK:|SKU:|SUPPORT)/i;

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

/**
 * Модель из строки, начинающейся с серии, — с весами.
 *
 *  • «Aspire 5820T series» — лучший случай, так Acer и пишет модель (11);
 *  • хвост комплектации отрезается: «Cyborg 15A13UDX-2010XRU-TB5134…» →
 *    «Cyborg 15 A13UDX». Хвостом считается всё после первого дефиса, если
 *    дефисов два и больше или после дефиса больше шести знаков. Дефис внутри
 *    модели («S145-15IWL», «G50-30») остаётся. Полная строка — запасной
 *    вариант;
 *  • склейку «15A13UDX» распознавателя разделяем: 15 — диагональ, A13UDX —
 *    модель. Коротко «Cyborg 15» — тоже вариант кнопкой;
 *  • серия, диагональ и код модели вместе точны, как метка Model (10,5);
 *    серия с одним номером — запасной вариант (7).
 */
function seriesModels(raw: string, family: string, series: boolean): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const full = respace(raw, family);
  const parts = full.split("-");
  const cut = parts.length > 2 || (parts.length === 2 && parts[1].replace(/\s/g, "").length >= 6);
  let head = cut ? parts[0].trim() : full;
  // «Cyborg 15A13UDX» → «Cyborg 15 A13UDX»
  head = head.replace(/^(\S+(?:\s\S+)?\s)(\d{2})([A-Z]{1,2}\d{1,3}[A-Z]{0,4})\b/, "$1$2 $3");
  // «Cyborg 15 A13UDX»: серия (буквы), диагональ, код модели.
  const withCode = /^(\D+\s\d{2})\s[A-Z]{1,2}\d/.exec(head);
  if (series) out.push([head, 11]);
  else out.push([head, withCode ? 10.5 : 7]);
  if (withCode) out.push([withCode[1], 6.5]);
  if (cut) out.push([full, 5]);
  return out;
}

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
  const families = dict.brands.flatMap((b) => [
    ...(b.families ?? []).map((f) => ({ f, b, weak: false })),
    ...(b.weak ?? []).map((f) => ({ f, b, weak: true })),
  ]);
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

    // Серия: «Aspire 5820T series», «Aspire5820TZG-P613G32Miks»,
    // «SKU:Cyborg 15A13UDX-2010XRU-TB51342H16GXXDXX». Модель — от серии
    // до конца строки или до следующей метки.
    for (const { f, weak } of families) {
      const p = plain(line);
      const at = seriesAt(p, f, weak);
      const legacy = at < 0 && c.toUpperCase().startsWith(compact(f).toUpperCase());
      if (at < 0 && !legacy) continue;
      const tail = legacy ? p : p.slice(at);
      const series = /\s*series$/i.test(tail);
      const raw = valueAfter(tail.replace(/\s*series$/i, ""), true);
      if (!hasDigit(raw) || raw.length > 60) continue;
      for (const [v, w] of seriesModels(raw, f, series)) {
        const value = clean(v);
        if (value && hasDigit(value)) push(list, value, w);
      }
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

  // Марки на шильдике нет — пробуем понять её по модели. Варианты модели по
  // порядку: основной первым, но и запасной (регистрационный код Acer, TPN
  // у HP) бывает как раз тем, что узнаётся.
  let brandField: PlateField | null = brand ? { value: brand.name, options: brandOptions } : null;
  let brandFrom: PlateResult["brandFrom"] = brand ? "plate" : null;
  if (!brandField && model) {
    const found: string[] = [];
    for (const m of model.options) for (const b of brandsByRules(m, dict.models)) if (!found.includes(b)) found.push(b);
    if (found.length) {
      brandField = { value: found[0], options: found };
      brandFrom = "model";
    }
  }

  return {
    brand: brandField,
    brandFrom,
    model,
    serial: serial.field,
    serialConfirmed: serial.confirmed,
    kind: detectKind(lines),
    text: ocr.lines.map((l) => l.text),
  };
}
