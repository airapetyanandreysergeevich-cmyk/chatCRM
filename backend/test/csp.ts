/**
 * Проверка заголовков безопасности.
 *
 * Здесь чинится поломка, которую почти невозможно найти с того конца, с
 * которого она видна. В коробке интерфейс открывался на самой Основе и
 * оставался пустым на всех остальных компьютерах. Сеть была в порядке, порт
 * слушался, страница приезжала — а в окне чернота, и в журнале сервера ни
 * строчки о том, что кто-то просил файлы приложения.
 *
 * Виноват был `upgrade-insecure-requests`, который helmet ставит по умолчанию:
 * браузер молча переписывал http в https и уходил стучаться туда, где никто не
 * слушает. На `127.0.0.1` этого не происходит — адрес считается доверенным, —
 * поэтому у того, кто чинит, всё работало.
 *
 *   npx tsx test/csp.ts
 */

import express from "express";
import helmet from "helmet";

// Настройки читаются при первом импорте, поэтому задаём их до него.
// COOKIE_SECURE=false — это и есть коробка: обычный HTTP в локальной сети.
process.env.COOKIE_SECURE = "false";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://нет:нет@127.0.0.1:1/нет";
process.env.JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? "проба-проба-проба-проба";
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? "проба-проба-проба-проба2";

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log((ok ? "ok    " : "БЕДА  ") + msg);
  if (!ok) fails++;
};

function serve(middleware: express.RequestHandler): Promise<{ csp: string; close: () => Promise<void> }> {
  const app = express();
  app.use(middleware);
  app.get("/", (_req, res) => res.send("<!doctype html><html><body>проба</body></html>"));

  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", async () => {
      const { port } = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}/`);
      resolve({
        csp: res.headers.get("content-security-policy") ?? "",
        // Закрытие дожидаемся по-настоящему: на Windows выход из процесса
        // поверх недозакрытого сокета роняет libuv в assertion, и проверка,
        // которая вся прошла, заканчивается пугающей строкой в консоли.
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

async function main() {
  const { cspDirectives, securityHeaders } = await import("../src/lib/security");

  // 1. Коробка: обычный HTTP в локальной сети.
  const box = await serve(securityHeaders());
  check(
    !/upgrade-insecure-requests/.test(box.csp),
    "по HTTP браузеру не велят уходить на https, которого нет"
  );
  check(/default-src 'self'/.test(box.csp), "остальная защита на месте (default-src)");
  check(/script-src 'self'/.test(box.csp), "и script-src тоже");
  check(/object-src 'none'/.test(box.csp), "и object-src");
  await box.close();

  // 2. Облако: тот же набор, но за nginx с сертификатом. Там переписывание
  //    ссылок — правильное поведение, и снимать его не за чем.
  const cloud = await serve(
    helmet({ contentSecurityPolicy: { useDefaults: true, directives: cspDirectives(true) } })
  );
  check(
    /upgrade-insecure-requests/.test(cloud.csp),
    "за HTTPS указание остаётся — облако не задето"
  );
  await cloud.close();

  console.log(fails === 0 ? "\nвсе проверки прошли" : `\nпровалов: ${fails}`);
  // Не process.exit: пусть узел уйдёт сам, когда отпустит всё своё.
  process.exitCode = fails === 0 ? 0 : 1;

}

main();
