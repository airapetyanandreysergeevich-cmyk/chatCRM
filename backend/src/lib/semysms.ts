import { env } from "./env";

/**
 * SemySMS — SMS с SIM-карты обычного телефона на Android.
 *
 * Телефон с их приложением — это шлюз: мы отдаём сообщение их серверу
 * (https://semysms.net/api/3/), телефон забирает его и отправляет со своей
 * SIM-карты по тарифу оператора. Отсюда и статусы: «принято сервером» ещё не
 * значит «отправлено» — телефон может быть выключен.
 *
 * Документация: https://semysms.net/api.php. Успех — `code` равен 0; формат
 * ошибок не описан, поэтому текст ошибки ищем в любом из привычных полей.
 */

const TIMEOUT_MS = 15_000;

export class SmsGatewayError extends Error {}

type Params = Record<string, string | number | undefined>;

async function call<T>(method: string, token: string, params: Params = {}): Promise<T & { code: number | string }> {
  const body = new URLSearchParams({ token });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") body.set(k, String(v));

  let res: Response;
  try {
    res = await fetch(env.semysmsUrl + method, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new SmsGatewayError(
      timeout
        ? "SemySMS не ответил за 15 секунд — попробуйте ещё раз"
        : "Нет связи с SemySMS — проверьте интернет на сервере или компьютере мастерской"
    );
  }

  const text = await res.text();
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new SmsGatewayError(`SemySMS ответил непонятно (HTTP ${res.status})`);
  }
  if (!res.ok || String(data.code) !== "0") {
    const said = [data.error, data.message, data.msg, data.text, data.description].find(
      (v) => typeof v === "string" && v.trim()
    ) as string | undefined;
    throw new SmsGatewayError(
      said ? `SemySMS: ${said}` : `SemySMS отказал (код ${String(data.code ?? res.status)}) — проверьте токен и код телефона`
    );
  }
  return data as T & { code: number | string };
}

export interface GatewayDevice {
  id: string;
  name: string;
  /** Телефон на связи с сервером SemySMS. */
  online: boolean;
  battery: number | null;
  lastActive: string | null;
}

const flag = (v: unknown) => v === 1 || v === "1" || v === true;

export async function devices(token: string): Promise<GatewayDevice[]> {
  const r = await call<{ data?: Array<Record<string, unknown>> }>("devices.php", token, { is_arhive: 0 });
  return (r.data ?? []).map((d) => ({
    id: String(d.id),
    name: String(d.device_name || [d.manufacturer, d.model].filter(Boolean).join(" ") || `Телефон ${d.id}`),
    online: flag(d.is_work),
    battery: d.bat === undefined || d.bat === null || d.bat === "" ? null : Number(d.bat),
    lastActive: d.date_last_active ? String(d.date_last_active) : null,
  }));
}

/** Отправить. device — код телефона или "active" (любой включённый). Возвращает номер SMS у SemySMS. */
export async function send(token: string, device: string, phone: string, msg: string): Promise<string> {
  const r = await call<{ id?: number | string }>("sms.php", token, { device, phone, msg });
  if (r.id === undefined || r.id === null) throw new SmsGatewayError("SemySMS принял запрос, но не вернул номер SMS");
  return String(r.id);
}

export interface GatewayStatus {
  id: string;
  sent: boolean;
  delivered: boolean;
  failed: boolean;
}

/** Состояние отправленных: по номерам SemySMS. Без даты сервис отдаёт только сегодняшние — даём с какого дня. */
export async function outbox(token: string, ids: string[], since: Date): Promise<GatewayStatus[]> {
  if (!ids.length) return [];
  const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const r = await call<{ data?: Array<Record<string, unknown>> }>("outbox_sms.php", token, {
    list_id: ids.join(","),
    date_start: `${day(since)} 00:00:00`,
  });
  return (r.data ?? []).map((m) => ({
    id: String(m.id),
    sent: flag(m.is_send),
    delivered: flag(m.is_delivered),
    failed: flag(m.is_error) || flag(m.is_cancel),
  }));
}

/** Номер для шлюза: международный, с плюсом. «8 921 …» и «921…» — российские. */
export function gatewayPhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits[0] === "8") return "+7" + digits.slice(1);
  if (digits.length === 10 && digits[0] === "9") return "+7" + digits;
  if (digits.length >= 10 && digits.length <= 15) return "+" + digits;
  return null;
}

/**
 * Сколько SMS займёт текст. Кириллица — 70 знаков, в склейке 67 на часть;
 * латиница — 160 и 153. Та же формула — в интерфейсе (lib/sms.ts).
 */
export function smsParts(text: string): number {
  if (!text) return 0;
  // eslint-disable-next-line no-control-regex
  const gsm = /^[\x0A\x0D\x20-\x7E£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¤¡ÄÖÑÜ§¿äöñüà€]*$/.test(text);
  const [one, many] = gsm ? [160, 153] : [70, 67];
  return text.length <= one ? 1 : Math.ceil(text.length / many);
}
