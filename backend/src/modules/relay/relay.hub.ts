import { createHash } from "crypto";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "http";
import type { Duplex } from "stream";
import { WebSocketServer, type WebSocket } from "ws";
import { cleanHeaders, decodeControl, decodeFrame, encodeControl, encodeFrame, FRAME } from "./protocol";

/**
 * Узел связи в облаке: держит соединения с Основами и водит через них запросы.
 *
 * Мастерская нажимает в программе «Доступ из интернета», и Основа
 * подключается сюда. С этого мгновения её адрес — https://<домен>/b/<код>/,
 * и по нему работают телефоны и чужие компьютеры, хотя сама Основа по-прежнему
 * стоит в мастерской, ничего наружу не открыв.
 *
 * Чего здесь намеренно нет: никакого хранения данных мастерской. Узел ничего
 * не запоминает и не разбирает — он передаёт запрос и возвращает ответ. Все
 * заказы, фотографии и пароли остаются на компьютере мастерской.
 *
 * Три вещи, которые приходится править по дороге, — из-за того что адрес
 * начинается с /b/<код>, а Основа про приставку не знает:
 *   1. печенье сессии: без правки пути оно перебило бы вход в облачную CRM,
 *      открытую в той же вкладке на том же домене;
 *   2. перенаправления вида Location: /orders — иначе браузер ушёл бы в корень
 *      сайта, то есть в облако;
 *   3. страница приложения: в неё дописывается <base>, чтобы скрипты и
 *      картинки искались с приставкой.
 */

/**
 * Куда писать ответ мастерской.
 *
 * Обычно это ответ браузеру, но тем же путём облако ходит в Основу само —
 * когда проверяет пароль сотрудника, вошедшего с общего сайта. Тогда вместо
 * ответа браузеру подставляется сборщик, и запрос ничем не отличается от
 * обычного: те же кадры, те же поправки заголовков.
 */
export interface Sink {
  headersSent: boolean;
  writeHead(status: number, headers?: Record<string, string | string[]>): unknown;
  write(chunk: Buffer): unknown;
  end(body?: Buffer | string): unknown;
  destroy(): unknown;
  on(event: "close", fn: () => void): unknown;
}

interface Pending {
  res: Sink;
  /** Тело ответа собираем целиком только у страницы — ради <base>. */
  html: Buffer[] | null;
  headers: Record<string, string | string[]>;
  status: number;
  timer: NodeJS.Timeout;
}

interface Connection {
  ws: WebSocket;
  code: string;
  since: Date;
  address: string;
  nextId: number;
  pending: Map<number, Pending>;
  served: number;
}

export interface RelayOptions {
  /** Проверка ключа Основы: вернуть код и имя мастерской или null. */
  authenticate: (key: string) => Promise<{ code: string; name: string | null } | null>;
  /** Путь, на котором Основа устанавливает соединение. */
  path?: string;
  /** Сколько ждать ответ Основы. Загрузка фотографий по мобильному интернету бывает долгой. */
  timeoutMs?: number;
  /** Куда писать заметное: подключился, отключился, сорвалось. */
  log?: (line: string, extra?: Record<string, unknown>) => void;
  /** Отметка «был на связи» — чтобы собственнику было видно, кто живой. */
  onSeen?: (code: string) => void;
}

/** Ответ мастерской, полученный облаком для себя. */
export interface RelayReply {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
  /** Мастерской нет на связи вовсе — это не её ответ, а наш. */
  offline?: boolean;
}

const HTML = (title: string, text: string) =>
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<title>${title}</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;` +
  `background:#0f1117;color:#e7eaf2;font:16px/1.6 "Segoe UI",system-ui,sans-serif;padding:24px;text-align:center}` +
  `div{max-width:420px}h1{font-size:20px;margin:0 0 10px}p{color:#9096a3;font-size:14px;margin:0}</style></head>` +
  `<body><div><h1>${title}</h1><p>${text}</p></div></body></html>`;

