import { api } from "./api";

/**
 * Стоит ли на телефоне наше андроид-приложение.
 *
 * Сервер сам этого узнать не может и не должен: сайт не имеет права
 * заглядывать в список установленных программ. Единственный законный способ —
 * спросить у самого браузера про приложение, которое связано с этим доменом:
 * navigator.getInstalledRelatedApps() отвечает только про наш пакет и только
 * если связь подтверждена с двух сторон — assetlinks.json на сайте и
 * asset_statements внутри приложения.
 *
 * Работает в Chrome на Android и только по https. Ответ отправляем на сервер,
 * чтобы владелец видел в списке сотрудников, кто ещё без приложения: мастер
 * без него не получает оповещений о заказах, а это и есть смысл всей затеи.
 */

export const PACKAGE_ID = "ru.finecrm.app";
export const APK_URL = "/app/finecrm.apk";

export type AndroidAppState =
  | "not-android" // не Android — предлагать нечего
  | "in-app" // уже открыто внутри приложения
  | "installed" // приложение стоит, но открыто в браузере
  | "missing" // приложения нет — можно предложить
  | "unknown"; // браузер не умеет отвечать на этот вопрос

interface RelatedApp {
  id?: string;
  platform?: string;
}

type NavigatorWithRelatedApps = Navigator & {
  getInstalledRelatedApps?: () => Promise<RelatedApp[]>;
};

export const isAndroid = () => /android/i.test(navigator.userAgent);

/**
 * Внутри Trusted Web Activity страница открыта самим приложением, и браузер
 * помечает это адресом источника вида android-app://<пакет>. Это надёжнее
 * опроса списка приложений и работает мгновенно.
 */
export const isInAndroidApp = () => document.referrer.startsWith(`android-app://${PACKAGE_ID}`);

export async function androidAppState(): Promise<AndroidAppState> {
  if (isInAndroidApp()) return "in-app";
  if (!isAndroid()) return "not-android";

  const nav = navigator as NavigatorWithRelatedApps;
  if (!window.isSecureContext || typeof nav.getInstalledRelatedApps !== "function") {
    return "unknown";
  }

  try {
    const apps = await nav.getInstalledRelatedApps();
    return apps.some((a) => a.id === PACKAGE_ID) ? "installed" : "missing";
  } catch {
    // Браузер вправе отказать — например, во встроенном окне.
    // Тогда просто не мешаем человеку работать.
    return "unknown";
  }
}

/**
 * Сообщаем серверу результат. Молча: это справочная величина, и ошибка
 * отправки не должна ничем мешать.
 */
export function reportAndroidApp(state: AndroidAppState): void {
  if (state === "not-android" || state === "unknown") return;
  void api
    .post("/push/android", { installed: state !== "missing" })
    .catch(() => undefined);
}
