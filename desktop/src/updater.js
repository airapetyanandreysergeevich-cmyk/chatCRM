"use strict";

/**
 * Обновление программы через интернет.
 *
 * Как это устроено. Сборка кладёт на сервер три файла: установщик, его
 * «карту блоков» (.blockmap) и latest.yml с номером версии и контрольной
 * суммой. Программа при запуске и потом раз в шесть часов читает latest.yml
 * и, если версия новее, предлагает обновиться. Скачивается только то, что
 * изменилось: встроенный PostgreSQL на двести мегабайт не качается заново
 * ради правки в интерфейсе.
 *
 * Что обновление НЕ трогает. База, фотографии и копии лежат в папке данных,
 * которую выбрали при первом запуске, — не в папке программы. Настройки
 * (где эта папка) — в профиле пользователя. Установщик в режиме обновления
 * заменяет только саму программу, а старый деинсталлятор при этом запускается
 * молча и ничего не удаляет (см. build/installer.nsh, IfSilent).
 *
 * Порядок установки — ради базы:
 *   1. резервная копия (на Основе);
 *   2. сервер и PostgreSQL останавливаются по-честному, как при выходе;
 *   3. только потом запускается установщик.
 * Если отдать это установщику, он застанет PostgreSQL работающим: файлы
 * программы заняты, а база гасится принудительно — ровно то, чего при
 * обновлении быть не должно.
 *
 * Модуль не знает ни про окна, ни про базу: всё это ему передаёт main.js.
 * Так логику «когда спрашивать и что делать при ошибке» можно проверить без
 * Electron (test/updater.js).
 */

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** Первая проверка — не сразу: запуск программы важнее. */
const FIRST_CHECK_MS = 15 * 1000;

