import { api } from "./api";

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
  attachments: MessagePhoto[];
}

export const messagesApi = {
  list: (orderId: string) => api.get<OrderMessage[]>(`/orders/${orderId}/messages`),
  send: (orderId: string, text: string, files: File[]) => {
    const form = new FormData();
    form.append("text", text);
    for (const f of files) form.append("files", f, f.name);
    return api.upload<OrderMessage>(`/orders/${orderId}/messages`, form);
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
