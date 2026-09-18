"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/**
 * Настройки установки — файл config.json в папке данных.
 *
 * Здесь лежит то, что определяет, чем эта программа является: хранит базу
 * сама, подключается к соседнему компьютеру или работает через облако.
 * Пароли базы генерируются при первом запуске и больше нигде не дублируются:
 * потерять файл настроек — значит потерять доступ к своей же базе, поэтому он
 * попадает в резервную копию наравне с данными.
 */

/** Режимы. Один и тот же .exe умеет все три. */
const MODE = {
  /** Хранит базу у себя и, если разрешено, отдаёт её другим по сети. */
  MAIN: "main",
  /** Только интерфейс, база на другом компьютере в локальной сети. */
  CLIENT: "client",
  /** Только интерфейс, база в облаке. */
  ONLINE: "online",
};

/**
 * Адрес облака. Один на всех и не спрашивается.
 *
 * Раньше при выборе «Online» программа просила ввести адрес — ровно как у
 * клиента локальной сети. Но адрес у облака один, он никогда не меняется, и
 * человек не может знать его лучше нас: спрашивать значит предлагать ошибиться
 * в букве и получить непонятный отказ там, где ошибиться нечем.
 *
 * Строкой здесь, а не в настройках: это не выбор мастерской, а свойство
 * продукта. Понадобится другой адрес — меняется тут, в одном месте.
 */
const CLOUD_URL = "https://www.finecrm.ru";

const DEFAULTS = {
  version: 1,
  mode: null, // null значит «первый запуск, ещё не выбрали»
  workshopName: "",

  db: {
    name: "finecrm",
    /** Порт выбирается свободный при создании кластера и дальше не меняется. */
    port: null,
    /** Владелец схемы: под ним идут миграции. */
    ownerUser: "finecrm_owner",
    ownerPassword: null,
    /** Роль приложения: не суперпользователь, поэтому построчная защита действует. */
    appUser: "finecrm_app",
    appPassword: null,
  },

  /**
   * Ключи подписи входа. В облаке они лежат в deploy/.env, здесь их некому
   * задать — генерируем при первом запуске. Смена ключей разлогинивает всех,
   * поэтому созданные однажды они не меняются никогда.
   */
  auth: {
    accessSecret: null,
    refreshSecret: null,
  },

  /** Раздача базы другим компьютерам локальной сети. */
  share: {
    enabled: false,
    port: 7373,
  },

  /** Куда смотрит клиент: адрес Основы или облака. */
  connectTo: null,

  backup: {
    enabled: true,
    /** Куда складывать копии; пусто — в подпапку backups папки данных. */
    folder: "",
    keep: 14,
    /** Час, после которого делается суточная копия. */
    atHour: 20,

    /** Отчёт о последней копии — его показывает интерфейс. */
    lastAt: null,
    lastOk: null,
    lastError: null,
    lastBytes: null,
  },
};

/** Пароль для машины, а не для человека: его никто не набирает руками. */
const secret = () => crypto.randomBytes(24).toString("base64url");

function read(configPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    // Поля, добавленные в новых версиях, подставляем со значениями по
    // умолчанию: старый файл настроек должен открываться новой программой.
    return {
      ...DEFAULTS,
      ...raw,
      db: { ...DEFAULTS.db, ...(raw.db ?? {}) },
      auth: { ...DEFAULTS.auth, ...(raw.auth ?? {}) },
      share: { ...DEFAULTS.share, ...(raw.share ?? {}) },
      backup: { ...DEFAULTS.backup, ...(raw.backup ?? {}) },
    };
  } catch {
    return {
      ...DEFAULTS,
      db: { ...DEFAULTS.db },
      auth: { ...DEFAULTS.auth },
      share: { ...DEFAULTS.share },
      backup: { ...DEFAULTS.backup },
    };
  }
}

/**
 * Запись настроек.
 *
 * Пишем через временный файл и переименование: если свет выключат посреди
 * записи, останется прежний файл целиком, а не половина нового. Внутри —
 * пароли базы, поэтому в конце снимаем права для всех, кроме владельца.
 */
function write(configPath, config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, configPath);
  try {
    fs.chmodSync(configPath, 0o600);
  } catch {
    /* на Windows права выглядят иначе — там папку закрывает установщик */
  }
  return config;
}

/** Дописывает недостающие пароли. Существующие не трогает никогда. */
function ensureSecrets(config) {
  if (!config.db.ownerPassword) config.db.ownerPassword = secret();
  if (!config.db.appPassword) config.db.appPassword = secret();
  if (!config.auth.accessSecret) config.auth.accessSecret = secret();
  if (!config.auth.refreshSecret) config.auth.refreshSecret = secret();
  return config;
}

/** Строка подключения для Prisma. */
function databaseUrl(config, role) {
  const { name, port, ownerUser, ownerPassword, appUser, appPassword } = config.db;
  const [user, password] = role === "owner" ? [ownerUser, ownerPassword] : [appUser, appPassword];
  return `postgresql://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${name}?schema=public`;
}

module.exports = { MODE, CLOUD_URL, DEFAULTS, read, write, ensureSecrets, databaseUrl, secret };