export function createRelayHub(opts: RelayOptions) {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const log = opts.log ?? (() => {});
  const byCode = new Map<string, Connection>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

  function drop(conn: Connection, why: string) {
    if (byCode.get(conn.code) === conn) byCode.delete(conn.code);
    for (const [, p] of conn.pending) {
      clearTimeout(p.timer);
      if (!p.res.headersSent) p.res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
      p.res.end(HTML("Связь с мастерской прервалась", "Попробуйте обновить страницу через минуту."));
    }
    conn.pending.clear();
    log(`Основа ${conn.code} отключилась: ${why}`);
  }

  function onControl(conn: Connection, raw: string) {
    const msg = decodeControl(raw);
    if (!msg) return;
    if (msg.t === "res") {
      const p = conn.pending.get(msg.id);
      if (!p) return;
      p.status = msg.status;
      p.headers = msg.headers;
      const type = String(msg.headers["content-type"] ?? "");
      // Страницу придержим целиком: в неё надо дописать <base>, а дописать
      // в уже улетевшие байты нельзя.
      p.html = type.includes("text/html") ? [] : null;
      if (!p.html) sendHead(conn, p);
      return;
    }
    if (msg.t === "err") {
      const p = conn.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      conn.pending.delete(msg.id);
      if (!p.res.headersSent) p.res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
      p.res.end(HTML("Мастерская не смогла ответить", msg.message));
    }
  }

  /** Заголовки ответа — с поправкой на приставку в адресе. */
  function sendHead(conn: Connection, p: Pending, bodyLength?: number) {
    const prefix = `/b/${conn.code}`;
    const out: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(p.headers)) {
      if (name === "set-cookie") {
        const list = Array.isArray(value) ? value : [value];
        out["set-cookie"] = list.map((c) => withCookiePath(c, prefix));
        continue;
      }
      if (name === "location" && typeof value === "string" && value.startsWith("/")) {
        out.location = prefix + value;
        continue;
      }
      if (name === "content-length" && bodyLength !== undefined) continue;
      out[name] = value;
    }
    if (bodyLength !== undefined) out["content-length"] = String(bodyLength);
    p.res.writeHead(p.status, out);
  }

  function onFrame(conn: Connection, buf: Buffer) {
    const frame = decodeFrame(buf);
    if (!frame) return;
    const p = conn.pending.get(frame.id);
    if (!p) return;

    if (frame.kind === FRAME.DATA) {
      if (p.html) p.html.push(frame.payload);
      else p.res.write(frame.payload);
      return;
    }

    clearTimeout(p.timer);
    conn.pending.delete(frame.id);
    conn.served += 1;

    if (frame.kind === FRAME.ABORT) {
      p.res.destroy();
      return;
    }
    if (p.html) {
      const base = `/b/${conn.code}/`;
      const body = withBase(Buffer.concat(p.html), base);
      // Встроенный скрипт с приставкой запрещён правилами безопасности самой
      // Основы (script-src 'self'), и браузер молча его не выполняет. Поэтому
      // разрешаем ровно его — по отпечатку содержимого, как это и задумано в
      // стандарте: остальные встроенные скрипты остаются запрещёнными.
      p.headers = allowInlineBase(p.headers, base);
      sendHead(conn, p, body.length);
      p.res.end(body);
    } else {
      p.res.end();
    }
  }

  /** Соединение от Основы. Ключ приходит заголовком, как обычный токен. */
  async function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const key = String(req.headers["x-box-key"] ?? "");
    const box = key ? await opts.authenticate(key).catch(() => null) : null;
    if (!box) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      log("Соединение отклонено: неверный ключ Основы");
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const conn: Connection = {
        ws,
        code: box.code,
        since: new Date(),
        address: String(req.headers["x-real-ip"] ?? req.socket.remoteAddress ?? ""),
        nextId: 1,
        pending: new Map(),
        served: 0,
      };
      // Вторая Основа с тем же ключом вытесняет первую: так мастерская,
      // переехавшая на другой компьютер, не остаётся с мёртвым соединением.
      const old = byCode.get(box.code);
      if (old) {
        drop(old, "подключилась другая Основа");
        old.ws.close(4000, "заменено");
      }
      byCode.set(box.code, conn);
      opts.onSeen?.(box.code);
      log(`Основа ${box.code} на связи`, { address: conn.address });

      // Имя мастерской отдаём при каждом подключении: его могли сменить
      // или освободить в панели, и Основа должна показывать владельцу то,
      // по которому в облако действительно входят. null — имени нет.
      ws.send(encodeControl({ t: "ready", code: box.code, name: box.name ?? null, server: "finecrm" }));
      ws.on("message", (data, isBinary) => {
        if (isBinary) onFrame(conn, Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
        else onControl(conn, String(data));
      });
      ws.on("close", () => drop(conn, "соединение закрыто"));
      ws.on("error", (err) => drop(conn, err.message));
    });
  }

  /** Запрос из интернета: отправляем его в мастерскую и ждём ответ. */
  function handleRequest(code: string, rest: string, req: IncomingMessage, res: ServerResponse) {
    const conn = byCode.get(code);
    if (!conn) {
      res.writeHead(503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(
        HTML(
          "Мастерская сейчас не на связи",
          "Доступ из интернета работает, пока в мастерской включён компьютер с Основой. Попробуйте позже."
        )
      );
      return;
    }

    const id = conn.nextId++;
    if (conn.nextId > 0xffff_fff0) conn.nextId = 1;

    const headers = cleanHeaders(req.headers);
    // Основа должна видеть, что снаружи соединение защищённое: от этого
    // зависит, пометит ли она печенье сессии как защищённое.
    headers["x-forwarded-proto"] = "https";
    headers["x-forwarded-for"] = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "");

    const pending: Pending = {
      res,
      html: null,
      headers: {},
      status: 502,
      timer: setTimeout(() => {
        conn.pending.delete(id);
        conn.ws.send(encodeFrame(id, FRAME.ABORT));
        if (!res.headersSent) res.writeHead(504, { "content-type": "text/html; charset=utf-8" });
        res.end(HTML("Мастерская не ответила вовремя", "Похоже, связь у неё пропала. Попробуйте ещё раз."));
      }, timeoutMs),
    };
    conn.pending.set(id, pending);

    conn.ws.send(encodeControl({ t: "req", id, method: req.method ?? "GET", url: rest, headers }));

    req.on("data", (chunk: Buffer) => conn.ws.send(encodeFrame(id, FRAME.DATA, chunk)));
    req.on("end", () => conn.ws.send(encodeFrame(id, FRAME.END)));
    req.on("error", () => conn.ws.send(encodeFrame(id, FRAME.ABORT)));
    res.on("close", () => {
      if (!conn.pending.has(id)) return;
      clearTimeout(pending.timer);
      conn.pending.delete(id);
      conn.ws.send(encodeFrame(id, FRAME.ABORT));
    });
  }

  /**
   * Сходить в мастерскую самому, без браузера.
   *
   * Нужно ровно для одного: сотрудник коробочной мастерской вошёл на общем
   * сайте, и пароль его проверяет не облако, а Основа. Облако передаёт туда
   * запрос как есть и возвращает ответ, ничего не запоминая, — ни почты, ни
   * пароля у него не оседает.
   */
  function request(
    code: string,
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: Buffer } = {}
  ): Promise<RelayReply> {
    const conn = byCode.get(code);
    if (!conn) return Promise.resolve({ status: 503, headers: {}, body: Buffer.alloc(0), offline: true });

    return new Promise<RelayReply>((resolve) => {
      const chunks: Buffer[] = [];
      let seen = { status: 502, headers: {} as Record<string, string | string[]> };
      let done = false;
      const finish = (reply: RelayReply) => {
        if (done) return;
        done = true;
        resolve(reply);
      };
      const sink: Sink = {
        headersSent: false,
        writeHead(status, headers = {}) {
          seen = { status, headers };
          this.headersSent = true;
        },
        write(chunk) {
          chunks.push(chunk);
        },
        end(body) {
          // Страница-заглушка приходит строкой: так узел отвечает, когда
          // мастерская оборвалась посреди ответа.
          if (body && body.length) chunks.push(typeof body === "string" ? Buffer.from(body, "utf8") : body);
          finish({ status: seen.status, headers: seen.headers, body: Buffer.concat(chunks) });
        },
        destroy() {
          finish({ status: 502, headers: {}, body: Buffer.alloc(0) });
        },
        on() {},
      };

      const id = conn.nextId++;
      if (conn.nextId > 0xffff_fff0) conn.nextId = 1;

      const headers: Record<string, string> = {
        ...(init.headers ?? {}),
        "x-forwarded-proto": "https",
      };
      const body = init.body ?? Buffer.alloc(0);
      if (body.length) headers["content-length"] = String(body.length);

      const pending: Pending = {
        res: sink,
        html: null,
        headers: {},
        status: 502,
        timer: setTimeout(() => {
          conn.pending.delete(id);
          conn.ws.send(encodeFrame(id, FRAME.ABORT));
          finish({ status: 504, headers: {}, body: Buffer.alloc(0) });
        }, timeoutMs),
      };
      conn.pending.set(id, pending);

      conn.ws.send(encodeControl({ t: "req", id, method: init.method ?? "GET", url, headers }));
      if (body.length) conn.ws.send(encodeFrame(id, FRAME.DATA, body));
      conn.ws.send(encodeFrame(id, FRAME.END));
    });
  }

  return {
    /** Поднять приём соединений от Основ на указанном пути. */
    attach(server: HttpServer, path = opts.path ?? "/relay/agent") {
      server.on("upgrade", (req, socket, head) => {
        const url = req.url ?? "";
        if (url.split("?")[0] !== path) return;
        void upgrade(req, socket as Duplex, head);
      });
    },
    handleRequest,
    request,
    online: (code: string) => byCode.has(code),
    /** Отключить мастерскую: ключ отозвали, доступ выключили, код сменили. */
    disconnect(code: string, why: string) {
      const conn = byCode.get(code);
      if (!conn) return false;
      drop(conn, why);
      conn.ws.close(4001, why);
      return true;
    },
    status: () =>
      [...byCode.values()].map((c) => ({
        code: c.code,
        since: c.since,
        address: c.address,
        served: c.served,
        waiting: c.pending.size,
      })),
    close() {
      for (const conn of [...byCode.values()]) conn.ws.close(1001, "сервер перезапускается");
      wss.close();
    },
  };
}

