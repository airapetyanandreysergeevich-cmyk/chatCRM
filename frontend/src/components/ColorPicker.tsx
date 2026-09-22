import { CUSTOMER_COLORS } from "../lib/customerColor";

/**
 * Выбор цветной метки клиента.
 *
 * Кружки, а не список: цвет выбирают глазами. Первый — «без метки»: убрать
 * метку должно быть так же просто, как поставить.
 */
export function ColorPicker({ value, onChange }: { value: string; onChange: (key: string) => void }) {
  const dot = "flex h-9 w-9 items-center justify-center rounded-full border transition-colors duration-150";
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        aria-label="Без метки"
        aria-pressed={!value}
        title="Без метки"
        onClick={() => onChange("")}
        className={dot + (value ? " border-line text-ink-dim hover:text-ink" : " border-brand text-ink")}
      >
        <span className="text-[16px] leading-none">✕</span>
      </button>
      {CUSTOMER_COLORS.map((c) => (
        <button
          key={c.key}
          type="button"
          aria-label={c.label}
          aria-pressed={value === c.key}
          title={c.label}
          onClick={() => onChange(c.key)}
          className={dot + (value === c.key ? " border-ink" : " border-transparent hover:border-line-strong")}
        >
          <span className="h-[22px] w-[22px] rounded-full" style={{ backgroundColor: c.dot }} />
        </button>
      ))}
    </div>
  );
}
