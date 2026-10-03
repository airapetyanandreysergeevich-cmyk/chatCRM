import { useEffect, useState } from "react";
import { ordersApi } from "../lib/orders";

/** Ссылка на файл подписанная и живёт недолго, поэтому запрашиваем её при показе. */
export function Photo({
  orderId,
  attachmentId,
  name,
  onOpen,
}: {
  orderId: string;
  attachmentId: string;
  name: string;
  onOpen: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    ordersApi
      .attachmentUrl(orderId, attachmentId)
      .then((r) => alive && setUrl(r.url))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [orderId, attachmentId]);

  return (
    <button
      type="button"
      onClick={onOpen}
      title={name}
      className="block h-[92px] w-[92px] overflow-hidden rounded-card border border-line bg-surface-input transition-all duration-150 hover:border-line-strong"
    >
      {url ? (
        <img src={url} alt={name} loading="lazy" className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full items-center justify-center text-[11px] text-ink-dim">…</span>
      )}
    </button>
  );
}
