import crypto from "crypto";
import express from "express";
import http from "http";
import { createRelayAgent } from "../src/modules/relay/relay.agent";
import { createRelayHub, withBase, withCookiePath } from "../src/modules/relay/relay.hub";
import { isTag, splitTag } from "../src/modules/relay/boxes.service";
import { encodeInvite, encodeStaffKey, parseInvite, parseStaffKey, publicAddress } from "../src/modules/relay/invite";
import { newCode } from "../src/modules/relay/boxes.service";

/**
 * Туннель целиком: запрос из интернета → узел связи → Основа → и обратно.
 *
 * Проверяется то, из-за чего такие туннели обычно и ломаются: большое тело
 * запроса и ответа, печенье сессии, перенаправления, страница приложения с
 * приставкой в адресе, отвалившаяся Основа и её возвращение.
 *
 *   npx tsx test/relay.ts
 */

let bad = 0;
const check = (ok: boolean, what: string) => {
  console.log((ok ? "ok   " : "БЕДА ") + " " + what);
  if (!ok) bad++;
};

const KEY = "kluch-masterskoj-0001";
const CODE = "servis-na-lenina";
const TAG = "local20";

/** Поддельная Основа: отвечает так же, как настоящий сервер мастерской. */
function startBox(): Promise<{ url: string; close: () => void }> {
  const app = express();
  // Страница Основы приходит со своими правилами безопасности — как в жизни.
  app.use((_req, res, next) => {
    res.setHeader("content-security-policy", "default-src 'self';script-src 'self' 'wasm-unsafe-eval'");
    next();
  });
  // Так выглядит настоящая страница приложения: с <base href="/"> и
  // относительными путями к файлам сборки.
  app.get("/", (_req, res) => {
    res
      .type("html")
      .send(
        '<!doctype html><html><head><base href="/" /><title>FineCRM</title>' +
          '<script type="module" src="./assets/app.js"></script></head><body>ок</body></html>'
      );
  });
  app.get("/assets/app.js", (_req, res) => res.type("js").send("console.log(1)"));
  app.post("/api/auth/login", express.json(), (req, res) => {
    // Пароль знает только мастерская — в этом весь смысл: облако его не видит
    // и не хранит, а лишь передаёт запрос сюда.
    const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
    if (email && password && email !== "anton@repair.ru") {
      return res.status(401).json({ error: "Неверная почта или пароль" });
    }
    if (password && password !== "verniy-parol") {
      return res.status(401).json({ error: "Неверная почта или пароль" });
    }
    res.setHeader("set-cookie", ["sid=abc; Path=/; HttpOnly", "other=1; HttpOnly"]);
    res.json({ ok: true, accessToken: "token-osnovy" });
  });
  app.get("/api/whoami", (req, res) =>
    res.json({ cookie: req.headers.cookie ?? "", proto: req.headers["x-forwarded-proto"] ?? "" })
  );
  app.get("/old", (_req, res) => res.redirect(302, "/orders"));
  app.get("/api/big", (_req, res) => {
    res.setHeader("content-type", "application/octet-stream");
    res.end(Buffer.alloc(3 * 1024 * 1024, 7));
  });
  app.post("/api/echo", (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      res.json({ bytes: body.length, sha: crypto.createHash("sha256").update(body).digest("hex") });
    });
  });

  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

/** Поддельное облако: узел связи и раздача /b/<код>/… */
function startCloud(hub: ReturnType<typeof createRelayHub>): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((req, res) => {
    const match = /^\/b\/([a-z0-9-]+)(\/.*)?$/i.exec((req.url ?? "").split("?")[0]);
    if (!match) {
      res.writeHead(404);
      return res.end("нет такой страницы");
    }
    const rest = (match[2] || "/") + ((req.url ?? "").includes("?") ? "?" + (req.url ?? "").split("?")[1] : "");
    hub.handleRequest(match[1], rest, req, res);
  });
  hub.attach(server, "/relay/agent");
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({ port, close: () => server.close() });
    });
  });
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function ask(port: number, path: string, init: { method?: string; body?: Buffer; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: init.method ?? "GET", headers: init.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) })
        );
      }
    );
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
};

