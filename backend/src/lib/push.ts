import webpush from "web-push";
import { env, pushConfigured } from "./env";

if (pushConfigured) {
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

/**
 * Отправка одной пачки оповещений.
 *
 * Возвращает id подписок, которые сервер push-сервиса больше не принимает
 * (404 или 410 — браузер удалён, приложение снесено, подписка протухла).
 * Их надо удалить: иначе список подписок растёт вечно и каждое оповещение
 * тратит время на заведомо мёртвые адреса.
 *
 * Ошибка отправки никогда не выбрасывается наружу: оповещение не должно
 * ронять то действие, ради которого его послали.
 */
export async function sendPush(targets: PushTarget[], payload: PushPayload): Promise<string[]> {
  if (!pushConfigured || targets.length === 0) return [];

  const body = JSON.stringify(payload);
  const dead: string[] = [];

  await Promise.all(
    targets.map(async (t) => {
      try {
        await webpush.sendNotification(
          { endpoint: t.endpoint, keys: { p256dh: t.p256dh, auth: t.auth } },
          body,
          { TTL: 60 * 60 * 24 }
        );
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) dead.push(t.id);
        else console.error(`[push] не доставлено (${code ?? "нет кода"}):`, (err as Error).message);
      }
    })
  );

  return dead;
}
