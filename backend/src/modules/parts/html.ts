/**
 * Маленький разборщик HTML для страниц поиска магазинов.
 *
 * Своя реализация вместо библиотеки: страницы поиска простые, а новая
 * зависимость у сервера — лишний шаг при каждой сборке программы (её модули
 * копируются в установщик как есть). Разборщик терпимый: незакрытые и лишние
 * закрывающие теги не ломают дерево, неизвестное просто пропускается.
 *
 * Селекторы — то, что нужно читалкам: `tag`, `.class`, `#id`, `[attr]`,
 * `[attr=value]`, `[attr*=value]`, их сочетания (`div.price.big`), потомок
 * через пробел и прямой потомок через `>`, несколько вариантов через запятую.
 */

export interface HNode {
  tag: string; // "" — текст
  attrs: Record<string, string>;
  children: HNode[];
  parent: HNode | null;
  text?: string;
}

const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);
/** Содержимое этих тегов — сырой текст, внутри не ищем тегов. */
const RAW = new Set(["script", "style", "textarea", "title"]);
/** Открытие такого тега закрывает незакрытый такой же (типичная небрежность разметки). */
const SELF_NESTING_CLOSE: Record<string, string[]> = {
  li: ["li"],
  p: ["p"],
  option: ["option"],
  tr: ["tr", "td", "th"],
  td: ["td", "th"],
  th: ["td", "th"],
};

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", laquo: "«", raquo: "»",
  mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", times: "×",
  deg: "°", plusmn: "±", copy: "©", reg: "®", trade: "™", bull: "•", middot: "·", rub: "₽", euro: "€",
};

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);?/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    const v = NAMED[body.toLowerCase()];
    return v ?? m;
  });
}

const ATTR_RE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(src))) {
    const name = m[1].toLowerCase();
    if (name in out) continue;
    out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

export function parseHtml(html: string): HNode {
  const root: HNode = { tag: "#root", attrs: {}, children: [], parent: null };
  let cur = root;
  let i = 0;
  const n = html.length;

  const addText = (t: string) => {
    if (!t) return;
    cur.children.push({ tag: "", attrs: {}, children: [], parent: cur, text: decodeEntities(t) });
  };

  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      addText(html.slice(i));
      break;
    }
    if (lt > i) addText(html.slice(i, lt));
    i = lt;

    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html[i + 1] === "!" || html[i + 1] === "?") {
      const end = html.indexOf(">", i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (html[i + 1] === "/") {
      const end = html.indexOf(">", i);
      const name = html.slice(i + 2, end < 0 ? n : end).trim().toLowerCase();
      i = end < 0 ? n : end + 1;
      // Закрываем ближайший открытый с таким именем; лишний закрывающий — пропускаем.
      let p: HNode | null = cur;
      while (p && p !== root && p.tag !== name) p = p.parent;
      if (p && p !== root) cur = p.parent!;
      continue;
    }
    const m = /^<([a-zA-Z][\w:-]*)/.exec(html.slice(i, i + 64));
    if (!m) {
      addText("<");
      i += 1;
      continue;
    }
    const tag = m[1].toLowerCase();
    // Конец открывающего тега: ищем ">" вне кавычек.
    let j = i + m[0].length;
    let q: string | null = null;
    for (; j < n; j++) {
      const c = html[j];
      if (q) {
        if (c === q) q = null;
      } else if (c === '"' || c === "'") q = c;
      else if (c === ">") break;
    }
    const inner = html.slice(i + m[0].length, j);
    const selfClosed = inner.trimEnd().endsWith("/");
    i = j + 1;

    const closes = SELF_NESTING_CLOSE[tag];
    if (closes) {
      let p: HNode | null = cur;
      // Только в пределах ближайшего контейнера-таблицы/списка — дальше не лезем.
      while (p && p !== root && !["ul", "ol", "table", "tbody", "thead", "select", "div"].includes(p.tag)) {
        if (closes.includes(p.tag)) {
          cur = p.parent!;
          break;
        }
        p = p.parent;
      }
    }

    const node: HNode = { tag, attrs: parseAttrs(inner.replace(/\/\s*$/, "")), children: [], parent: cur };
    cur.children.push(node);
    if (VOID.has(tag) || selfClosed) continue;
    if (RAW.has(tag)) {
      const close = html.toLowerCase().indexOf(`</${tag}`, i);
      const end = close < 0 ? n : close;
      node.children.push({ tag: "", attrs: {}, children: [], parent: node, text: html.slice(i, end) });
      const gt = close < 0 ? n : html.indexOf(">", close);
      i = gt < 0 ? n : gt + 1;
      continue;
    }
    cur = node;
  }
  return root;
}

