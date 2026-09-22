/**
 * Приставка адреса, под которой открыто приложение.
 *
 * Обычно это «/»: и в облаке, и в мастерской приложение живёт в корне. Но
 * когда в Основу заходят из интернета, её адрес выглядит как
 * https://www.finecrm.ru/b/<код>/ — один домен на все мастерские, потому что
 * поддомен каждой потребовал бы своего сертификата.
 *
 * Приставку подставляет узел связи: он правит <base> в странице и кладёт её
 * же в переменную. Отсюда её берут запросы к серверу и адреса страниц.
 */

declare global {
  interface Window {
    __FINECRM_BASE__?: string;
  }
}

function read(): string {
  const raw = typeof window !== "undefined" ? window.__FINECRM_BASE__ : "";
  if (!raw || !raw.startsWith("/")) return "/";
  return raw.endsWith("/") ? raw : raw + "/";
}

/** Всегда со слешами по краям: «/» или «/b/servis-na-lenina/». */
export const BASE = read();

/** Для React Router: «/» или «/b/servis-na-lenina». */
export const ROUTER_BASE = BASE === "/" ? "/" : BASE.slice(0, -1);

/** Адрес файла или запроса с учётом приставки: url("api/orders") → «/b/…/api/orders». */
export const url = (path: string) => BASE + path.replace(/^\/+/, "");
