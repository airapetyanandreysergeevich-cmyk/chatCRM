import { api } from "./api";
import { fileUrl } from "./basePath";

/** История ремонта: сообщения мастеров в карточке заказа. */

export interface MessagePhoto {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Подписанная ссылка — живёт около четверти часа. */
  url: string;
}

export interface OrderMessage {
  id: string;
  text: string;
  createdAt: string;
  deleted: boolean;
  author: { id: string; fullName: string } | null;
  /** Запись самой программы: «Клиент согласился по SMS». */
  system?: boolean;
  attachments: MessagePhoto[];
}

/** Ссылки на снимки — с приставкой адреса (см. fileUrl). */
const withFileUrls = (m: OrderMessage): OrderMessage => ({
  ...m,
  attachments: (m.attachments ?? []).map((a) => ({ ...a, url: fileUrl(a.url) })),
});

export const messagesApi = {
  list: (orderId: string) => api.get<OrderMessage[]>(`/orders/${orderId}/messages`).then((list) => list.map(withFileUrls)),
  send: (orderId: string, text: string, files: File[]) => {
    const form = new FormData();
    form.append("text", text);
    for (const f of files) form.append("files", f, f.name);
    return api.upload<OrderMessage>(`/orders/${orderId}/messages`, form).then(withFileUrls);
  },
  remove: (orderId: string, messageId: string) => api.del(`/orders/${orderId}/messages/${messageId}`),
};

/** День сообщения — для разделителей «Сегодня», «Вчера», «12 сентября». */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86400000);
  if (diff === 0) return "Сегодня";
  if (diff === 1) return "Вчера";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  }).format(d);
}

export const timeLabel = (iso: string) =>
  new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
