"use strict";

const { execFile } = require("child_process");
const { promisify } = require("util");

const run = promisify(execFile);

/**
 * Какой сетью Windows считает сеть мастерской.
 *
 * Windows метит почти всякую новую сеть «Общедоступной» — и в такой сети
 * брандмауэр не применяет правило, открывающее порт Основы. Со стороны это
 * выглядит безнадёжно: на Основе всё работает, на соседнем компьютере пусто,
 * и никакой ошибки никто не показывает, потому что пакеты не отвергаются, а
 * молча выбрасываются.
 *
 * Открывать порт ещё и для общедоступных сетей было бы проще всего, но тогда
 * в кафе и гостинице Основа оказалась бы видна соседям по вайфаю. Правильный
 * ответ — пометить сеть мастерской частной; наше дело — заметить и сказать.
 */

/** Разбор ответа PowerShell. Отдельно от запуска, чтобы проверять без Windows. */
function parseProfiles(json) {
  let raw;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .filter((p) => p && p.InterfaceIndex != null)
    .map((p) => ({
      name: String(p.Name ?? ""),
      index: Number(p.InterfaceIndex),
      category: String(p.Category ?? ""),
      // DomainAuthenticated — сеть предприятия с контроллером домена; правило
      // брандмауэра покрывает и её, поэтому она здесь наравне с частной.
      open: /^(Private|DomainAuthenticated)$/i.test(String(p.Category ?? "")),
    }));
}

const PS = [
  "Get-NetConnectionProfile |",
  "Select-Object Name, InterfaceIndex, @{n='Category';e={$_.NetworkCategory.ToString()}} |",
  "ConvertTo-Json -Compress",
].join(" ");

/** Сети, к которым компьютер подключён сейчас. На не-Windows — пусто. */
async function profiles() {
  if (process.platform !== "win32") return [];
  try {
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS], {
      windowsHide: true,
      timeout: 15_000,
    });
    return parseProfiles(stdout);
  } catch {
    // Нет PowerShell, política запрещает, что угодно ещё — это не повод
    // ломать запуск программы. Просто не сможем предупредить.
    return [];
  }
}

/** Сети, в которых сотрудники до Основы не достучатся. */
async function blocking() {
  return (await profiles()).filter((p) => !p.open);
}

/**
 * Просит Windows считать эти сети частными.
 *
 * Требует прав администратора, поэтому запускается через `Start-Process
 * -Verb RunAs`: человек увидит привычное окно UAC. Своих прав программа для
 * этого не повышает — она их и не имеет.
 */
async function makePrivate(indexes) {
  if (process.platform !== "win32" || indexes.length === 0) return false;
  const inner = indexes.map((i) => `Set-NetConnectionProfile -InterfaceIndex ${Number(i)} -NetworkCategory Private`).join("; ");
  const command = `Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile','-Command','${inner}'`;
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    windowsHide: true,
    timeout: 60_000,
  });
  return true;
}

/**
 * Стучимся в Основу и понимаем, что именно не так.
 *
 * Отдельно от открытия окна — и с собственным сроком ожидания. Просто открыть
 * адрес нельзя: когда брандмауэр на той стороне молча выбрасывает пакеты (а он
 * именно выбрасывает, а не отвечает отказом), окно остаётся чёрным на
 * полминуты, и человек видит не ошибку, а сломанную программу.
 *
 * Отказ отказу рознь, и разница здесь — половина ответа:
 * «соединение отвергнуто» значит, что компьютер жив, а раздача выключена;
 * тишина до срока — что мешает брандмауэр или сеть.
 */
async function reach(address, ms = 6000) {
  try {
    const res = await fetch(`${address}/api/health`, { signal: AbortSignal.timeout(ms) });
    if (res.ok) return { ok: true };
    return {
      ok: false,
      why: `По адресу ${address} кто-то отвечает, но это не Основа (код ${res.status}). Проверьте адрес и номер порта.`,
    };
  } catch (err) {
    const code = (err.cause && err.cause.code) || err.code || "";
    if (code === "ECONNREFUSED") {
      return {
        ok: false,
        why:
          `Компьютер по адресу ${address} отвечает, но порт закрыт. Обычно это значит, что на Основе ` +
          "выключена раздача: в меню значка возле часов включите «Раздавать базу по сети».",
      };
    }
    if (code === "ENOTFOUND" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
      return { ok: false, why: `Адрес ${address} не находится в сети. Проверьте, тот ли адрес записан и в одной ли вы сети с Основой.` };
    }
    return {
      ok: false,
      why:
        `Основа по адресу ${address} молчит. Так ведёт себя брандмауэр Windows, когда обращения не отвергают, ` +
        "а просто выбрасывают — чаще всего потому, что сеть помечена как «Общедоступная». " +
        "На компьютере-Основе проверьте две вещи: включена ли раздача базы по сети и считает ли Windows эту сеть частной.",
    };
  }
}

module.exports = { parseProfiles, profiles, blocking, makePrivate, reach };
