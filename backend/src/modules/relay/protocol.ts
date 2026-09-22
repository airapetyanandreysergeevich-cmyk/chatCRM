/**
 * Протокол туннеля между облаком и Основой.
 *
 * Зачем он нужен. Основа стоит в мастерской, за роутером провайдера, и своего
 * адреса в интернете у неё нет — у большинства мастерских «серый» IP, а
 * открывать порт наружу значит выставить базу заказов всему свету. Поэтому
 * соединение устанавливает сама Основа: изнутри наружу, к нашему серверу. Он
 * держит это соединение открытым и, когда кто-то заходит на
 * https://www.finecrm.ru/b/<код>/…, отправляет запрос в него.
 *
 * Внутри одного соединения живут десятки запросов сразу — страница тянет
 * скрипты, картинки и данные одновременно. Поэтому у каждого запроса свой
 * номер, и всё, что летит в обе стороны, этим номером подписано.
 *
 * Разделение на два вида сообщений — не прихоть: заголовки удобно возить
 * текстом (их читают глазами в журнале), а тело запроса — двоичными кадрами,
 * потому что фотография в base64 распухла бы на треть.
 */

/** Кадр тела: 4 байта номера запроса, байт вида, дальше — сами данные. */
export const HEADER_BYTES = 5;

export const FRAME = {
  /** Кусок тела. */
  DATA: 0,
  /** Тело кончилось. */
  END: 1,
  /** Запрос оборван: связь с той стороной пропала или вышел срок. */
  ABORT: 2,
} as const;

export type FrameKind = (typeof FRAME)[keyof typeof FRAME];

export function encodeFrame(id: number, kind: FrameKind, payload?: Buffer): Buffer {
  const head = Buffer.allocUnsafe(HEADER_BYTES);
  head.writeUInt32BE(id, 0);
  head.writeUInt8(kind, 4);
  return payload && payload.length ? Buffer.concat([head, payload]) : head;
}

export function decodeFrame(buf: Buffer): { id: number; kind: FrameKind; payload: Buffer } | null {
  if (buf.length < HEADER_BYTES) return null;
  return {
    id: buf.readUInt32BE(0),
    kind: buf.readUInt8(4) as FrameKind,
    payload: buf.subarray(HEADER_BYTES),
  };
}

/** Заголовки запроса и ответа — текстом. */
export type Control =
  | { t: "ready"; code: string; server: string }
  | { t: "req"; id: number; method: string; url: string; headers: Record<string, string> }
  | { t: "res"; id: number; status: number; headers: Record<string, string | string[]> }
  | { t: "err"; id: number; message: string };

export const encodeControl = (msg: Control): string => JSON.stringify(msg);

export function decodeControl(raw: string): Control | null {
  try {
    const msg = JSON.parse(raw);
    return msg && typeof msg.t === "string" ? (msg as Control) : null;
  } catch {
    return null;
  }
}

/**
 * Заголовки, которые дальше не едут.
 *
 * Про соединение и сжатие договариваются каждые два соседа по пути сами:
 * браузер с нашим сервером, наш сервер с Основой. Протащить их насквозь —
 * значит получить ответ, сжатый дважды, или разорванное соединение.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

export function cleanHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const name = key.toLowerCase();
    if (HOP_BY_HOP.has(name) || value === undefined) continue;
    out[name] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}
