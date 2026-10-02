import { api } from "./api";

/**
 * SMS клиентам через SemySMS (backend/src/modules/sms). Ключ API сюда не
 * приходит никогда — только «•••• 4f2a».
 */

export type OnReady = "ask" | "auto" | "off";
/** Чем отправлять: свой телефон с приложением FineCRM SMS или SemySMS. */
export type Provider = "phone" | "semysms";
export type SmsStatus = "QUEUED" | "SENT" | "DELIVERED" | "FAILED";

export interface SmsSettings {
  enabled: boolean;
  provider: Provider;
  hasToken: boolean;
  tokenHint: string | null;
  device: string;
  deviceName: string | null;
  onReady: OnReady;
  templates: { ready: string };
  defaults: { ready: string };
  placeholders: string[];
}

export interface GatewayDevice {
  id: string;
  name: string;
  online: boolean;
  battery: number | null;
  lastActive: string | null;
}

/** Подключённый телефон с приложением FineCRM SMS. */
export interface SmsPhone {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: string | null;
  battery: number | null;
  charging: boolean | null;
  appVersion: string | null;
  sentToday: number;
  problems: string[];
}

export interface PairCode {
  code: string;
  expiresAt: string;
  /** Основа: адрес через интернет (если доступ включён и на связи). */
  remote?: string;
  /** Основа: адрес в сети мастерской. */
  lan?: string;
}

/** Приложение «FineCRM SMS» лежит в облаке — и для облачных мастерских, и для Основ. */
export const SMS_APP_URL = "https://www.finecrm.ru/app/finecrm-sms.apk";

export interface SmsMessage {
  id: string;
  kind: string;
  text: string;
  phone: string;
  status: SmsStatus;
  error: string | null;
  createdAt: string;
  author: string | null;
}

export interface SmsPreview {
  enabled: boolean;
  kind: "ready" | "free";
  text: string;
  phone: string | null;
  customer: string | null;
  templates: { ready: string };
}

/** Что сервер ответил на смену статуса: предложить окно или SMS уже уходит сама. */
export type ReadyHint = { offer: true } | { auto: true };

export const smsApi = {
  settings: () => api.get<SmsSettings>("/sms/settings"),
  save: (body: {
    enabled: boolean;
    provider: Provider;
    token?: string;
    device: string;
    deviceName?: string | null;
    onReady: OnReady;
    templates: { ready: string };
  }) => api.put<SmsSettings>("/sms/settings", body),
  devices: (token?: string) => api.post<{ devices: GatewayDevice[] }>("/sms/devices", token ? { token } : {}),
  test: (phone: string) => api.post<{ id: string; status: SmsStatus; error: string | null }>("/sms/test", { phone }),
  status: () => api.get<{ enabled: boolean; onReady: OnReady; canSend: boolean }>("/sms/status"),
  phones: () => api.get<{ phones: SmsPhone[] }>("/sms/phones"),
  pair: () => api.post<PairCode>("/sms/phones/pair", {}),
  unpair: (id: string) => api.del<{ ok: true }>(`/sms/phones/${id}`),
  order: (orderId: string) =>
    api.get<{ enabled: boolean; canSend: boolean; hasPhone: boolean; messages: SmsMessage[] }>(`/sms/order/${orderId}`),
  preview: (orderId: string, kind: "ready" | "free") => api.get<SmsPreview>(`/sms/order/${orderId}/preview?kind=${kind}`),
  send: (orderId: string, text: string, kind: "ready" | "free") =>
    api.post<{ message: SmsMessage }>(`/sms/order/${orderId}`, { text, kind }),
};

export const SMS_STATUS_LABEL: Record<SmsStatus, string> = {
  QUEUED: "ждёт телефон",
  SENT: "отправлена",
  DELIVERED: "доставлена",
  FAILED: "не отправлена",
};

/**
 * Сколько SMS займёт текст: кириллица — 70 знаков, в склейке 67 на часть;
 * латиница — 160 и 153. Та же формула — на сервере (lib/semysms.ts).
 */
export function smsParts(text: string): number {
  if (!text) return 0;
  // eslint-disable-next-line no-control-regex
  const gsm = /^[\x0A\x0D\x20-\x7E£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¤¡ÄÖÑÜ§¿äöñüà€]*$/.test(text);
  const [one, many] = gsm ? [160, 153] : [70, 67];
  return text.length <= one ? 1 : Math.ceil(text.length / many);
}

export const smsCounter = (text: string) => {
  const parts = smsParts(text);
  return `${text.length} ${text.length % 10 === 1 && text.length % 100 !== 11 ? "знак" : [2, 3, 4].includes(text.length % 10) && ![12, 13, 14].includes(text.length % 100) ? "знака" : "знаков"} · ${parts} SMS`;
};
