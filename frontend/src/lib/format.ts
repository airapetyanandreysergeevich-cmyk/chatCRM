const dt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short", year: "numeric" });
const dtTime = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export const formatDate = (v: string | Date | null | undefined) => (v ? dt.format(new Date(v)) : "—");

const dtShort = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short" });

/**
 * Дата без года — для списков. Год в строке занимает место и почти всегда
 * текущий; если он всё-таки другой, показываем полностью, иначе соврём.
 */
export const formatDateShort = (v: string | Date | null | undefined) => {
  if (!v) return "—";
  const d = new Date(v);
  return d.getFullYear() === new Date().getFullYear() ? dtShort.format(d) : dt.format(d);
};
export const formatDateTime = (v: string | Date | null | undefined) => (v ? dtTime.format(new Date(v)) : "—");

/** «3 сотрудника», «21 сотрудник» — без этого интерфейс звучит как робот. */
export function plural(n: number, one: string, few: string, many: string) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}


const DAY = 86_400_000;

/**
 * Срок готовности в списке важен не датой, а тем, горит он или нет.
 * Возвращаем и текст, и признак — красит строку тот, кто её рисует.
 */
export function dueLabel(v: string | null | undefined): { text: string; overdue: boolean; soon: boolean } | null {
  if (!v) return null;
  const due = new Date(v);
  if (Number.isNaN(due.getTime())) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(due);
  day.setHours(0, 0, 0, 0);
  const days = Math.round((day.getTime() - today.getTime()) / DAY);

  // Формулировки короткие намеренно: в строке списка это одна колонка,
  // и перенос на вторую строку ломает выравнивание всего перечня.
  if (days < 0) return { text: `просрочен ${-days} дн.`, overdue: true, soon: false };
  if (days === 0) return { text: "срок сегодня", overdue: false, soon: true };
  if (days === 1) return { text: "срок завтра", overdue: false, soon: true };
  return { text: `срок ${formatDateShort(due)}`, overdue: false, soon: days <= 2 };
}

/** «Сергей Плотников» → «С. Плотников»: в строке списка длинное имя съедает всё место. */
export function shortName(full: string | null | undefined): string {
  if (!full) return "—";
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return full;
  return `${parts[0][0]}. ${parts[1]}`;
}
