import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import { IconSearch } from "./icons";

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
  const map = {
    new: ["bg-[#152239]", "text-[#7FB0FF]", "bg-state-new"],
    waiting: ["bg-[#2B2416]", "text-[#EFC079]", "bg-state-waiting"],
    progress: ["bg-[#13272C]", "text-[#79D2E2]", "bg-state-progress"],
    done: ["bg-[#152A22]", "text-[#72D6A6]", "bg-state-done"],
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
