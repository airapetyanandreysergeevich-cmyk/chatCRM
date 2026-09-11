import type { ButtonHTMLAttributes, ComponentType, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import {
  IconSearch,
  IconStatusNew,
  IconStatusProgress,
  IconStatusWaiting,
  IconStatusDone,
  IconStatusClosed,
  IconStatusCancelled,
} from "./icons";

const cx = (...p: Array<string | false | null | undefined>) => p.filter(Boolean).join(" ");

export function Button({
  variant = "primary",
  icon,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger"; icon?: ReactNode }) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-field px-4 text-sm font-semibold " +
    "min-h-[44px] transition-all duration-150 active:scale-[.985] " +
    "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand " +
    "disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100";
  const variants = {
    primary: "bg-brand text-white hover:bg-brand-press",
    secondary: "bg-surface-raised text-ink border border-line hover:border-line-strong hover:bg-[#242936]",
    ghost: "text-ink-muted hover:bg-surface-raised hover:text-ink",
    danger: "bg-surface-raised text-state-off border border-[#40252B] hover:bg-[#2A1B20] hover:border-state-off",
  } as const;
  return (
    <button className={cx(base, variants[variant], className)} {...props}>
      {icon && <span className="[&>svg]:h-[18px] [&>svg]:w-[18px]">{icon}</span>}
      {children}
    </button>
  );
}

export function Card({
  children,
  className,
  interactive,
}: {
  children: ReactNode;
  className?: string;
  interactive?: boolean;
}) {
  return (
    <div
      className={cx(
        "rounded-panel border border-line bg-surface p-5 shadow-card transition-all duration-150",
        interactive && "hover:-translate-y-[1px] hover:border-line-strong hover:shadow-raised",
        className
      )}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  actions,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        {eyebrow && <SectionLabel>{eyebrow}</SectionLabel>}
        <h1 className="mt-1.5 text-[26px] font-extrabold leading-none tracking-tight">{title}</h1>
        {subtitle && <p className="mt-2 text-sm text-ink-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-ink-dim">{children}</p>
  );
}

export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-semibold text-ink-soft">{label}</span>
      {children}
      {hint && !error && <span className="mt-1.5 block text-[12.5px] text-ink-dim">{hint}</span>}
      {error && <span className="mt-1.5 block text-[12.5px] text-state-off">{error}</span>}
    </label>
  );
}

const control =
  "w-full rounded-field border bg-surface-input px-3.5 text-[15px] text-ink placeholder:text-ink-dim " +
  "min-h-[46px] outline-none transition-colors duration-150 focus:border-brand";

export function Input({ invalid, className, ...props }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input className={cx(control, invalid ? "border-state-off" : "border-line", className)} {...props} />;
}

export function Select({ invalid, className, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return <select className={cx(control, invalid ? "border-state-off" : "border-line", className)} {...props} />;
}

export function Textarea({
  invalid,
  className,
  ...props
}: import("react").TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      rows={4}
      className={cx(
        control,
        "min-h-[110px] resize-y py-3 leading-relaxed",
        invalid ? "border-state-off" : "border-line",
        className
      )}
      {...props}
    />
  );
}

/** Чекбокс сделан на кнопке: нативный в тёмной теме выглядит чужеродно и мелко для пальца. */
export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "flex min-h-[42px] w-full items-center gap-2.5 rounded-field border px-3 text-left text-[14px] transition-all duration-150",
        checked
          ? "border-brand/60 bg-brand-tint text-ink"
          : "border-line bg-surface-input text-ink-muted hover:border-line-strong hover:text-ink",
        disabled && "cursor-not-allowed opacity-50"
      )}
    >
      <span
        className={cx(
          "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors duration-150",
          checked ? "border-brand bg-brand text-white" : "border-line-strong"
        )}
      >
        {checked && (
          <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.4}>
            <path d="m3.5 8.5 3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      {label}
    </button>
  );
}

export function SearchInput({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <span className={cx("relative inline-flex w-full items-center", className)}>
      <IconSearch className="pointer-events-none absolute left-3.5 h-[18px] w-[18px] text-ink-dim" />
      <input className={cx(control, "border-line pl-11")} {...props} />
    </span>
  );
}

/** Статус обозначен и цветом, и словом — цвет никогда не единственный носитель смысла. */
export function StatusChip({
  tone,
  children,
}: {
  tone: "new" | "waiting" | "progress" | "done" | "cancelled";
  children: ReactNode;
}) {
  // Цвета рабочих стадий совпадают с колонками на главной — см. lib/stages.ts.
  const map = {
    new: ["bg-[#FFF993]/10", "text-[#FFF993]", "bg-[#FFF993]"],
    waiting: ["bg-[#FC7E68]/10", "text-[#FC7E68]", "bg-[#FC7E68]"],
    progress: ["bg-[#FE3E7D]/10", "text-[#FE3E7D]", "bg-[#FE3E7D]"],
    done: ["bg-[#A5F88B]/10", "text-[#A5F88B]", "bg-[#A5F88B]"],
    cancelled: ["bg-[#2D1A1D]", "text-[#EE9494]", "bg-state-off"],
  } as const;
  const [bg, fg, dot] = map[tone];
  return (
    <span className={cx("inline-flex items-center gap-2 rounded-pill px-2.5 py-1 text-[12.5px] font-semibold", bg, fg)}>
      <span className={cx("h-1.5 w-1.5 rounded-full", dot)} />
      {children}
    </span>
  );
}

/**
 * Значок-плашка для строки списка. Форма значка несёт тот же смысл, что и
 * цвет: список должен читаться и в ярком цеховом свете, и тем, кто цвета
 * различает плохо.
 */
export type GlyphTone = "new" | "progress" | "waiting" | "done" | "closed" | "cancelled" | "neutral";

