/**
 * «Прочитано» — сигнал меню.
 *
 * Число непрочитанных показывает меню, а отмечает прочитанным экран
 * оповещений. Раньше меню узнавало об этом только при следующем опросе раз в
 * минуту или после перезагрузки страницы — и красный кружок висел над уже
 * прочитанным. Теперь экран сообщает сам, и меню тут же перечитывает счётчик.
 */
const EVENT = "finecrm:unread-changed";

export function announceUnreadChanged(): void {
  window.dispatchEvent(new Event(EVENT));
}

export function onUnreadChanged(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
