"use strict";

/**
 * Проверка запуска и остановки сервера.
 *
 * Настоящий бэкенд здесь не нужен — проверяется оболочка: дожидается ли она
 * готовности, не считает ли запущенным то, что упало, и гасит ли процесс при
 * выходе. Вместо бэкенда подставляется заглушка с тем же /api/health.
 *
 *   node test/backend-lifecycle.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const { Backend } = require("../src/backend");

let fails = 0;
const check = (ok, msg) => {
  console.log((ok ? "ok    " : "БЕДА  ") + msg);
  if (!ok) fails++;
};

const room = fs.mkdtempSync(path.join(os.tmpdir(), "finecrm-be-"));
const dir = path.join(room, "backend");
fs.mkdirSync(path.join(dir, "dist"), { recursive: true });

/** Заглушка: отвечает на /api/health, но только после задержки. */
const stub = `
const http = require("http");
const delay = Number(process.env.STUB_DELAY_MS || 0);
const fail = process.env.STUB_FAIL === "1";
if (fail) { console.error("нет базы"); process.exit(3); }
setTimeout(() => {
  http.createServer((req, res) => {
    if (req.url === "/api/health") { res.writeHead(200, {"Content-Type":"application/json"}); res.end('{"ok":true}'); }
    else { res.writeHead(404); res.end(); }
  }).listen(Number(process.env.PORT), "127.0.0.1");
}, delay);
process.on("SIGTERM", () => process.exit(0));
`;
fs.writeFileSync(path.join(dir, "dist", "index.js"), stub);

const logDir = path.join(room, "logs");
const PORT = 7391;

async function alive() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
    return r.ok;
  } catch {
    return false;
  }
}

async function main() {
  // 1. Ждём именно готовности, а не запуска процесса
  const slow = new Backend({ dir, port: PORT, logDir, env: { PORT: String(PORT), STUB_DELAY_MS: "1200" } });
  const started = Date.now();
  await slow.start();
  const waited = Date.now() - started;
  check(waited >= 1200, `дождались готовности, а не просто запуска (${waited} мс)`);
  check(await alive(), "сервер отвечает");

  // 2. Остановка действительно гасит процесс
  await slow.stop();
  check(!(await alive()), "после остановки порт свободен");

  // 3. Упавший сервер — это ошибка запуска, а не «всё хорошо»
  const broken = new Backend({ dir, port: PORT, logDir, env: { PORT: String(PORT), STUB_FAIL: "1" } });
  let message = "";
  try {
    await broken.start();
  } catch (err) {
    message = err.message;
  }
  check(/кодом 3/.test(message) && /нет базы/.test(message), `падение объяснено причиной из журнала (${message.replace(/\n/g, " ")})`);

  // 4. Журнал пишется рядом с данными — в него и смотреть, когда что-то не так
  const log = path.join(logDir, "backend.log");
  check(fs.existsSync(log) && fs.readFileSync(log, "utf8").includes("нет базы"), "причина падения попала в журнал");

  // 5. Нет собранного сервера — понятная ошибка, а не «что-то пошло не так»
  const empty = new Backend({ dir: path.join(room, "пусто"), port: PORT, logDir, env: {} });
  let missing = "";
  try {
    await empty.start();
  } catch (err) {
    missing = err.message;
  }
  check(/Не найден собранный сервер/.test(missing), "отсутствие сборки объяснено");

  fs.rmSync(room, { recursive: true, force: true });
  console.log(fails === 0 ? "\nвсе проверки прошли" : `\nпровалов: ${fails}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("сорвалось:", err);
  process.exit(1);
});
