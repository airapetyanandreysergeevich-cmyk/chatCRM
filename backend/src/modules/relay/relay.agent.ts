import http from "http";
import WebSocket from "ws";
import { decodeControl, decodeFrame, encodeControl, encodeFrame, FRAME, type Control } from "./protocol";

/**
 * Сторона мастерской: держит соединение с облаком и выполняет пришедшие
 * запросы у себя.
 *
 * Живёт внутри сервера Основы, а не в оболочке Electron: так одна и та же
 * логика работает и в программе для Windows, и где угодно ещё, и её можно
 * проверить стендом без окон и мышки.
 *
 * Соединение всегда устанавливает мастерская. Это и есть главный смысл всей
 * затеи: наружу не открыт ни один порт, и до компьютера мастерской нельзя
 * достучаться иначе, чем через наш сервер, — а тот пускает только по ключу,
 * который владелец получил и в любой момент может отозвать.
 *
 * Связь рвётся постоянно: у мастерской уходит в сон роутер, провайдер меняет
 * адрес, ноутбук закрывают. Поэтому агент не считает разрыв бедой: он молча
 * ждёт и подключается снова, с нарастающей паузой, чтобы не барабанить в
 * сервер каждую секунду, когда интернета нет вовсе.
 */

export type AgentState = "off" | "connecting" | "online" | "error";

export interface AgentOptions {
  /** Адрес узла связи: wss://www.finecrm.ru/relay/agent */
  url: string;
  /** Ключ мастерской — его выдаёт собственник платформы. */
  key: string;
  /** Куда выполнять пришедшие запросы: сервер Основы у себя же. */
  target: string;
  log?: (line: string) => void;
  onState?: (state: AgentState, detail?: string) => void;
  /**
   * Узел связи при каждом подключении говорит, под каким именем мастерская
   * видна в облаке. Имя может смениться (перевыпустили фразу, завели заново),
   * поэтому не считаем его раз и навсегда известным, а запоминаем присланное.
   */
  onReady?: (info: { code: string; tag?: string }) => void;
  /** Проверка связи: если сервер молчит дольше, соединение считается мёртвым. */
  heartbeatMs?: number;
}

const FIRST_RETRY_MS = 2_000;
const MAX_RETRY_MS = 60_000;

export function createRelayAgent(opts: AgentOptions) {
  const log = opts.log ?? (() => {});
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const target = new URL(opts.target);

  let ws: WebSocket | null = null;
  let stopped = false;
  let retry = FIRST_RETRY_MS;
  let timer: NodeJS.Timeout | null = null;
  let alive: NodeJS.Timeout | null = null;
  let state: AgentState = "off";
  /** Запросы, которые сейчас выполняются у нас: по ним ещё придёт тело. */
  const running = new Map<number, http.ClientRequest>();

  function setState(next: AgentState, detail?: string) {
    if (state === next) return;
    state = next;
    opts.onState?.(next, detail);
  }

  function send(msg: Control) {
    ws?.send(encodeControl(msg));
  }

  /** Выполнить пришедший запрос у себя и вернуть ответ кусками. */
  function run(msg: Extract<Control, { t: "req" }>) {
    const headers = { ...msg.headers, host: target.host };
    const request = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: msg.method,
        path: msg.url,
        headers,
      },
      (response) => {
        send({
          t: "res",
          id: msg.id,
          status: response.statusCode ?? 502,
          headers: response.headers as Record<string, string | string[]>,
        });
        response.on("data", (chunk: Buffer) => ws?.send(encodeFrame(msg.id, FRAME.DATA, chunk)));
        response.on("end", () => {
          running.delete(msg.id);
          ws?.send(encodeFrame(msg.id, FRAME.END));
        });
        response.on("error", () => {
          running.delete(msg.id);
          ws?.send(encodeFrame(msg.id, FRAME.ABORT));
        });
      }
    );
    request.on("error", (err) => {
      running.delete(msg.id);
      // Сервер Основы мог как раз перезапускаться — человеку на том конце
      // нужен внятный ответ, а не пустая страница.
      send({ t: "err", id: msg.id, message: err.message });
    });
    running.set(msg.id, request);
  }

  function onControl(raw: string) {
    const msg = decodeControl(raw);
    if (!msg) return;
    if (msg.t === "ready") {
      retry = FIRST_RETRY_MS;
      setState("online", msg.code);
      opts.onReady?.({ code: msg.code, tag: msg.tag });
      log(`Доступ из интернета включён, код мастерской ${msg.code}`);
      return;
    }
    if (msg.t === "req") run(msg);
  }

  function onFrame(buf: Buffer) {
    const frame = decodeFrame(buf);
    if (!frame) return;
    const request = running.get(frame.id);
    if (!request) return;
    if (frame.kind === FRAME.DATA) request.write(frame.payload);
    else if (frame.kind === FRAME.END) request.end();
    else {
      running.delete(frame.id);
      request.destroy();
    }
  }

  function connect() {
    if (stopped) return;
    setState("connecting");

    // Ключ уходит заголовком, а в заголовок нельзя ни кириллицу, ни перевод
    // строки. Человек вставляет ключ из письма вместе с чем угодно, поэтому
    // проверяем до соединения: иначе Node роняет процесс, а не показывает
    // ошибку, и вся Основа уходит следом.
    const key = opts.key.trim();
    if (!key || !/^[\x21-\x7e]+$/.test(key)) {
      setState("error", "Ключ доступа испорчен — скопируйте его заново");
      log("Ключ доступа не похож на ключ: соединение не устанавливается");
      return;
    }

    let socket: WebSocket;
    try {
      socket = new WebSocket(opts.url, { headers: { "x-box-key": key } });
    } catch (err) {
      setState("error", err instanceof Error ? err.message : "Не удалось начать соединение");
      timer = setTimeout(connect, MAX_RETRY_MS);
      return;
    }
    ws = socket;

    socket.on("open", () => {
      // Сервер отвечает «ready» — до него соединение считается только начатым.
      if (alive) clearInterval(alive);
      let answered = true;
      socket.on("pong", () => (answered = true));
      alive = setInterval(() => {
        if (!answered) {
          log("Сервер не отвечает — переподключаемся");
          socket.terminate();
          return;
        }
        answered = false;
        socket.ping();
      }, heartbeatMs);
    });

    socket.on("message", (data, isBinary) => {
      if (isBinary) onFrame(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      else onControl(String(data));
    });

    socket.on("unexpected-response", (_req, res) => {
      // 401 — ключ не тот. Повторять каждые две секунды бессмысленно и вредно:
      // это выглядит как подбор ключа.
      const fatal = res.statusCode === 401 || res.statusCode === 403;
      setState("error", fatal ? "Ключ доступа не принят сервером" : `Сервер ответил ${res.statusCode}`);
      log(`Узел связи ответил ${res.statusCode}`);
      if (fatal) retry = MAX_RETRY_MS;
    });

    socket.on("error", (err) => {
      setState("error", err.message);
    });

    socket.on("close", () => {
      if (alive) clearInterval(alive);
      alive = null;
      for (const [, request] of running) request.destroy();
      running.clear();
      ws = null;
      if (stopped) return setState("off");
      setState("connecting");
      timer = setTimeout(connect, retry);
      retry = Math.min(Math.round(retry * 1.7), MAX_RETRY_MS);
    });
  }

  return {
    start() {
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (alive) clearInterval(alive);
      timer = null;
      alive = null;
      ws?.close(1000, "выключено");
      ws = null;
      setState("off");
    },
    get state() {
      return state;
    },
  };
}
