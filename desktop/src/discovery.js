"use strict";

const dgram = require("dgram");
const os = require("os");

/**
 * Поиск Основы в локальной сети.
 *
 * Сотрудник ставит программу на свой компьютер и должен как-то узнать адрес
 * Основы. Переписывать с чужого экрана «http://192.168.1.40:7373» — верный
 * способ ошибиться в цифре, а спросить некого: владелец занят. Поэтому
 * программа ищет сама, двумя путями.
 *
 * 1. Спрашивает сеть. Один широковещательный пакет «кто тут FineCRM?», и
 *    Основа отвечает своим портом. Это доли секунды, и так находится почти
 *    всегда.
 *
 * 2. Если никто не ответил — перебирает соседние адреса и стучится в каждый
 *    по HTTP. Широковещательные пакеты режут некоторые роутеры и точки
 *    доступа, а обычные запросы к порту Основы проходят везде, где вообще
 *    можно работать: ровно так клиент потом и будет с ней разговаривать.
 *
 * Кого бы ни нашёл первый или второй путь, окончательно проверяет один и тот
 * же запрос — /api/health. Он же сообщает название и номер мастерской: по
 * названию человек узнаёт свою, а по номеру программа найдёт её снова, когда
 * роутер выдаст Основе другой адрес.
 *
 * Чего поиск не умеет и уметь не может: гостевой Wi-Fi с изоляцией клиентов
 * (там компьютеры не видят друг друга вовсе), Основа в другой подсети,
 * доступ через интернет. Для этого остаётся ручной ввод адреса.
 */

/** Порт для поиска: тот же номер, что у Основы, но UDP — одно правило помнить проще. */
const DISCOVERY_PORT = 7373;
/** Порт Основы по умолчанию — на нём перебираем соседей. */
const DEFAULT_PORT = 7373;

const QUERY = { finecrm: "where", v: 1 };

/** Разобрать пакет: чужие и испорченные просто пропускаем. */
function parse(buf) {
  if (!buf || buf.length > 512) return null;
  try {
    const data = JSON.parse(buf.toString("utf8"));
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Основа

/**
 * Отвечать на поиск.
 *
 * Отвечаем только портом — всё остальное клиент спросит у самой Основы по
 * HTTP. Так ответчику нечего знать и нечего выдать, а проверка «это точно
 * FineCRM» остаётся одна, настоящая.
 *
 * Не поднялся (порт занят другой программой, запретил брандмауэр) — не беда:
 * Основа работает как работала, сотрудники найдут её перебором или по адресу.
 */
function startResponder({ port, discoveryPort = DISCOVERY_PORT, host = "0.0.0.0", log = () => {} }) {
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  let closed = false;

  sock.on("message", (msg, rinfo) => {
    const q = parse(msg);
    if (!q || q.finecrm !== "where") return;
    const reply = Buffer.from(JSON.stringify({ finecrm: "here", v: 1, port }), "utf8");
    sock.send(reply, rinfo.port, rinfo.address, () => undefined);
  });

  sock.on("error", (err) => {
    log(`Поиск Основы в сети недоступен: ${err.message}`);
    if (!closed) {
      closed = true;
      try {
        sock.close();
      } catch {
        /* уже закрыт */
      }
    }
  });

  sock.bind(discoveryPort, host, () => log(`Отвечаю на поиск в сети, UDP ${discoveryPort}`));

  return {
    close() {
      if (closed) return;
      closed = true;
      try {
        sock.close();
      } catch {
        /* уже закрыт */
      }
    },
  };
}

// ---------------------------------------------------------------- клиент

const toInt = (ip) => ip.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
const toIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

/**
 * Сетевые карты, в которых стоит искать.
 *
 * Только IPv4 и только настоящие: внутренние (127.x) и «самоназначенные»
 * (169.254.x — так Windows называет карту, до которой не дошёл роутер) ни к
 * какой Основе не приведут.
 */
function lanInterfaces() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family !== "IPv4" && net.family !== 4) continue;
      if (net.internal) continue;
      if (net.address.startsWith("169.254.")) continue;
      out.push({ address: net.address, netmask: net.netmask });
    }
  }
  return out;
}

/** Широковещательный адрес подсети: 192.168.1.40/24 → 192.168.1.255. */
function broadcastOf({ address, netmask }) {
  const mask = toInt(netmask);
  return toIp((toInt(address) & mask) | (~mask >>> 0));
}

/**
 * Какие адреса перебирать.
 *
 * Подсеть больше /24 (у крупных офисов бывает /16 — шестьдесят пять тысяч
 * адресов) целиком не обходим: это минуты, а Основа почти наверняка рядом.
 * Берём две сотни с половиной адресов вокруг своего.
 */
