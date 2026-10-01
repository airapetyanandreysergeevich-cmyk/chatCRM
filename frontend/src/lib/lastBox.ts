import { BASE } from "./basePath";

/**
 * Последняя мастерская, в которую входили из интернета.
 *
 * Значок FineCRM на экране телефона всегда открывает www.finecrm.ru/ — общий
 * сайт. А сеанс Основы привязан к её адресу /b/<код>/ и на общем сайте не
 * виден: человек видел форму входа при каждом запуске, хотя сеанс жил.
 * Поэтому телефон запоминает адрес мастерской, и общий сайт без своего
 * сеанса сразу уводит туда — дальше сеанс поднимается сам.
 *
 * Хранилище браузера общее на весь домен, поэтому запись, сделанная под
 * /b/<код>/, видна и общему сайту. «Выйти» запись стирает.
 */

const KEY = "finecrm.box";
const BOX_RE = /^\/b\/[A-Za-z0-9_-]{4,64}\/$/;

/** Мы сейчас внутри Основы, открытой через интернет. */
export const inBox = BASE !== "/" && BOX_RE.test(BASE);

export function rememberBox(): void {
  if (!inBox) return;
  try {
    localStorage.setItem(KEY, BASE);
  } catch {
    /* приватный режим — просто не запомним */
  }
}

export function forgetBox(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* нечего стирать */
  }
}

/** Куда уйти с общего сайта, если своего сеанса нет. null — никуда. */
export function boxToOpen(): string | null {
  if (BASE !== "/") return null;
  if (new URLSearchParams(window.location.search).has("nobox")) {
    forgetBox();
    return null;
  }
  try {
    const v = localStorage.getItem(KEY);
    return v && BOX_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Ссылка «Войти в другую мастерскую» со страницы входа Основы. */
export function leaveBox(): void {
  forgetBox();
  window.location.assign("/?nobox=1");
}
