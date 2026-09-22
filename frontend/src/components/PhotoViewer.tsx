import { useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import { ordersApi } from "../lib/orders";
import { IconChevronLeft, IconChevronRight } from "./icons";
import { Modal } from "./Modal";
import { Banner, Button } from "./ui";

/**
 * Просмотр фотографий заказа — в окне, а не в новой вкладке.
 *
 * Раньше снимок открывался ссылкой в новой вкладке, а в программе для
 * Windows — вообще во внешнем браузере: смотреть шесть царапин значило
 * шесть раз уходить из программы и возвращаться. Здесь листаются стрелками,
 * и тут же лишний снимок можно удалить.
 */

export interface ViewerPhoto {
  id: string;
  fileName: string;
  kind: string;
}

export function PhotoViewer({
  orderId,
  photos,
  start,
  canDelete,
  onDeleted,
  onClose,
}: {
  orderId: string;
  photos: ViewerPhoto[];
  start: number;
  canDelete: boolean;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(start);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const photo = photos[Math.min(index, photos.length - 1)];

  // Ссылку просим только на показанный снимок и соседей: листать без
  // ожидания, но и не тянуть сразу все.
  useEffect(() => {
    let alive = true;
    for (const i of [index, index + 1, index - 1]) {
      const p = photos[i];
      if (!p || urls[p.id]) continue;
      ordersApi
        .attachmentUrl(orderId, p.id)
        .then((r) => alive && setUrls((u) => ({ ...u, [p.id]: r.url })))
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
  }, [index, orderId, photos, urls]);

  // Стрелки клавиатуры — на компьютере так быстрее, чем мышью.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setIndex((i) => Math.min(photos.length - 1, i + 1));
      if (e.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [photos.length]);

  if (!photo) return null;
  const url = urls[photo.id];

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await ordersApi.removeAttachment(orderId, photo.id);
      setConfirm(false);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось удалить снимок");
    } finally {
      setBusy(false);
    }
  }

  const arrow =
    "absolute top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white transition-opacity duration-150 hover:bg-black/75 disabled:opacity-0 [&>svg]:h-5 [&>svg]:w-5";

  return (
    <Modal title={`Снимок ${index + 1} из ${photos.length}`} onClose={onClose} wide>
      <div className="space-y-4">
        {error && <Banner tone="error">{error}</Banner>}
        <div className="relative flex min-h-[240px] items-center justify-center overflow-hidden rounded-field bg-black">
          {url ? (
            <img src={url} alt={photo.fileName} className="max-h-[62dvh] w-auto max-w-full object-contain" />
          ) : (
            <span className="text-sm text-white/70">Загружаем…</span>
          )}
          <button
            type="button"
            aria-label="Предыдущий снимок"
            className={arrow + " left-2"}
            disabled={index === 0}
            onClick={() => setIndex((i) => i - 1)}
          >
            <IconChevronLeft />
          </button>
          <button
            type="button"
            aria-label="Следующий снимок"
            className={arrow + " right-2"}
            disabled={index >= photos.length - 1}
            onClick={() => setIndex((i) => i + 1)}
          >
            <IconChevronRight />
          </button>
        </div>

        <p className="truncate text-[12.5px] text-ink-dim">
          {photo.kind === "COMPLETION" ? "После ремонта" : "При приёме"} · {photo.fileName}
        </p>

        {confirm ? (
          <Banner tone="error">
            Удалить этот снимок насовсем?
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" variant="danger" className="px-4 text-[13px]" disabled={busy} onClick={() => void remove()}>
                {busy ? "Удаляем…" : "Удалить"}
              </Button>
              <Button type="button" variant="secondary" className="px-4 text-[13px]" onClick={() => setConfirm(false)}>
                Оставить
              </Button>
            </div>
          </Banner>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            {url && (
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-[44px] items-center justify-center rounded-field border border-line px-4 text-[14px] font-semibold text-ink-soft hover:text-ink sm:flex-1"
              >
                Открыть в полном размере
              </a>
            )}
            {canDelete && (
              <Button type="button" variant="ghost" onClick={() => setConfirm(true)} className="sm:flex-1">
                Удалить снимок
              </Button>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
