import { kindBadge, type OrderKind } from "../lib/orders";
import { IconWarranty } from "./icons";
import { Badge } from "./ui";

/** Плашка типа заказа: «гарантия ASUS», «гарантия», «диагностика». Обычный ремонт — без плашки. */
export function KindBadge({ kind, brand }: { kind: OrderKind | undefined | null; brand?: string | null }) {
  const b = kindBadge(kind, brand);
  if (!b) return null;
  return (
    <span title={b.title} data-kind-badge={kind ?? undefined} className="inline-flex">
      <Badge tone={b.tone} icon={b.tone === "neutral" ? undefined : <IconWarranty />}>
        {b.label}
      </Badge>
    </span>
  );
}