/**
 * Печенье — только для своей приставки.
 *
 * Без этого печенье Основы и печенье облачной CRM живут на одном домене с
 * путём «/» и перебивают друг друга: зашёл в мастерскую — выкинуло из облака.
 */
export function withCookiePath(cookie: string, prefix: string): string {
  const parts = cookie.split(";").filter((p) => !/^\s*path=/i.test(p));
  parts.push(` Path=${prefix}/`);
  return parts.join(";");
}

/**
 * Разрешить наш единственный встроенный скрипт — по отпечатку.
 *
 * Правила безопасности задаёт Основа, и ослаблять их целиком («разрешить все
 * встроенные скрипты») ради одной строки нельзя: это ровно та дыра, от
 * которой правила и защищают. Отпечаток разрешает одну конкретную строку и
 * ничего больше.
 */
export function allowInlineBase(
  headers: Record<string, string | string[]>,
  base: string
): Record<string, string | string[]> {
  const name = Object.keys(headers).find((h) => h.toLowerCase() === "content-security-policy");
  if (!name) return headers;
  const value = String(headers[name]);
  if (!/script-src/i.test(value)) return headers;
  const hash = createHash("sha256").update(baseScript(base), "utf8").digest("base64");
  const patched = value.replace(/script-src([^;]*)/i, (m, rest) => `script-src${rest} 'sha256-${hash}'`);
  return { ...headers, [name]: patched };
}

