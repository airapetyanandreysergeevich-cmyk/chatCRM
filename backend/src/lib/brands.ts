/**
 * Авторизованные бренды мастерской — Tenant.settings.authorizedBrands
 * (27.10.2026). Для их техники тип заказа при приёме выбирают явно.
 */
export function readAuthorizedBrands(settings: unknown): string[] {
  const raw = settings && typeof settings === "object" ? (settings as Record<string, unknown>).authorizedBrands : null;
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").slice(0, 60) : [];
}