/** Текст «что нового» из latest.yml: строка или список по версиям. */
function notesText(info) {
  const n = info && info.releaseNotes;
  if (!n) return "";
  if (typeof n === "string") return stripHtml(n);
  if (Array.isArray(n)) {
    return n
      .map((x) => (x && x.note ? `${x.version}:\n${stripHtml(x.note)}` : ""))
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

/** electron-builder превращает .md в HTML; в окне Windows нужен простой текст. */
function stripHtml(s) {
  return String(s)
    .replace(/<li>/gi, "• ")
    .replace(/<\/(p|li|h\d)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 1200);
}

/** Сетевые ошибки при фоновой проверке — не повод тревожить человека. */
function isOffline(err) {
  const s = String((err && (err.code || err.message)) || err);
  return /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|net::/i.test(s);
}

class Updater {
  /**
   * @param {object} o
   * @param {object} o.autoUpdater  electron-updater (в проверках — поддельный)
   * @param {object} o.ui           ask/info/error/progress — окна программы
   * @param {() => Promise<{ok:boolean, error?:string}>} o.beforeInstall
   *        копия базы и остановка сервера; ok:false — не ставить
   * @param {string} o.currentVersion
   */
  constructor({ autoUpdater, ui, beforeInstall, currentVersion, log = () => {} }) {
    this.au = autoUpdater;
    this.ui = ui;
    this.beforeInstall = beforeInstall;
    this.currentVersion = currentVersion;
    this.log = log;
    /** idle | checking | downloading | ready */
    this.state = "idle";
    /** Версия, от которой человек отказался: второй раз за запуск не спрашиваем. */
    this.declined = null;
    this.timer = null;

    // Решение за человеком: ничего не качаем и не ставим без спроса.
    this.au.autoDownload = false;
    this.au.autoInstallOnAppQuit = false;
    this.au.allowDowngrade = false;
    // Установщик у нас полный, «веб-установщиков» не выпускаем.
    this.au.disableWebInstaller = true;

    this.au.on("download-progress", (p) => this.ui.progress(Math.max(0, Math.min(1, (p.percent || 0) / 100))));
  }

  /** Фоновые проверки: через 15 секунд после запуска и раз в шесть часов. */
  start() {
    setTimeout(() => void this.check({ manual: false }), FIRST_CHECK_MS);
    this.timer = setInterval(() => void this.check({ manual: false }), CHECK_EVERY_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Проверить и, если есть новая версия, предложить её.
   * manual — нажали «Проверить обновления»: тогда отвечаем и «обновлений нет»,
   * и об ошибке сети. Фоновая проверка молчит, если сказать нечего.
   */
  async check({ manual }) {
    if (this.state !== "idle") {
      if (manual && this.state === "ready") return this.offerInstall(this.readyInfo);
      return { result: "busy" };
    }
    this.state = "checking";
    let info;
    try {
      const res = await this.au.checkForUpdates();
      info = res && res.updateInfo;
    } catch (err) {
      this.state = "idle";
      this.log(`проверка обновлений: ${err && err.message}`);
      if (manual) {
        await this.ui.error(
          "Не удалось проверить обновления",
          isOffline(err)
            ? "Нет связи с сервером обновлений. Проверьте интернет и попробуйте позже."
            : String((err && err.message) || err)
        );
      }
      return { result: "error" };
    }

    const newer = info && info.version && isNewer(info.version, this.currentVersion);
    if (!newer) {
      this.state = "idle";
      if (manual) await this.ui.info("Обновлений нет", `Установлена последняя версия — ${this.currentVersion}.`);
      return { result: "none" };
    }
    if (!manual && this.declined === info.version) {
      this.state = "idle";
      return { result: "declined-before" };
    }

    const notes = notesText(info);
    const yes = await this.ui.ask(
      `Доступна новая версия ${info.version}`,
      `Сейчас установлена ${this.currentVersion}.` +
        (notes ? `\n\nЧто нового:\n${notes}` : "") +
        "\n\nБаза заказов и настройки останутся на месте. Загрузка идёт в фоне — можно работать дальше.",
      ["Загрузить обновление", "Позже"]
    );
    if (!yes) {
      this.declined = info.version;
      this.state = "idle";
      return { result: "declined" };
    }

    this.state = "downloading";
    try {
      await this.au.downloadUpdate();
    } catch (err) {
      this.state = "idle";
      this.ui.progress(-1);
      await this.ui.error(
        "Обновление не загрузилось",
        (isOffline(err) ? "Связь прервалась. " : "") + "Программа продолжит работать как прежде; попробуйте ещё раз позже."
      );
      return { result: "download-failed" };
    }
    this.ui.progress(-1);
    this.state = "ready";
    this.readyInfo = info;
    return this.offerInstall(info);
  }

  /** Обновление скачано: поставить сейчас или при выходе из программы. */
  async offerInstall(info) {
    const now = await this.ui.ask(
      `Версия ${info.version} загружена`,
      "Для установки программа закроется на минуту: сделает резервную копию базы, " +
        "остановит сервер, обновится и запустится снова.\n\n" +
        "Сотрудники на других компьютерах на это время потеряют связь с Основой — " +
        "лучше выбрать момент, когда никто не оформляет заказ.",
      ["Установить сейчас", "Позже"]
    );
    if (!now) return { result: "postponed" };
    return this.install();
  }

  async install() {
    const prep = await this.beforeInstall();
    if (!prep.ok) {
      await this.ui.error(
        "Обновление отложено",
        `${prep.error || "Не удалось подготовиться к обновлению."}\n\nПрограмма продолжит работать на прежней версии.`
      );
      return { result: "prepare-failed" };
    }
    // Молча и с перезапуском: окно установщика в режиме обновления человеку
    // ничего не даёт, кроме лишнего «Далее». Запрос прав администратора
    // Windows покажет всё равно — программа стоит для всех пользователей.
    this.au.quitAndInstall(true, true);
    return { result: "installing" };
  }
}

/** Сравнение версий вида 1.2.3 (предрелизные хвосты не выпускаем). */
function isNewer(candidate, current) {
  const a = String(candidate).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const b = String(current).split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return false;
}

module.exports = { Updater, isNewer, notesText, isOffline };
