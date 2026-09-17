import { useTheme } from "../lib/useTheme";

/**
 * Знак в левом верхнем углу.
 *
 * Если мастерская загрузила свой логотип, показываем его: сотрудник должен
 * видеть систему своей мастерской, а не чужой продукт. Пока логотипа нет,
 * стоит знак FineCRM.
 */

export function BrandMark({ size = 36 }: { size?: number }) {
  const { branding } = useTheme();

  if (branding.logo) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[10px]"
        style={{ width: size, height: size }}
      >
        <img src={branding.logo} alt="" className="max-h-full max-w-full object-contain" />
      </span>
    );
  }

  // Знак FineCRM нарисован под светлый фон, поэтому живёт на белой плашке —
  // так это читается как фирменный блок, а не как ошибка.
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

/**
 * Знак в шапке.
 *
 * Свой логотип показываем один, без подписи: в него почти всегда уже вписано
 * название, а втиснутое рядом второе всё равно обрезается. Название
 * мастерской и так стоит внизу бокового меню.
 */
export function BrandRow() {
  const { branding } = useTheme();

  if (branding.logo) {
    return (
      <span className="flex min-w-0 items-center">
        <img
          src={branding.logo}
          alt="Логотип мастерской"
          className="max-h-[36px] max-w-[168px] object-contain object-left"
        />
      </span>
    );
  }

  return (
    <span className="flex items-center gap-2.5">
      <BrandMark size={34} />
      <span className="text-[17px] font-extrabold tracking-tight">
        Fine<span className="text-brand">CRM</span>
      </span>
    </span>
  );
}