/** Один и тот же текст скрипта и для страницы, и для отпечатка — иначе не совпадёт. */
const baseScript = (base: string) => `window.__FINECRM_BASE__=${JSON.stringify(base)}`;

/**
 * Дописать в страницу приставку адреса.
 *
 * Приложение собрано для корня сайта: скрипты оно просит по «/assets/…», а
 * данные — по «/api/…». Через туннель оно живёт по «/b/<код>/», поэтому в
 * страницу добавляется <base> (по нему браузер достраивает адреса файлов) и
 * одна переменная — по ней приложение знает, куда обращаться за данными.
 */
export function withBase(html: Buffer, base: string): Buffer {
  const text = html.toString("utf8");
  if (!/<head[^>]*>/i.test(text)) return html;

  const marker = `<script>${baseScript(base)}</script>`;
  // В странице приложения <base> уже есть и указывает на корень — его
  // достаточно подменить. У чужой страницы (скажем, у старой сборки) его
  // может не быть вовсе: тогда дописываем свой.
  const replaced = text.replace(/<base\s+href="[^"]*"\s*\/?>/i, `<base href="${base}">`);
  const withTag =
    replaced === text ? text.replace(/<head[^>]*>/i, (m) => `${m}<base href="${base}">`) : replaced;
  return Buffer.from(withTag.replace(/<head[^>]*>/i, (m) => m + marker), "utf8");
}
