import webpush from "web-push";
import { env, pushConfigured } from "./env";

/**
 * Отправка Web Push.
 *
 * Главный урок этого файла: «отправили» и «доставили» — разные вещи.
 * Библиотека принимает почти любой VAPID_SUBJECT, а сервис push потом
 * отвергает подпись — и если считать такой отказ успехом, кнопка «Проверить»
 * будет бодро рапортовать об отправке, пока на телефон ничего не приходит.
 * Поэтому здесь возвращается разбор по каждому адресу, а не одно число.
 */

/** mailto: с настоящим адресом или https-ссылка. Иначе подпись отвергнут. */
const SUBJECT_OK = /^(mailto:[^\s@]+@[^\s@.]+\.[^\s@]+|https:\/\/\S+)$/;

export const subjectLooksValid = (s: string): boolean => SUBJECT_OK.test(s.trim());

if (pushConfigured) {
  if (!subjectLooksValid(env.vapidSubject)) {
    // Не падаем: остальная система работает и без оповещений. Но молчать
    // нельзя — иначе это выглядит как «push просто не приходит».
    console.error(
      `[push] VAPID_SUBJECT выглядит неправильно: ${JSON.stringify(env.vapidSubject)}. ` +
        "Нужен mailto: с настоящим адресом или https-ссылка, иначе сервис push " +
        "отвергнет подпись и оповещения не будут доходить."
    );
  }
  webpush.setVapidDetails(env.vapidSubject, env.vapidPublicKey, env.vapidPrivateKey);
}

export interface PushTarget {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushPayload {
  title: string;
  body?: string;
  /** Куда открыть приложение по нажатию — путь внутри сайта, не полный адрес. */
  url?: string;
  tag?: string;
}

export interface PushResult {
  /** Приняты сервисом push. Не гарантия показа, но гарантия, что мы отдали. */
  delivered: number;
  /** Подписки, которых больше нет: удалить из базы. */
  dead: string[];
  /** Всё остальное — с кодом и понятным объяснением. */
  failures: Array<{ code?: number; reason: string }>;
}

/** Человеческое объяснение вместо голого кода — его читает не программист. */
function explain(code: number | undefined, message: string): string {
  switch (code) {
    case 400:
      return "сервис push не понял запрос (400) — вероятно, повреждены ключи подписки";
    case 401:
    case 403:
      return (
        `сервис push отверг нашу подпись (${code}). Чаще всего это неверный VAPID_SUBJECT ` +
        "в deploy/.env или ключи, не совпадающие с теми, на которые подписывался браузер"
      );
    case 413:
      return "текст оповещения слишком длинный (413)";
    case 429:
      return "слишком много обращений к сервису push (429), стоит подождать";
    default:
      if (code && code >= 500) return `сервис push временно недоступен (${code})`;
      return `не удалось отправить${code ? ` (${code})` : ""}: ${message}`;
  }
}

/**
 * Ошибка отправки никогда не выбрасывается наружу: оповещение не должно
 * ронять то действие, ради которого его послали.
 */
export async function sendPush(targets: PushTarget[], payload: PushPayload): Promise<PushResult> {
  const result: PushResult = { delivered: 0, dead: [], failures: [] };
  if (!pushConfigured || targets.length === 0) return result;

  const body = JSON.stringify(payload);

  await Promise.all(
    targets.map(async (t) => {
      try {
        await webpush.sendNotification(
          { endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth } },
          body,
          { TTL: 60 * 60 * 24 }
        );
        result.delivered += 1;
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        const message = (err as Error).message ?? "";
        if (code === 404 || code === 410) {
          // Браузер удалён, приложение снесли, подписка протухла.
          result.dead.push(t.id);
          return;
        }
        const reason = explain(code, message);
        result.failures.push({ code, reason });
        console.error(`[push] ${reason} — ${new URL(t.endpoint).host}`);
      }
    })
  );

  return result;
}
