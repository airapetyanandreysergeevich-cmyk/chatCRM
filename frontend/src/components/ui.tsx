import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

export function Button({
  variant = "primary",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  const base =
    "inline-flex items-center justify-center rounded-field px-5 font-bold transition min-h-[52px] sm:min-h-[46px] disabled:cursor-not-allowed";
  const variants = {
    primary: "bg-primary text-white hover:bg-primary-press disabled:bg-[#EDE7DD] disabled:text-ink-ghost",
    secondary: "bg-surface border-[1.5px] border-line-strong text-ink hover:bg-primary-tint",
    ghost: "text-primary hover:bg-primary-tint",
    danger: "bg-surface border-[1.5px] border-status-cancelled text-[#93302F] hover:bg-[#FBE1E1]",
  } as const;
  return <button className={cx(base, variants[variant], className)} {...props} />;
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("rounded-card border border-line bg-surface p-4 shadow-card sm:rounded-panel sm:p-6", className)}>
      {children}
    </div>
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
      <span className="mb-1.5 block text-sm font-bold text-ink-soft">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-[13px] text-ink-muted">{hint}</span>}
      {error && <span className="mt-1 block text-[13px] text-[#B5403F]">{error}</span>}
    </label>
  );
}

const controlClass =
  "w-full rounded-field border-[1.5px] bg-surface px-4 text-base text-ink outline-none transition min-h-[56px] sm:min-h-[52px] focus:border-primary";

export function Input({ invalid, className, ...props }: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      className={cx(controlClass, invalid ? "border-status-cancelled bg-[#FFF7F7]" : "border-line-strong", className)}
      {...props}
    />
  );
}

export function Select({ invalid, className, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select
      className={cx(controlClass, invalid ? "border-status-cancelled bg-[#FFF7F7]" : "border-line-strong", className)}
      {...props}
    />
  );
}

/** Статус всегда обозначен и цветом, и текстом — цвет не единственный носитель смысла. */
export function StatusChip({ tone, children }: { tone: "new" | "waiting" | "progress" | "done" | "cancelled"; children: ReactNode }) {
  const tones = {
    new: "bg-[#E4E9FF] text-[#2B44A8]",
    waiting: "bg-[#FFF0D6] text-[#8A5E11]",
    progress: "bg-[#D9F2F6] text-[#12656F]",
    done: "bg-[#DDF3E6] text-[#186B41]",
    cancelled: "bg-[#FBE1E1] text-[#93302F]",
  } as const;
  const dots = {
    new: "bg-status-new",
    waiting: "bg-status-waiting",
    progress: "bg-status-progress",
    done: "bg-status-done",
    cancelled: "bg-status-cancelled",
  } as const;
  return (
    <span className={cx("inline-flex items-center gap-2 rounded-pill px-3 py-1.5 text-[13px] font-bold", tones[tone])}>
      <span className={cx("h-2 w-2 rounded-full", dots[tone])} />
      {children}
    </span>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="text-xs font-extrabold uppercase tracking-[0.13em] text-ink-label">{children}</p>;
}

export function Banner({ tone = "warning", children }: { tone?: "warning" | "error"; children: ReactNode }) {
  const tones = {
    warning: "border-[#F5E2B8] bg-[#FFF8E8] text-[#8A5E11]",
    error: "border-[#F3C6C6] bg-[#FFF7F7] text-[#B5403F]",
  } as const;
  return <div className={cx("rounded-xl border px-4 py-3 text-sm", tones[tone])}>{children}</div>;
}

export function Spinner({ label = "Загрузка" }: { label?: string }) {
  return (
    <div className="flex min-h-[200px] items-center justify-center text-ink-muted" role="status">
      {label}…
    </div>
  );
}
