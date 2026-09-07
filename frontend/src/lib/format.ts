const dt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "short", year: "numeric" });
const dtTime = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export const formatDate = (v: string | Date | null | undefined) => (v ? dt.format(new Date(v)) : "—");
export const formatDateTime = (v: string | Date | null | undefined) => (v ? dtTime.format(new Date(v)) : "—");

/** «3 сотрудника», «21 сотрудник» — без этого интерфейс звучит как робот. */
export function plural(n: number, one: string, few: string, many: string) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}
