/**
 * Логотип нарисован под светлый фон, поэтому в тёмной теме он живёт
 * на белой плашке — так это читается как фирменный блок, а не как ошибка.
 */
export function BrandMark({ size = 36 }: { size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-white"
      style={{ width: size, height: size }}
    >
      <img src="/logo-mark.png" alt="" style={{ width: size - 8 }} />
    </span>
  );
}

export function BrandLogo({ width = 190 }: { width?: number }) {
  return (
    <span className="inline-block rounded-panel bg-white px-5 py-4">
      <img src="/logo-full.png" alt="FineCRM" style={{ width }} />
    </span>
  );
}

export function BrandRow() {
  return (
    <span className="flex items-center gap-2.5">
      <BrandMark size={34} />
      <span className="text-[17px] font-extrabold tracking-tight">
        Fine<span className="text-brand">CRM</span>
      </span>
    </span>
  );
}
