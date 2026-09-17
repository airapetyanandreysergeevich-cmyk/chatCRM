import helmet, { type HelmetOptions } from "helmet";
import { env } from "./env";

/**
 * Набор директив CSP — так, как его понимает helmet.
 *
 * Тип вытаскиваем из самой библиотеки, а не переписываем руками: иначе при
 * обновлении helmet наше описание разошлось бы с настоящим молча.
 */
type Directives = NonNullable<
  Exclude<NonNullable<HelmetOptions["contentSecurityPolicy"]>, boolean>["directives"]
>;

/**
 * Заголовки безопасности — каска со снятой одной заклёпкой.
 *
 * helmet по умолчанию ставит в CSP `upgrade-insecure-requests` — указание
 * браузеру молча переписывать все http-ссылки страницы в https. В облаке за
 * nginx это правильно и ничего не стоит. В коробке — смертельно: там сервер
 * говорит по обычному HTTP, сертификата нет, и браузер, честно выполнив
 * указание, идёт за файлами приложения по https, которого никто не слушает.
 * Ни одного файла не приезжает, страница остаётся пустой, а в журнале сервера
 * при этом ни строчки — он этих запросов даже не видел.
 *
 * Обманчивее всего, что на самой Основе всё работает: `127.0.0.1` браузер
 * считает доверенным адресом и ничего не переписывает. Ломается ровно то, что
 * открывают по сетевому адресу, — то есть работа сотрудников.
 *
 * Признак «сайт отдаётся по HTTPS» у нас уже есть: тот же, по которому печенье
 * сессии помечается как защищённое. Заводить второй значило бы однажды выставить
 * их вразнобой.
 */
export function cspDirectives(httpsExpected: boolean): Directives {
  // null убирает директиву из набора по умолчанию, пустой объект — оставляет всё.
  return httpsExpected ? {} : { upgradeInsecureRequests: null };
}

export function securityHeaders() {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: cspDirectives(env.cookieSecure),
    },
  });
}
