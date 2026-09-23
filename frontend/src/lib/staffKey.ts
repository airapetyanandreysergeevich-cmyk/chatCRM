/**
 * Ключ сотрудника: адрес мастерской одной строкой.
 *
 * Разбор повторяет серверный (backend/src/modules/relay/invite.ts) — здесь он
 * нужен затем, чтобы страница подключения обошлась без обращения к серверу:
 * ключ ничего не открывает и никакой проверки не требует, он только говорит,
 * куда идти. Заодно так она работает и с телефона, где интернет до нашего
 * сервера может быть, а до мастерской — нет: человек сразу увидит, что не так.
 */

export const STAFF_PREFIX = "FINECRM-S-";

export interface StaffKey {
  address: string;
  workshop?: string;
  label?: string;
}

/** Терпим к тому, что вставили вместе с письмом: переводы строк, текст вокруг. */
export function parseStaffKey(raw: string): StaffKey | null {
  const text = (raw ?? "").trim();
  if (!text) return null;

  const found = text.match(new RegExp(`${STAFF_PREFIX}[A-Za-z0-9_-]+`));
  if (!found) {
    const url = text.match(/https?:\/\/[^\s"']+/);
    return url && url[0].includes("/b/") ? { address: url[0] } : null;
  }

  try {
    const json = decodeURIComponent(
      escape(atob(found[0].slice(STAFF_PREFIX.length).replace(/-/g, "+").replace(/_/g, "/")))
    );
    const data = JSON.parse(json) as { a?: string; w?: string; l?: string };
    if (!data.a || !/^https?:\/\//.test(data.a)) return null;
    return { address: data.a, workshop: data.w, label: data.l };
  } catch {
    return null;
  }
}