(async () => {
  // Части без сети — их проще проверить отдельно.
  check(
    withCookiePath("sid=abc; Path=/; HttpOnly", "/b/x") === "sid=abc; HttpOnly; Path=/b/x/",
    "печенье получает путь своей мастерской"
  );
  check(
    withCookiePath("sid=abc; HttpOnly", "/b/x").includes("Path=/b/x/"),
    "печенье без пути тоже получает путь"
  );
  check(
    withBase(Buffer.from("<html><head><title>т</title></head></html>"), "/b/x/")
      .toString()
      .includes('<base href="/b/x/">'),
    "в страницу дописана приставка адреса"
  );
  check(
    withBase(Buffer.from("просто текст"), "/b/x/").toString() === "просто текст",
    "не страница — не трогаем"
  );

  // Фраза подключения: то, что собственник передаёт мастерской одной строкой.
  const DEFAULT_URL = "wss://www.finecrm.ru/relay/agent";
  const phrase = encodeInvite({ url: DEFAULT_URL, key: KEY, code: CODE, email: "master@servis.ru" });
  const parsed = parseInvite(phrase, "wss://другой/relay/agent");
  check(
    parsed?.key === KEY && parsed?.code === CODE && parsed?.url === DEFAULT_URL && parsed?.email === "master@servis.ru",
    "фраза разбирается обратно целиком, вместе с почтой"
  );
  check(/^[a-z2-9]{14}$/.test(newCode()), "код в адресе случайный и ни о чём не говорит");
  check(newCode() !== newCode(), "два кода подряд не совпадают");

  // Ключ сотрудника: внутри только адрес мастерской, ни ключа туннеля, ни пароля.
  const staff = encodeStaffKey({ address: "https://www.finecrm.ru/b/kn7tuw2m4p9xzq/", workshop: "Сервис на Ленина", label: "Сергей" });
  const staffBack = parseStaffKey(`Серёж, вот доступ:\n${staff}\nвходи своим логином`);
  check(staffBack?.address === "https://www.finecrm.ru/b/kn7tuw2m4p9xzq/", "ключ сотрудника разбирается из письма");
  check(staffBack?.workshop === "Сервис на Ленина" && staffBack?.label === "Сергей", "в ключе видно мастерскую и кому выдан");
  check(!staff.includes(KEY), "ключа туннеля в ключе сотрудника нет");
  check(
    parseStaffKey("https://www.finecrm.ru/b/kn7tuw2m4p9xzq/")?.address === "https://www.finecrm.ru/b/kn7tuw2m4p9xzq/",
    "вставленный адрес тоже принимается"
  );
  check(parseStaffKey("здравствуйте") === null, "обычный текст ключом не считается");
  check(
    parseInvite(`  Держите:\n${phrase}\n\nвопросы — пишите  `, DEFAULT_URL)?.key === KEY,
    "фраза вынимается из письма с лишним текстом"
  );
  check(parseInvite("здравствуйте, вот ваш доступ", DEFAULT_URL) === null, "обычный текст фразой не считается");
  check(
    parseInvite(KEY + "extra-dlinnyj-kluch-0001", DEFAULT_URL)?.url === DEFAULT_URL,
    "голый ключ по-прежнему принимается — с адресом по умолчанию"
  );
  check(
    publicAddress(DEFAULT_URL, CODE) === `https://www.finecrm.ru/b/${CODE}/`,
    "по фразе видно, каким будет адрес мастерской"
  );

  const box = await startBox();
  const hub = createRelayHub({
    authenticate: async (key) => (key === KEY ? { code: CODE, tag: TAG } : null),
    timeoutMs: 5_000,
    log: () => {},
  });
  const cloud = await startCloud(hub);

  // Мастерская ещё не на связи.
  const offline = await ask(cloud.port, `/b/${CODE}/`);
  check(offline.status === 503 && offline.body.toString().includes("не на связи"), "без Основы — понятная страница, а не ошибка");

  let told: { code: string; tag?: string } | null = null;
  const agent = createRelayAgent({
    url: `ws://127.0.0.1:${cloud.port}/relay/agent`,
    key: KEY,
    target: box.url,
    heartbeatMs: 1_000,
    log: () => {},
    onReady: (info) => (told = info),
  });
  agent.start();
  check(await waitFor(() => hub.online(CODE)), "Основа подключилась");
  check(
    await waitFor(() => told?.tag === TAG),
    "мастерская узнаёт своё имя в облаке при подключении — даже по старой фразе"
  );

  const page = await ask(cloud.port, `/b/${CODE}/`);
  check(page.status === 200 && page.body.toString().includes('<base href="/b/' + CODE + '/">'), "страница приходит с приставкой");
  check(!page.body.toString().includes('<base href="/" />'), "прежняя приставка не осталась второй строкой");
  check(
    page.body.toString().includes('window.__FINECRM_BASE__="/b/' + CODE + '/"'),
    "приложение узнаёт свой адрес из страницы"
  );
  check(Number(page.headers["content-length"]) === page.body.length, "длина ответа пересчитана после дописывания");
  // Без отпечатка браузер молча не выполнит наш скрипт, и приложение решит,
  // что живёт в корне сайта, — ровно та поломка, что была на живом сервере.
  const csp = String(page.headers["content-security-policy"] ?? "");
  check(/script-src 'self' 'wasm-unsafe-eval' 'sha256-[A-Za-z0-9+/=]+'/.test(csp), "наш скрипт разрешён по отпечатку");
  check(!csp.includes("unsafe-inline"), "остальные встроенные скрипты остались запрещёнными");

  const asset = await ask(cloud.port, `/b/${CODE}/assets/app.js`);
  check(asset.status === 200 && asset.body.toString() === "console.log(1)", "файлы приложения доходят как есть");

  const login = await ask(cloud.port, `/b/${CODE}/api/auth/login`, { method: "POST" });
  const cookies = (login.headers["set-cookie"] ?? []) as string[];
  check(cookies.length === 2 && cookies.every((c) => c.includes(`Path=/b/${CODE}/`)), "оба печенья остались в своей мастерской");

  const who = await ask(cloud.port, `/b/${CODE}/api/whoami`, { headers: { cookie: "sid=abc" } });
  const info = JSON.parse(who.body.toString());
  check(info.cookie === "sid=abc", "печенье доезжает до Основы");
  check(info.proto === "https", "Основа видит, что снаружи защищённое соединение");

  const redirect = await ask(cloud.port, `/b/${CODE}/old`);
  check(redirect.status === 302 && redirect.headers.location === `/b/${CODE}/orders`, "перенаправление остаётся внутри мастерской");

  const big = await ask(cloud.port, `/b/${CODE}/api/big`);
  check(big.status === 200 && big.body.length === 3 * 1024 * 1024 && big.body.every((b) => b === 7), "три мегабайта ответа доходят целыми");

  const payload = crypto.randomBytes(2 * 1024 * 1024);
  const echo = await ask(cloud.port, `/b/${CODE}/api/echo`, { method: "POST", body: payload });
  const back = JSON.parse(echo.body.toString());
  check(
    back.bytes === payload.length && back.sha === crypto.createHash("sha256").update(payload).digest("hex"),
    "два мегабайта запроса доходят целыми"
  );

  // Основа пропала посреди работы — и вернулась.
  let refused = "";
  const watcher = createRelayAgent({
    url: `ws://127.0.0.1:${cloud.port}/relay/agent`,
    key: "chuzhoj-kluch",
    target: box.url,
    onState: (s, detail) => {
      if (s === "error" && detail) refused = detail;
    },
    log: () => {},
  });
  watcher.start();
  check(await waitFor(() => refused.includes("не принят")), "с чужим ключом не пускает и говорит почему");
  watcher.stop();

  // Ключ, скопированный вместе с русским текстом из письма, не должен ронять
  // сервер Основы — а должен превращаться в понятную надпись.
  let broken = "";
  const spoiled = createRelayAgent({
    url: `ws://127.0.0.1:${cloud.port}/relay/agent`,
    key: "ключ: abc",
    target: box.url,
    onState: (s, detail) => {
      if (s === "error" && detail) broken = detail;
    },
    log: () => {},
  });
  spoiled.start();
  check(broken.includes("испорчен"), "испорченный ключ не роняет Основу");
  spoiled.stop();
  check(hub.online(CODE), "чужой ключ не сбил работающую мастерскую");

  // ---------- вход сотрудника с общего сайта ----------
  //
  // Человек пишет anton@repair.ru.local20 на www.finecrm.ru; облако отрезает
  // хвост, находит мастерскую и спрашивает пароль у неё самой.
  check(splitTag("anton@repair.ru.local20")?.email === "anton@repair.ru", "почта отделяется от имени мастерской");
  check(splitTag("anton@repair.ru.local20")?.tag === "local20", "имя мастерской читается из хвоста");
  check(splitTag("ANTON@Repair.RU.LOCAL20")?.tag === "local20", "заглавные буквы не мешают");
  check(splitTag("anton@repair.ru") === null, "обычная почта остаётся целой");
  check(splitTag("anton@repair.ru.localhost") === null, "похожий хвост не считается именем");
  check(splitTag("anton.local20") === null, "строка без собаки почтой не считается");
  check(isTag("local20") && !isTag("local") && !isTag("local20a"), "имя мастерской — слово и число, и только");

  const entered = await hub.request(CODE, "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ email: "anton@repair.ru", password: "verniy-parol" }), "utf8"),
  });
  check(entered.status === 200, "облако может спросить пароль у мастерской само");
  const given = entered.headers["set-cookie"];
  check(
    Array.isArray(given) && given.every((c) => c.includes(`Path=/b/${CODE}/`)),
    "печенье сессии приходит уже с путём мастерской"
  );
  check(
    !entered.body.toString().includes("verniy-parol"),
    "пароль в ответе не возвращается"
  );

  const wrong = await hub.request(CODE, "/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ email: "anton@repair.ru", password: "ne-tot" }), "utf8"),
  });
  check(wrong.status === 401, "неверный пароль отвергает сама мастерская");
  check(wrong.body.toString().includes("Неверная почта"), "и её словами, а не нашими");

  check((await hub.request("chuzhoj-kod", "/api/auth/login", { method: "POST" })).offline === true,
    "к незнакомой мастерской запрос не уходит вовсе");

  agent.stop();
  check(await waitFor(() => !hub.online(CODE)), "выключили — мастерская пропала из списка");
  const noBody = await hub.request(CODE, "/api/auth/login", { method: "POST" });
  check(noBody.offline === true, "пока мастерская не на связи, вход её сотрудников не проходит");
  const gone = await ask(cloud.port, `/b/${CODE}/`);
  check(gone.status === 503, "и снаружи это видно сразу");

  agent.start();
  check(await waitFor(() => hub.online(CODE)), "включили обратно — снова на связи");
  const again = await ask(cloud.port, `/b/${CODE}/assets/app.js`);
  check(again.status === 200, "и запросы снова ходят");

  agent.stop();
  hub.close();
  cloud.close();
  box.close();
  console.log(bad ? `\nпровалов: ${bad}` : "\nвсе проверки прошли");
  process.exitCode = bad ? 1 : 0;
})();
