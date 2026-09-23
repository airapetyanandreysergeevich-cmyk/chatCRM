"use strict";

/**
 * Поиск Основы в сети.
 *
 *   node test/discovery.js
 *
 * Настоящей сети на стенде нет, поэтому ищем на своём же компьютере: вместо
 * широковещания — прямой адрес 127.0.0.1, вместо подсети мастерской —
 * 127.0.0.x. Сам разговор (вопрос, ответ, проверка по HTTP, перебор) от этого
 * не меняется. Что проверить здесь нельзя — как с широковещанием обойдётся
 * брандмауэр Windows, — проверяется на двух настоящих компьютерах.
 */

const dgram = require("dgram");
const http = require("http");
const d = require("../src/discovery");

let bad = 0;
const ok = (name, cond) => {
  console.log((cond ? "ok     " : "ПЛОХО  ") + name);
  if (!cond) bad += 1;
};

/** Поддельная Основа: отвечает на /api/health так же, как настоящая. */
function fakeBox(body) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url !== "/api/health") return res.writeHead(404).end();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    });
    srv.listen(0, "127.0.0.1", () => resolve({ port: srv.address().port, close: () => srv.close() }));
  });
}

const freeUdpPort = () =>
  new Promise((resolve) => {
    const s = dgram.createSocket("udp4");
    s.bind(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---------- арифметика адресов
  ok("широковещательный адрес /24", d.broadcastOf({ address: "192.168.1.40", netmask: "255.255.255.0" }) === "192.168.1.255");
  ok("широковещательный адрес /16", d.broadcastOf({ address: "10.0.5.7", netmask: "255.255.0.0" }) === "10.0.255.255");

  const small = d.scanTargets({ address: "192.168.1.40", netmask: "255.255.255.0" });
  ok("в /24 перебираем 253 соседа", small.length === 253);
  ok("себя не перебираем", !small.includes("192.168.1.40"));
  ok("ни адрес сети, ни широковещательный не трогаем", !small.includes("192.168.1.0") && !small.includes("192.168.1.255"));

  const big = d.scanTargets({ address: "10.0.5.7", netmask: "255.255.0.0" });
  ok("большую подсеть не обходим целиком — только соседей", big.length === 253 && big.every((ip) => ip.startsWith("10.0.5.")));

  ok("адрес в мастерской — локальный", d.isLanAddress("http://192.168.1.40:7373"));
  ok("адрес из интернета — не локальный", !d.isLanAddress("https://www.finecrm.ru/b/kn7tuw2m4p9xzq"));
  ok("172.16–31 тоже локальные", d.isLanAddress("http://172.20.0.5:7373") && !d.isLanAddress("http://172.40.0.5:7373"));

  // ---------- ответ Основы и вопрос клиента
  const box = await fakeBox({ ok: true, app: "finecrm", workshop: { id: "w-1", name: "Сервис на Ленина" } });
  const udp = await freeUdpPort();
  const responder = d.startResponder({ port: box.port, discoveryPort: udp, host: "127.0.0.1" });
  await wait(100);

  const quick = await d.discover({
    interfaces: [],
    targets: ["127.0.0.1"],
    discoveryPort: udp,
    port: box.port,
    waitMs: 400,
    scan: false,
  });
  ok("Основа отвечает на вопрос в сети", quick.length === 1);
  ok("и называет свою мастерскую", quick[0]?.name === "Сервис на Ленина");
  ok("и её номер — чтобы найти снова при смене адреса", quick[0]?.id === "w-1");
  ok("адрес собран правильно", quick[0]?.address === `http://127.0.0.1:${box.port}`);

  // Мусор в порт поиска не должен ронять Основу.
  const junk = dgram.createSocket("udp4");
  await new Promise((r) => junk.send(Buffer.from("привет, это не FineCRM"), udp, "127.0.0.1", r));
  await new Promise((r) => junk.send(Buffer.alloc(4000, 1), udp, "127.0.0.1", r));
  junk.close();
  await wait(100);
  const again = await d.discover({ interfaces: [], targets: ["127.0.0.1"], discoveryPort: udp, port: box.port, waitMs: 400, scan: false });
  ok("мусорные пакеты ответчик пропускает и работает дальше", again.length === 1);

  responder.close();
  await wait(100);

  // ---------- перебор, когда сеть молчит
  const silent = await d.discover({ interfaces: [], targets: ["127.0.0.1"], discoveryPort: udp, port: box.port, waitMs: 300, scan: false });
  ok("без ответчика вопрос остаётся без ответа", silent.length === 0);

  const t0 = Date.now();
  const scanned = await d.discover({
    interfaces: [{ address: "127.0.0.2", netmask: "255.255.255.0" }],
    targets: ["127.0.0.1"],
    discoveryPort: udp,
    port: box.port,
    waitMs: 300,
    probeMs: 500,
  });
  const took = Date.now() - t0;
  ok("перебор соседних адресов находит Основу, даже если сеть молчит", scanned.length === 1 && scanned[0].name === "Сервис на Ленина");
  ok(`перебор укладывается в разумное время (${took} мс)`, took < 8000);

  const steps = [];
  await d.discover({ interfaces: [], targets: ["127.0.0.1"], discoveryPort: udp, port: box.port, waitMs: 200, scan: false, onStep: (s) => steps.push(s) });
  ok("человеку видно, что происходит", steps.length > 0);
  box.close();

  // ---------- кого принимать за Основу
  const old = await fakeBox({ ok: true, ts: "2026-09-23" });
  const oldFound = await d.identify("127.0.0.1", old.port);
  ok("Основа старой версии тоже находится — просто без названия", oldFound && oldFound.name === null);
  old.close();

  const stranger = await fakeBox({ ok: true, app: "что-то-своё" });
  ok("чужая программа с тем же адресом проверки не принимается", (await d.identify("127.0.0.1", stranger.port)) === null);
  stranger.close();

  const html = await fakeBox("<html>роутер</html>");
  ok("страница роутера на этом порту не принимается", (await d.identify("127.0.0.1", html.port)) === null);
  html.close();

  ok("на пустом адресе поиск молча возвращает ничего", (await d.identify("127.0.0.1", 1, 300)) === null);

  console.log(bad ? `\nПровалов: ${bad}` : "\nвсе проверки прошли");
  process.exitCode = bad ? 1 : 0;
})();
