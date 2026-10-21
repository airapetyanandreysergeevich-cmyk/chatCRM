import { api } from "./api";
import { BASE, url } from "./basePath";

/**
 * Подписка браузера на оповещения.
 *
 * Три вещи, которые ломают это чаще всего, поэтому проверяются явно:
 *  1. push работает только по HTTPS — на http:// service worker не запустится;
 *  2. на iPhone push есть только у приложения, добавленного на экран «Домой»,
 *     во вкладке Safari его нет вовсе;
 *  3. разрешение можно спрашивать только по нажатию кнопки — иначе браузер
 *     молча откажет, и второй раз спросить уже нельзя.
 */

export type PushState =
  | "unsupported" // браузер не умеет
  | "insecure" // открыто не по https
  | "needs-install" // iPhone: сначала «Добавить на экран Домой»
  | "not-configured" // на сервере нет ключей VAPID
  | "denied" // человек запретил в браузере
  | "off" // можно включить
  | "on";

export const isIos = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  // iPadOS притворяется макбуком, отличается наличием тач-экрана
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

export const isStandalone = () =>
  window.matchMedia("(display-mode: standalone)").matches ||
  (window.navigator as { standalone?: boolean }).standalone === true;

let registration: ServiceWorkerRegistration | null = null;

async function ensureWorker(): Promise<ServiceWorkerRegistration> {
  if (registration) return registration;
  registration = await navigator.serviceWorker.register(url("sw.js"), { scope: BASE });
  await navigator.serviceWorker.ready;
  return registration;
}

export async function pushState(): Promise<PushState> {
  if (!window.isSecureContext) return "insecure";
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return isIos() && !isStandalone() ? "needs-install" : "unsupported";
  }
  if (isIos() && !isStandalone()) return "needs-install";

  const { configured } = await api.get<{ configured: boolean }>("/push/key");
  if (!configured) return "not-configured";
  if (Notification.permission === "denied") return "denied";

  const reg = await ensureWorker();
  const sub = await reg.pushManager.getSubscription();
  return sub ? "on" : "off";
}

/** Вызывать только из обработчика нажатия: iOS и Safari требуют жеста. */
export async function enablePush(): Promise<PushState> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";

  const { publicKey } = await api.get<{ publicKey: string | null }>("/push/key");
  if (!publicKey) return "not-configured";

  const reg = await ensureWorker();
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));

  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  await api.post("/push/subscribe", {
    endpoint: sub.endpoint,
    p256dh: json.keys?.p256dh ?? "",
    auth: json.keys?.auth ?? "",
    userAgent: navigator.userAgent.slice(0, 300),
  });

  return "on";
}

/**
 * Подписка этого браузера — за того, кто сейчас вошёл.
 *
 * Подписка браузера переживает выход: включили оповещения за владельца на
 * общем компьютере, вошёл совладелец — и ему продолжали приходить
 * оповещения владельца, о чужих заказах (21.10.2026). Поэтому при каждом
 * входе подписка, если она есть, перепривязывается к вошедшему, а при выходе
 * снимается с сервера (сам браузер подписку хранит — следующий вход её
 * подхватит). Ничего не спрашиваем и окно разрешения не открываем.
 */
async function currentSubscription(): Promise<PushSubscription | null> {
  if (!window.isSecureContext || !("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function syncPushOwner(): Promise<void> {
  try {
    const sub = await currentSubscription();
    if (!sub) return;
    const json = sub.toJSON() as { keys?: { p256dh?: string; auth?: string } };
    await api.post("/push/subscribe", {
      endpoint: sub.endpoint,
      p256dh: json.keys?.p256dh ?? "",
      auth: json.keys?.auth ?? "",
      userAgent: navigator.userAgent.slice(0, 300),
    });
  } catch {
    // Не вышло — оповещения этого устройства останутся как были; вход это не ломает.
  }
}

export async function releasePush(): Promise<void> {
  try {
    const sub = await currentSubscription();
    if (sub) await api.post("/push/unsubscribe", { endpoint: sub.endpoint });
  } catch {
    // Выходим всё равно.
  }
}

/** Для кого сервер шлёт оповещения на это устройство. */
export async function pushOwner(): Promise<{ state: "mine" | "other" | "none"; name?: string | null } | null> {
  try {
    const sub = await currentSubscription();
    if (!sub) return null;
    return await api.post<{ state: "mine" | "other" | "none"; name?: string | null }>("/push/whom", { endpoint: sub.endpoint });
  } catch {
    return null;
  }
}

export async function disablePush(): Promise<PushState> {
  const reg = await ensureWorker();
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await api.post("/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => undefined);
    await sub.unsubscribe();
  }
  return "off";
}

export interface TestPushResult {
  sent: number;
  removed: number;
  failed: number;
  /** Понятные причины отказа — их показываем прямо на экране. */
  reasons: string[];
}

export const testPush = () => api.post<TestPushResult>("/push/test", {});

/**
 * Ключ VAPID приходит в base64url, а pushManager принимает байты.
 * Своими руками, потому что тащить библиотеку ради двадцати строк не стоит.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const raw = window.atob(padded);
  // Буфер создаём явно: pushManager принимает только ArrayBuffer,
  // а обобщённый Uint8Array в свежих версиях TypeScript ему не подходит.
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}
