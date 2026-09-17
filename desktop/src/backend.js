"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

/**
 * Запуск бэкенда дочерним процессом.
 *
 * Отдельным процессом, а не внутри Electron: у бэкенда своя жизнь, он может
 * упасть и подняться заново, не утаскивая за собой окно. И наоборот — окно
 * можно закрыть в трей, а приём заказов на других компьютерах продолжится.
 */

const READY_TIMEOUT_MS = 60_000;

/** Последние строки журнала — единственное, что объясняет падение по-человечески. */
function tailLog(logDir, lines = 5) {
  try {
    const text = fs.readFileSync(path.join(logDir, "backend.log"), "utf8").trimEnd();
    return text.split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/** Ждём, пока сервер начнёт отвечать. Просто «процесс запустился» — не то же самое. */
async function waitUntilReady(port, child, timeout = READY_TIMEOUT_MS, logDir = "") {
  const until = Date.now() + timeout;
  let lastError = "";

  while (Date.now() < until) {
    if (child.exitCode !== null) {
      // В сообщение кладём хвост журнала, а не текст неудавшегося запроса:
      // «fetch failed» не объясняет ничего, а «нет базы» объясняет всё.
      const why = tailLog(logDir) || lastError;
      throw new Error(`Сервер завершился с кодом ${child.exitCode}.${why ? ` ${why}` : ""}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return true;
      lastError = `ответ ${res.status}`;
    } catch (err) {
      lastError = err.message;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Сервер не ответил за ${Math.round(timeout / 1000)} с. ${tailLog(logDir) || lastError}`.trim());
}

class Backend {
  /**
   * @param {object} o
   * @param {string} o.dir   папка бэкенда (внутри неё dist/index.js)
   * @param {object} o.env   переменные окружения
   * @param {number} o.port
   * @param {string} o.logDir
   */
  constructor({ dir, env, port, logDir }) {
    this.dir = dir;
    this.env = env;
    this.port = port;
    this.logDir = logDir;
    this.child = null;
  }

  get entry() {
    return path.join(this.dir, "dist", "index.js");
  }

  async start() {
    if (this.child) return this.child;
    if (!fs.existsSync(this.entry)) {
      throw new Error(`Не найден собранный сервер: ${this.entry}`);
    }

    fs.mkdirSync(this.logDir, { recursive: true });
    const log = fs.openSync(path.join(this.logDir, "backend.log"), "a");

    // execPath, а не "node": в собранной программе отдельного node нет, его
    // роль играет сам Electron с переменной ELECTRON_RUN_AS_NODE.
    this.child = spawn(process.execPath, [this.entry], {
      cwd: this.dir,
      env: { ...process.env, ...this.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", log, log],
      windowsHide: true,
    });

    this.child.on("exit", (code) => {
      this.child = null;
      if (this.onExit) this.onExit(code);
    });

    await waitUntilReady(this.port, this.child, READY_TIMEOUT_MS, this.logDir);
    return this.child;
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.onExit = null;
    this.child = null;

    child.kill();
    // Даём закрыть соединения, но не ждём вечно: программа должна
    // выключаться, а не висеть в списке процессов.
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

module.exports = { Backend, waitUntilReady };
