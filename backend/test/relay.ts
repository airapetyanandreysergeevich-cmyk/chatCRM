import crypto from "crypto";
import express from "express";
import http from "http";
import { createRelayAgent } from "../src/modules/relay/relay.agent";
import { createRelayHub, withBase, withCookiePath } from "../src/modules/relay/relay.hub";
import { encodeInvite, parseInvite, publicAddress } from "../src/modules/relay/invite";
import { codeFromEmail } from "../src/modules/relay/boxes.service";

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

/** Поддельная Основа: отвечает так же, как настоящий сервер мастерской. */
function startBox(): Promise<{ url: string; close: () => void }> {
  const app = express();
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
  app.post("/api/auth/login", (_req, res) => {
    res.setHeader("set-cookie", ["sid=abc; Path=/; HttpOnly", "other=1; HttpOnly"]);
    res.json({ ok: true });
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
  check(codeFromEmail("Masterskaya.Servis+crm@example.ru") === "masterskaya-servis", "код в адресе делается из почты");
  check(/^box-[0-9a-f]{6}$/.test(codeFromEmail("ы@почта.рф")), "из почты без латиницы код всё равно получается");
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
    authenticate: async (key) => (key === KEY ? { code: CODE } : null),
    timeoutMs: 5_000,
    log: () => {},
  });
  const cloud = await startCloud(hub);

  // Мастерская ещё не на связи.
  const offline = await ask(cloud.port, `/b/${CODE}/`);
  check(offline.status === 503 && offline.body.toString().includes("не на связи"), "без Основы — понятная страница, а не ошибка");

  const agent = createRelayAgent({
    url: `ws://127.0.0.1:${cloud.port}/relay/agent`,
    key: KEY,
    target: box.url,
    heartbeatMs: 1_000,
    log: () => {},
  });
  agent.start();
  check(await waitFor(() => hub.online(CODE)), "Основа подключилась");

  const page = await ask(cloud.port, `/b/${CODE}/`);
  check(page.status === 200 && page.body.toString().includes('<base href="/b/' + CODE + '/">'), "страница приходит с приставкой");
  check(!page.body.toString().includes('<base href="/" />'), "прежняя приставка не осталась второй строкой");
  check(
    page.body.toString().includes('window.__FINECRM_BASE__="/b/' + CODE + '/"'),
    "приложение узнаёт свой адрес из страницы"
  );
  check(Number(page.headers["content-length"]) === page.body.length, "длина ответа пересчитана после дописывания");

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

  agent.stop();
  check(await waitFor(() => !hub.online(CODE)), "выключили — мастерская пропала из списка");
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