function scanTargets(iface) {
  const own = toInt(iface.address);
  let mask = toInt(iface.netmask);
  if (mask < toInt("255.255.255.0")) mask = toInt("255.255.255.0");
  const net = (own & mask) >>> 0;
  const last = (net | (~mask >>> 0)) >>> 0;
  const out = [];
  for (let n = net + 1; n < last; n += 1) if (n !== own) out.push(toIp(n));
  return out;
}

/**
 * Спросить сеть и собрать ответы.
 *
 * Шлём и на общий широковещательный адрес, и на адрес каждой подсети: Windows
 * отправляет 255.255.255.255 только через одну, «главную» карту, и на
 * компьютере с проводом и Wi-Fi вторая сеть иначе осталась бы неопрошенной.
 */
function askNetwork({ targets, discoveryPort = DISCOVERY_PORT, waitMs = 1200 }) {
  return new Promise((resolve) => {
    const found = new Map();
    const sock = dgram.createSocket("udp4");
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        sock.close();
      } catch {
        /* уже закрыт */
      }
      resolve([...found.values()]);
    };

    sock.on("message", (msg, rinfo) => {
      const a = parse(msg);
      if (!a || a.finecrm !== "here" || !Number.isInteger(a.port)) return;
      found.set(`${rinfo.address}:${a.port}`, { ip: rinfo.address, port: a.port });
    });
    sock.on("error", finish);

    sock.bind(0, () => {
      try {
        sock.setBroadcast(true);
      } catch {
        /* без широковещания останутся прямые адреса */
      }
      const packet = Buffer.from(JSON.stringify(QUERY), "utf8");
      for (const target of targets) sock.send(packet, discoveryPort, target, () => undefined);
      setTimeout(finish, waitMs);
    });
  });
}

/**
 * Это Основа FineCRM? И какая?
 *
 * Ответ новой Основы несёт название и номер мастерской. Основа, ещё не
 * обновлённая до этой версии, отвечает просто «ok» — её тоже принимаем, но
 * без имени: человек увидит адрес и поймёт.
 */
async function identify(ip, port, timeoutMs = 1500) {
  const address = `http://${ip}:${port}`;
  try {
    const res = await fetch(`${address}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.ok !== true) return null;
    if (data.app && data.app !== "finecrm") return null;
    const w = data.workshop && typeof data.workshop === "object" ? data.workshop : null;
    return {
      address,
      ip,
      port,
      id: w && typeof w.id === "string" ? w.id : null,
      name: w && typeof w.name === "string" ? w.name : null,
    };
  } catch {
    return null;
  }
}

/** Выполнить задачи с ограничением одновременности — не валить сеть сотней запросов разом. */
async function pool(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      const r = await fn(item);
      if (r) out.push(r);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Найти Основы в сети.
 *
 * Возвращает список: пустой — никто не отозвался; один — можно подключаться
 * сразу; несколько — пусть человек выберет свою (в одном здании бывают две
 * мастерские за одним роутером).
 *
 * Параметры `interfaces`, `targets` и `scan` нужны проверкам: на стенде нет
 * настоящей сети, и искать приходится на своём же компьютере.
 */
async function discover(opts = {}) {
  const port = opts.port ?? DEFAULT_PORT;
  const say = opts.onStep ?? (() => {});
  const interfaces = opts.interfaces ?? lanInterfaces();

  const targets = opts.targets ?? ["255.255.255.255", ...new Set(interfaces.map(broadcastOf))];

  say("Спрашиваю сеть");
  const answered = await askNetwork({
    targets,
    discoveryPort: opts.discoveryPort ?? DISCOVERY_PORT,
    waitMs: opts.waitMs ?? 1200,
  });
  let found = await pool(answered, 8, ({ ip, port: p }) => identify(ip, p));

  if (found.length === 0 && opts.scan !== false) {
    const hosts = [...new Set(interfaces.flatMap(scanTargets))];
    if (hosts.length) {
      say(`Проверяю соседние адреса (${hosts.length})`);
      found = await pool(hosts, opts.concurrency ?? 64, (ip) => identify(ip, port, opts.probeMs ?? 800));
    }
  }

  // Одна и та же Основа отвечает с каждой своей сетевой карты — оставляем одну.
  const seen = new Map();
  for (const f of found) {
    const key = f.id || f.address;
    if (!seen.has(key)) seen.set(key, f);
  }
  return [...seen.values()].sort((a, b) => String(a.name ?? a.ip).localeCompare(String(b.name ?? b.ip), "ru"));
}

/** Адрес из локальной сети, а не из интернета: только такие имеет смысл переискивать. */
function isLanAddress(address) {
  try {
    const u = new URL(address);
    if (u.protocol !== "http:") return false;
    return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(u.hostname);
  } catch {
    return false;
  }
}

module.exports = {
  DISCOVERY_PORT,
  DEFAULT_PORT,
  startResponder,
  discover,
  identify,
  lanInterfaces,
  broadcastOf,
  scanTargets,
  isLanAddress,
};
