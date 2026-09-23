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

/**
 * Откуда берётся приставка.
 *
 * Главный источник — тег <base> в странице: его правит узел связи, и он
 * работает всегда. Переменная оставлена запасным путём и стоит первой только
 * потому, что её ставит тот же узел связи: если однажды <base> исчезнет,
 * приложение всё равно найдёт свой адрес.
 *
 * Почему не наоборот: встроенные скрипты запрещены правилами безопасности
 * (script-src 'self'), и переменная доезжает не всегда — а тег доезжает.
 */
function read(): string {
  const declared = typeof window !== "undefined" ? window.__FINECRM_BASE__ : "";
  const raw = declared || baseTag();
  if (!raw || !raw.startsWith("/")) return "/";
  return raw.endsWith("/") ? raw : raw + "/";
}

function baseTag(): string {
  if (typeof document === "undefined") return "/";
  const href = document.querySelector("base")?.href;
  if (!href) return "/";
  try {
    return new URL(href, document.location.href).pathname;
  } catch {
    return "/";
  }
}

/** Всегда со слешами по краям: «/» или «/b/servis-na-lenina/». */
export const BASE = read();

/** Для React Router: «/» или «/b/servis-na-lenina». */
export const ROUTER_BASE = BASE === "/" ? "/" : BASE.slice(0, -1);

/** Адрес файла или запроса с учётом приставки: url("api/orders") → «/b/…/api/orders». */
export const url = (path: string) => BASE + path.replace(/^\/+/, "");
