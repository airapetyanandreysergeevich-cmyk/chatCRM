/**
 * Исправление раскладки в поиске — выключатель в Настройки → Интерфейс.
 *
 * Хранится на устройстве, как тема: это привычка человека за конкретным
 * компьютером, а не правило мастерской. По умолчанию включено. Хранилище
 * недоступно — считаем включённым и ничего не запоминаем.
 */
const KEY = "finecrm.search.layout";

export function fixLayoutEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function setFixLayoutEnabled(on: boolean): void {
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "off");
  } catch {
    /* не запомнили — не беда */
  }
}
