import { api } from "./api";

/**
 * SMS клиентам со своего телефона — приложение «FineCRM SMS»
 * (backend/src/modules/sms). Согласование по SMS — клиент отвечает «да» или
 * «нет», ответ возвращается в заказ.
 */

export type OnReady = "ask" | "auto" | "off";
export type SmsStatus = "QUEUED" | "SENT" | "DELIVERED" | "FAILED";
export type TemplateKey = "ready" | "approval" | "approvalYes" | "approvalNo";

export interface ApprovalConfig {
  enabled: boolean;
  onWaiting: OnReady;
  statusId: string | null;
  yesStatusId: string | null;
  replyYes: boolean;
  replyNo: boolean;
}

export interface SmsSettings {
  enabled: boolean;
  onReady: OnReady;
  templates: Record<TemplateKey, string>;
  approval: ApprovalConfig;
  defaults: Record<TemplateKey, string>;
  placeholders: string[];
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
  /** Основа: адрес в сети мастерской — лучший из найденных. */
  lan?: string;
  /** Основа: все адреса в сети мастерской, лучший первым (у компьютера бывает несколько сетевых карт). */
  lans?: string[];
  /** Ответила Основа (а не облако): подсказки адресов — её, а не адрес этой страницы. */
  box?: true;
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

export type SmsKind = "ready" | "free" | "approval";

export interface SmsPreview {
  enabled: boolean;
  kind: SmsKind;
  text: string;
  phone: string | null;
  customer: string | null;
  templates: { ready: string; approval: string };
  approval: { enabled: boolean; cost: number; hasWorks: boolean };
}

/** Что сервер ответил на смену статуса: предложить окно или SMS уже уходит сама. */
export type ReadyHint = { offer: true } | { auto: true };
/** То же для согласования; failed — отправить сами не смогли (телефон не на связи). */
export type ApprovalHint = { offer: true } | { auto: true } | { failed: string };

export type ApprovalState = "PENDING" | "YES" | "NO" | "UNCLEAR" | "CANCELLED" | "EXPIRED";

export interface Approval {
  id: string;
  status: ApprovalState;
  phone: string;
  createdAt: string;
  expiresAt: string;
  replyText: string | null;
  repliedAt: string | null;
  decidedBy: string | null;
  author: string | null;
}

export interface OrderSmsData {
  enabled: boolean;
  canSend: boolean;
  hasPhone: boolean;
  messages: SmsMessage[];
  approval: { enabled: boolean; canAsk: boolean; last: Approval | null };
}

export interface SmsStatusInfo {
  enabled: boolean;
  onReady: OnReady;
  canSend: boolean;
  approval: { onWaiting: OnReady; statusId: string | null } | null;
}

/** Состояние SMS мастерской одно на всё приложение: меню заказа спрашивает его часто. */
let statusCache: { at: number; value: Promise<SmsStatusInfo> } | null = null;
export function smsStatusCached(): Promise<SmsStatusInfo> {
  if (!statusCache || Date.now() - statusCache.at > 60_000) {
    const value = smsApi.status().catch((e) => {
      statusCache = null;
      throw e;
    });
    statusCache = { at: Date.now(), value };
  }
  return statusCache.value;
}
export const forgetSmsStatus = () => {
  statusCache = null;
};

export const smsApi = {
  settings: () => api.get<SmsSettings>("/sms/settings"),
  save: (body: { enabled: boolean; onReady: OnReady; templates: Partial<Record<TemplateKey, string>>; approval: ApprovalConfig }) =>
    api.put<SmsSettings>("/sms/settings", body),
  test: (phone: string) => api.post<{ id: string; status: SmsStatus; error: string | null }>("/sms/test", { phone }),
  status: () => api.get<SmsStatusInfo>("/sms/status"),
  phones: () => api.get<{ phones: SmsPhone[] }>("/sms/phones"),
  pair: () => api.post<PairCode>("/sms/phones/pair", {}),
  unpair: (id: string) => api.del<{ ok: true }>(`/sms/phones/${id}`),
  order: (orderId: string) => api.get<OrderSmsData>(`/sms/order/${orderId}`),
  preview: (orderId: string, kind: SmsKind) => api.get<SmsPreview>(`/sms/order/${orderId}/preview?kind=${kind}`),
  send: (orderId: string, text: string, kind: "ready" | "free") =>
    api.post<{ message: SmsMessage }>(`/sms/order/${orderId}`, { text, kind }),
  ask: (orderId: string, text: string) => api.post<{ ok: true }>(`/sms/order/${orderId}/approval`, { text }),
  decide: (orderId: string, answer: "yes" | "no") => api.post<{ ok: true }>(`/sms/order/${orderId}/approval/decide`, { answer }),
  cancelApproval: (orderId: string) => api.post<{ ok: true }>(`/sms/order/${orderId}/approval/cancel`, {}),
};

export const SMS_STATUS_LABEL: Record<SmsStatus, string> = {
  QUEUED: "ждёт телефон",
  SENT: "отправлена",
  DELIVERED: "доставлена",
  FAILED: "не отправлена",
};

/**
 * Сколько SMS займёт текст: кириллица — 70 знаков, в склейке 67 на часть;
 * латиница — 160 и 153.
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
