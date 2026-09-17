"use strict";

/**
 * Проверка разговора клиента с Основой.
 *
 * Здесь чинится вполне конкретная жалоба: сотрудник запускает программу на
 * своём компьютере и видит чёрный экран. Ошибки при этом нет ни у кого — на
 * Основе всё работает, а брандмауэр на той стороне не отвергает обращения, он
 * их молча выбрасывает. Поэтому проверяем не «дошли или нет», а то, что на
 * каждый вид молчания найдутся человеческие слова, и что ждём мы секунды, а не
 * минуту.
 *
 *   node test/network.js
 */

const http = require("http");
const net = require("net");

const { parseProfiles, reach } = require("../src/network");

let fails = 0;
const check = (ok, msg) => {
  console.log((ok ? "ok    " : "БЕДА  ") + msg);
  if (!ok) fails++;
};

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

async function main() {
  // 1. Основа на месте
  const good = http.createServer((req, res) => {
    if (req.url === "/api/health") return res.writeHead(200).end("{}");
    res.writeHead(404).end();
  });
  const goodPort = await listen(good);
  const found = await reach(`http://127.0.0.1:${goodPort}`);
  check(found.ok, "работающая Основа находится");

  // 2. По адресу кто-то есть, но это не Основа. Самое обидное — сюда попадают,
  //    перепутав порт с чужой программой, и «нет связи» было бы неправдой.
  const stranger = http.createServer((_req, res) => res.writeHead(404).end());
  const strangerPort = await listen(stranger);
  const wrong = await reach(`http://127.0.0.1:${strangerPort}`);
  check(!wrong.ok && /не Основа/.test(wrong.why), `чужая программа на порту распознана (${wrong.why})`);

  // 3. Порт закрыт — компьютер жив, раздача выключена.
  const closed = http.createServer();
  const closedPort = await listen(closed);
  await new Promise((r) => closed.close(r));
  const refused = await reach(`http://127.0.0.1:${closedPort}`, 3000);
  check(
    !refused.ok && /раздач/i.test(refused.why),
    `закрытый порт объяснён выключенной раздачей, а не «нет сети» (${refused.why})`
  );

  // 4. Тишина. Ровно то, что делает брандмауэр Windows: соединение принимается
  //    или теряется, а ответа нет. Ждать здесь можно вечно — и именно этим
  //    чёрный экран и был.
  const silent = net.createServer(() => {
    /* приняли и молчим */
  });
  const silentPort = await listen(silent);
  const began = Date.now();
  const mute = await reach(`http://127.0.0.1:${silentPort}`, 1200);
  const waited = Date.now() - began;
  check(!mute.ok && /брандмауэр/i.test(mute.why), `молчание объяснено брандмауэром (${mute.why.slice(0, 60)}…)`);
  check(waited < 3000, `ждали свой срок, а не бесконечность (${waited} мс)`);

  good.close();
  stranger.close();
  silent.close();

  // 5. Разбор ответа Windows про сети. Один профиль приходит объектом, не
  //    списком, — на этом ломается всякий разбор, написанный на глаз.
  const one = parseProfiles('{"Name":"Сеть","InterfaceIndex":12,"Category":"Public"}');
  check(one.length === 1 && one[0].open === false, "общедоступная сеть распознана как закрытая");
  check(one[0].name === "Сеть" && one[0].index === 12, "имя и номер сети разобраны");

  const many = parseProfiles(
    '[{"Name":"Дом","InterfaceIndex":3,"Category":"Private"},{"Name":"Офис","InterfaceIndex":5,"Category":"DomainAuthenticated"},{"Name":"Кафе","InterfaceIndex":7,"Category":"Public"}]'
  );
  check(many.filter((p) => p.open).length === 2, "частная и доменная сети считаются открытыми");
  check(many.filter((p) => !p.open).map((p) => p.name).join() === "Кафе", "закрытой названа только общедоступная");

  check(parseProfiles("не json вовсе").length === 0, "мусор вместо ответа не роняет программу");

  console.log(fails === 0 ? "\nвсе проверки прошли" : `\nпровалов: ${fails}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("сорвалось:", err);
  process.exit(1);
});
