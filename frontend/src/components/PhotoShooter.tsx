import { useEffect, useRef, useState } from "react";
import { ApiError } from "../lib/api";
import { plural } from "../lib/format";
import { ordersApi } from "../lib/orders";
import { compressPhoto, formatSize, frameToPhoto } from "../lib/photos";
import { useCamera } from "../lib/useCamera";
import { IconCamera, IconClose } from "./icons";
import { Modal } from "./Modal";
import { Banner, Button } from "./ui";

/**
 * Съёмка серии: снять сколько нужно подряд, проверить и загрузить разом.
 *
 * Раньше каждая фотография была отдельным походом: кнопка, выбор файла или
 * камера телефона, один снимок, загрузка — и снова. На ноутбук с шестью
 * царапинами это шесть кругов, и последний обычно пропускали.
 *
 * Здесь камера включена всё время, «Снять» кладёт кадр в ленту под видео, а
 * загружается всё одной кнопкой. Снимки сжимаются сразу при съёмке (см.
 * lib/photos): в памяти телефона лежат полмегабайта, а не восемь.
 */

type Kind = "INTAKE" | "COMPLETION";

interface Shot {
  id: number;
  file: File;
  url: string;
}

export function PhotoShooter({
  orderId,
  defaultKind,
  onDone,
  onClose,
}: {
  orderId: string;
  defaultKind: Kind;
  onDone: (count: number) => void;
  onClose: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const counter = useRef(0);
  const [kind, setKind] = useState<Kind>(defaultKind);
  const [shots, setShots] = useState<Shot[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const camera = useCamera(video, true);

  // Адреса превью — память браузера. Освобождаем при уходе из окна.
  const urls = useRef<string[]>([]);
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  function add(files: File[]) {
    const next = files.map((file) => {
      const url = URL.createObjectURL(file);
      urls.current.push(url);
      counter.current += 1;
      return { id: counter.current, file, url };
    });
    setShots((s) => [...s, ...next]);
  }

  function remove(id: number) {
    setShots((s) => {
      const gone = s.find((x) => x.id === id);
      if (gone) URL.revokeObjectURL(gone.url);
      return s.filter((x) => x.id !== id);
    });
  }

  async function snap() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    setFlash(true);
    setTimeout(() => setFlash(false), 120);
    try {
      add([await frameToPhoto(v, counter.current + 1)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось снять кадр");
    }
  }

  async function pick(list: FileList | null) {
    if (!list?.length) return;
    setBusy("Сжимаем снимки…");
    try {
      const out: File[] = [];
      for (const f of Array.from(list)) out.push(await compressPhoto(f));
      add(out);
    } finally {
      setBusy(null);
    }
  }

  async function upload() {
    if (!shots.length) return;
    setError(null);
    let done = 0;
    try {
      await ordersApi.upload(
        orderId,
        shots.map((s) => s.file),
        kind,
        (n, total) => {
          done = n;
          setBusy(`Загружаем ${n} из ${total}…`);
        }
      );
      camera.stop();
      onDone(shots.length);
    } catch (err) {
      // Что уже ушло на сервер, из ленты убираем: повторная загрузка не
      // должна сделать дубли первых пачек.
      if (done > 0) {
        shots.slice(0, done).forEach((x) => URL.revokeObjectURL(x.url));
        setShots((s) => s.slice(done));
      }
      const why = err instanceof ApiError ? err.message : "Не удалось загрузить снимки — проверьте связь";
      setError(done > 0 ? `${why}. Загружено ${done}, остальные остались в ленте — нажмите «Загрузить» ещё раз.` : why);
    } finally {
      setBusy(null);
    }
  }

  function close() {
    // Снятое, но не загруженное — не выбрасываем молча.
    if (shots.length && !leaving) {
      setLeaving(true);
      return;
    }
    camera.stop();
    onClose();
  }

  const total = shots.reduce((s, x) => s + x.file.size, 0);

  return (
    <Modal title="Фотографии заказа" onClose={close}>
      <input
        ref={gallery}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          void pick(e.target.files);
          e.target.value = "";
        }}
      />

      <div className="space-y-4">
        {leaving && (
          <Banner tone="error">
            Не загружено: {plural(shots.length, "снимок", "снимка", "снимков")}. Закрыть и выбросить их?
            <div className="mt-3 flex flex-wrap gap-2">
              <Button type="button" variant="danger" className="px-4 text-[13px]" onClick={() => { setShots([]); camera.stop(); onClose(); }}>
                Выбросить и закрыть
              </Button>
              <Button type="button" variant="secondary" className="px-4 text-[13px]" onClick={() => setLeaving(false)}>
                Вернуться
              </Button>
            </div>
          </Banner>
        )}
        {error && <Banner tone="error">{error}</Banner>}

        <div className="flex flex-wrap gap-1.5">
          {(
            [
              ["INTAKE", "При приёме"],
              ["COMPLETION", "После ремонта"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
              className={
                "rounded-pill border px-3 py-1.5 text-[13px] font-medium transition-colors duration-150 " +
                (kind === k
                  ? "border-brand bg-brand-tint text-brand-ink"
                  : "border-line bg-surface-raised text-ink-muted hover:text-ink")
              }
            >
              {label}
            </button>
          ))}
        </div>

        {camera.error ? (
          <Banner>{camera.error}</Banner>
        ) : (
          <div className="relative overflow-hidden rounded-field bg-black">
            <video ref={video} playsInline muted className="block aspect-[4/3] w-full object-cover" />
            {!camera.ready && (
              <div className="absolute inset-0 flex items-center justify-center text-sm text-white/80">
                Включаем камеру…
              </div>
            )}
            {/* Вспышка — чтобы было видно, что кадр сделан: иначе жмут дважды. */}
            <div
              className={
                "pointer-events-none absolute inset-0 bg-white transition-opacity duration-100 " +
                (flash ? "opacity-60" : "opacity-0")
              }
            />
            {shots.length > 0 && (
              <span className="absolute right-2 top-2 rounded-pill bg-black/60 px-2.5 py-1 text-[12.5px] font-semibold text-white">
                {shots.length}
              </span>
            )}
          </div>
        )}

        {camera.cameras.length > 1 && !camera.error && (
          <div className="flex flex-wrap gap-1.5">
            {camera.cameras.map((c, i) => (
              <button
                key={c.deviceId}
                type="button"
                onClick={() => void camera.start(c.deviceId)}
                aria-pressed={c.deviceId === camera.cameraId}
                className={
                  "rounded-pill border px-3 py-1 text-[12.5px] font-medium " +
                  (c.deviceId === camera.cameraId
                    ? "border-brand bg-brand-tint text-brand-ink"
                    : "border-line bg-surface-raised text-ink-muted hover:text-ink")
                }
              >
                {c.label || `Камера ${i + 1}`}
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          {!camera.error && (
            <Button
              type="button"
              icon={<IconCamera />}
              onClick={() => void snap()}
              disabled={!camera.ready || !!busy}
              className="sm:flex-1"
            >
              Снять
            </Button>
          )}
          <Button type="button" variant="secondary" onClick={() => gallery.current?.click()} disabled={!!busy} className="sm:flex-1">
            Из галереи
          </Button>
        </div>

        {shots.length > 0 && (
          <div>
            <p className="mb-2 text-[12.5px] text-ink-dim">
              {plural(shots.length, "снимок", "снимка", "снимков")}, {formatSize(total)}
              {" "}— лишний уберите крестиком
            </p>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {shots.map((s) => (
                <div key={s.id} className="relative h-[72px] w-[72px] shrink-0 overflow-hidden rounded-card border border-line">
                  <img src={s.url} alt="" className="h-full w-full object-cover" />
                  <button
                    type="button"
                    aria-label="Убрать снимок"
                    onClick={() => remove(s.id)}
                    className="absolute right-0.5 top-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/65 text-white [&>svg]:h-3.5 [&>svg]:w-3.5"
                  >
                    <IconClose />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <Button type="button" onClick={() => void upload()} disabled={!shots.length || !!busy} className="w-full">
          {busy ?? (shots.length ? `Загрузить ${plural(shots.length, "снимок", "снимка", "снимков")}` : "Снимите или выберите фото")}
        </Button>
      </div>
    </Modal>
  );
}