const GLYPH: Record<GlyphTone, [ComponentType<{ className?: string }>, string]> = {
  new: [IconStatusNew, "bg-[#FFF993]/10 text-[#FFF993]"],
  progress: [IconStatusProgress, "bg-[#FE3E7D]/10 text-[#FE3E7D]"],
  waiting: [IconStatusWaiting, "bg-[#FC7E68]/10 text-[#FC7E68]"],
  done: [IconStatusDone, "bg-[#A5F88B]/10 text-[#A5F88B]"],
  closed: [IconStatusClosed, "bg-[#1E222C] text-[#9AA2B4]"],
  cancelled: [IconStatusCancelled, "bg-[#2D1A1D] text-[#EE9494]"],
  neutral: [IconStatusClosed, "bg-surface-raised text-ink-muted"],
};

export function StatusGlyph({
  tone,
  title,
  icon,
  className,
}: {
  tone: GlyphTone;
  /** Подпись для наведения и для тех, кто слушает страницу голосом. */
  title?: string;
  /** Свой значок вместо статусного — для списков, где статуса нет. */
  icon?: ReactNode;
  className?: string;
}) {
  const [Glyph, skin] = GLYPH[tone];
  return (
    <span
      title={title}
      aria-label={title}
      role={title ? "img" : undefined}
      className={cx(
        "flex h-10 w-10 shrink-0 items-center justify-center rounded-card [&>svg]:h-[20px] [&>svg]:w-[20px]",
        skin,
        className
      )}
    >
      {icon ?? <Glyph />}
    </span>
  );
}

/** Короткая пометка рядом с названием: срочный, организация, отключён. */
export function Badge({
  tone = "neutral",
  icon,
  children,
}: {
  tone?: "neutral" | "danger" | "warning" | "brand" | "done";
  icon?: ReactNode;
  children: ReactNode;
}) {
  const map = {
    neutral: "bg-surface-raised text-ink-muted",
    danger: "bg-[#2D1A1D] text-[#EE9494]",
    warning: "bg-[#2B2416] text-[#EFC079]",
    brand: "bg-brand-tint text-brand-ink",
    done: "bg-[#152A22] text-[#72D6A6]",
  } as const;
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-[11.5px] font-bold [&>svg]:h-3 [&>svg]:w-3",
        map[tone]
      )}
    >
      {icon}
      {children}
    </span>
  );
}

/**
 * Список вместо сетки карточек.
 *
 * Панельками экран вмещает пять-шесть заказов, списком — полтора десятка,
 * и глаз идёт по одной колонке сверху вниз, а не прыгает по плитке. Строки
 * разделены линией, а не тенями: так их видно как единый перечень.
 */
export function List({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        "overflow-hidden rounded-panel border border-line bg-surface shadow-card [&>*+*]:border-t [&>*+*]:border-line",
        className
      )}
    >
      {children}
    </div>
  );
}

/**
 * Строка списка. На широком экране: значок — название — справа сводка.
 * На телефоне сводка переезжает под название, потому что ужимать её в
 * тот же ряд значит сделать нечитаемым и её, и название.
 */
export function ListRow({
  glyph,
  title,
  subtitle,
  meta,
  actions,
  className,
}: {
  glyph?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex items-start gap-3 px-3.5 py-3 transition-colors duration-150 hover:bg-surface-raised sm:gap-4 sm:px-4",
        className
      )}
    >
      {glyph}
      <div className="min-w-0 flex-1">
        <div className="lg:flex lg:items-center lg:gap-4">
          <div className="min-w-0 lg:flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] font-semibold leading-tight">
              {title}
            </div>
            {subtitle && <div className="mt-1 truncate text-[13.5px] text-ink-muted">{subtitle}</div>}
          </div>
          {meta && (
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[12.5px] text-ink-dim lg:mt-0 lg:shrink-0 lg:justify-end lg:gap-4">
              {meta}
            </div>
          )}
        </div>
        {/* На телефоне кнопки уезжают под строку: сбоку они съедали бы
            половину ширины, и от названия оставалось бы «Блок питания …». */}
        {actions && <div className="mt-2.5 sm:hidden">{actions}</div>}
      </div>
      {actions && <div className="hidden shrink-0 items-center gap-2 sm:flex">{actions}</div>}
    </div>
  );
}

/** Заголовок группы внутри списка — «Сегодня», «Просроченные». */
export function ListGroupLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 bg-surface-raised/60 px-4 py-2">
      <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-ink-dim">{children}</span>
      {right && <span className="text-[12px] text-ink-dim">{right}</span>}
    </div>
  );
}

export function Banner({ tone = "info", children }: { tone?: "info" | "warning" | "error"; children: ReactNode }) {
  const map = {
    info: "border-[#1E3550] bg-[#111E2C] text-[#9CC9F0]",
    warning: "border-[#3A3320] bg-[#221E12] text-[#E4BE7C]",
    error: "border-[#3E2529] bg-[#241619] text-[#EE9494]",
  } as const;
  return <div className={cx("rounded-card border px-4 py-3 text-[13.5px] leading-relaxed", map[tone])}>{children}</div>;
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card className="flex flex-col items-center px-6 py-14 text-center">
      {icon && (
        <span className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-card bg-surface-raised text-ink-dim [&>svg]:h-6 [&>svg]:w-6">
          {icon}
        </span>
      )}
      <h2 className="text-lg font-bold">{title}</h2>
      {children && <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-muted">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </Card>
  );
}

export function Spinner({ label = "Загрузка" }: { label?: string }) {
  return (
    <div className="flex min-h-[220px] items-center justify-center gap-3 text-ink-muted" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-line-strong border-t-brand" />
      {label}…
    </div>
  );
}
