import { Input } from "./ui";

/**
 * Поле-перечисление: строка ввода и кнопки частых значений под ней.
 *
 * Так заполняются комплектность и внешнее состояние. Раньше это были
 * чек-боксы, и всё, чего не было в списке из десяти пунктов, записать было
 * некуда: «блок питания чужой», «царапина на крышке у петли». Такое либо
 * уезжало в примечание, либо не записывалось вовсе — а потом спор с клиентом
 * решать нечем.
 *
 * Теперь значение — обычная строка, и набрать в ней можно что угодно. Кнопки
 * остались тем, чем и были: быстрым способом не печатать «Блок питания» в
 * сотый раз. Нажатие дописывает пункт, повторное — убирает именно его, не
 * трогая всё, что человек набрал руками.
 */

/** Пункты перечисления из строки. Разделитель один — запятая. */
export function splitItems(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export const joinItems = (items: string[]): string => items.join(", ");

/** Есть ли уже такой пункт. Регистр не в счёт: «Кабель» и «кабель» — одно. */
export const hasItem = (value: string, label: string): boolean =>
  splitItems(value).some((i) => i.toLowerCase() === label.trim().toLowerCase());

/**
 * Добавить пункт или убрать его.
 *
 * Убираем сравнением по пунктам, а не заменой подстроки: «Кабель» встречается
 * внутри «Кабель питания», и замена текстом искалечила бы соседний пункт.
 */
export function toggleItem(value: string, label: string): string {
  const item = label.replace(/\s+/g, " ").trim();
  if (!item) return value;

  const items = splitItems(value);
  const without = items.filter((i) => i.toLowerCase() !== item.toLowerCase());
  return joinItems(without.length === items.length ? [...items, item] : without);
}

export function ChipInput({
  value,
  onChange,
  options,
  placeholder,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ key: string; label: string }>;
  placeholder?: string;
  id?: string;
}) {
  return (
    <div>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
      />

      <div className="mt-3 flex flex-wrap gap-1.5">
        {options.map((o) => {
          const on = hasItem(value, o.label);
          return (
            <button
              key={o.key}
              type="button"
              // Состояние кнопки — это состояние поля, отдельно оно нигде не
              // хранится. Иначе стерев пункт руками, человек оставил бы
              // кнопку подсвеченной и получил бы два разных ответа на один
              // вопрос: сдавал клиент зарядку или нет.
              aria-pressed={on}
              onClick={() => onChange(toggleItem(value, o.label))}
              className={
                "rounded-pill border px-3 py-1.5 text-[13px] font-medium transition-colors duration-150 " +
                (on
                  ? "border-brand bg-brand-tint text-brand-ink"
                  : "border-line bg-surface-raised text-ink-muted hover:border-line-strong hover:text-ink")
              }
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