// ------------------------------------------------------------ селекторы

interface Simple {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: { name: string; op?: "=" | "*=" | "^="; value?: string }[];
}
type Step = { simple: Simple; combinator: " " | ">" };

function parseSimple(s: string): Simple {
  const out: Simple = { classes: [], attrs: [] };
  const re = /([a-zA-Z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([\w-]+)(?:(\*=|\^=|=)["']?([^"'\]]*)["']?)?\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m[1]) out.tag = m[1].toLowerCase();
    else if (m[2]) out.classes.push(m[2]);
    else if (m[3]) out.id = m[3];
    else if (m[4]) out.attrs.push({ name: m[4].toLowerCase(), op: m[5] as Simple["attrs"][number]["op"], value: m[6] });
  }
  return out;
}

function parseSelector(sel: string): Step[][] {
  return sel.split(",").map((part) => {
    const steps: Step[] = [];
    const tokens = part.trim().replace(/\s*>\s*/g, " > ").split(/\s+/);
    let comb: " " | ">" = " ";
    for (const t of tokens) {
      if (!t) continue;
      if (t === ">") {
        comb = ">";
        continue;
      }
      steps.push({ simple: parseSimple(t), combinator: comb });
      comb = " ";
    }
    return steps;
  });
}

function classesOf(n: HNode): string[] {
  return (n.attrs.class ?? "").split(/\s+/).filter(Boolean);
}

function matchSimple(n: HNode, s: Simple): boolean {
  if (!n.tag || n.tag === "#root") return false;
  if (s.tag && n.tag !== s.tag) return false;
  if (s.id && n.attrs.id !== s.id) return false;
  if (s.classes.length) {
    const cls = classesOf(n);
    if (!s.classes.every((c) => cls.includes(c))) return false;
  }
  for (const a of s.attrs) {
    const v = n.attrs[a.name];
    if (v === undefined) return false;
    if (a.op === "=" && v !== a.value) return false;
    if (a.op === "*=" && !v.includes(a.value ?? "")) return false;
    if (a.op === "^=" && !v.startsWith(a.value ?? "")) return false;
  }
  return true;
}

/** Подходит ли узел под цепочку шагов (проверка справа налево). */
function matchSteps(n: HNode, steps: Step[], idx: number, scope: HNode): boolean {
  if (!matchSimple(n, steps[idx].simple)) return false;
  if (idx === 0) return true;
  const comb = steps[idx].combinator;
  let p = n.parent;
  if (comb === ">") return !!p && p !== scope.parent && matchSteps(p, steps, idx - 1, scope);
  while (p && p !== scope.parent) {
    if (matchSteps(p, steps, idx - 1, scope)) return true;
    p = p.parent;
  }
  return false;
}

function walk(n: HNode, fn: (x: HNode) => void) {
  for (const c of n.children) {
    if (c.tag) {
      fn(c);
      walk(c, fn);
    }
  }
}

export function queryAll(scope: HNode, selector: string): HNode[] {
  const groups = parseSelector(selector);
  const out: HNode[] = [];
  walk(scope, (n) => {
    if (groups.some((steps) => steps.length && matchSteps(n, steps, steps.length - 1, scope))) out.push(n);
  });
  return out;
}

export function query(scope: HNode, selector: string): HNode | null {
  return queryAll(scope, selector)[0] ?? null;
}

/** Видимый текст узла: без скриптов и стилей, пробелы схлопнуты. */
export function textOf(n: HNode | null | undefined): string {
  if (!n) return "";
  const parts: string[] = [];
  const rec = (x: HNode) => {
    if (!x.tag) {
      parts.push(x.text ?? "");
      return;
    }
    if (x.tag === "script" || x.tag === "style") return;
    if (x.tag === "br") parts.push(" ");
    for (const c of x.children) rec(c);
    if (/^(div|p|li|tr|td|h\d)$/.test(x.tag)) parts.push(" ");
  };
  rec(n);
  return parts.join("").replace(/[\s\u00a0]+/g, " ").trim();
}

export function attrOf(n: HNode | null | undefined, name: string): string {
  return n?.attrs[name.toLowerCase()] ?? "";
}

/** Сырой текст тега (содержимое script). */
export function rawOf(n: HNode | null | undefined): string {
  return n?.children.map((c) => c.text ?? "").join("") ?? "";
}
