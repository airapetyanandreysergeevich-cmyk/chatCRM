import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../lib/api";
import {
  draftOf,
  fileToJpeg,
  plateApi,
  toJpeg,
  type DeviceFields,
  type PlateKey,
  type PlateMode,
  type PlateResult,
} from "../lib/plate";
import { IconCamera } from "./icons";
import { Modal } from "./Modal";
import { Banner, Button, Input } from "./ui";

/**
 * Камера для шильдика: снять → распознать → проверить → подставить в бланк.
 *
 * Ничего не попадает в бланк само. Распознаватель ошибается редко, но
 * ошибка в серийном номере стоит дорого, поэтому последнее слово за
 * приёмщиком: поля в окне можно поправить руками, а у спорных есть кнопки
 * с другими вариантами, найденными на том же шильдике.
 *
 * Камера — веб-камера компьютера или задняя камера телефона. Где камеры нет
 * или браузер её не дал, остаётся «Выбрать фото»: на телефоне эта кнопка
 * сама открывает камеру, на компьютере — снимок с диска.
 */

type Stage = "camera" | "busy" | "result";

const FIELDS: Array<{ key: PlateKey; label: string }> = [
  { key: "brand", label: "Бренд" },
  { key: "model", label: "Модель" },
  { key: "serial", label: "Серийный номер" },
  { key: "kind", label: "Тип" },
];

export function PlateScanner({
  current,
  mode = "server",
  onApply,
  onClose,
}: {
  /** Что сейчас в бланке — чтобы предупредить о замене. */
  current: DeviceFields;
  /** Где распознавать: на сервере или здесь, в окне (локальная версия). */
  mode?: PlateMode;
  onApply: (draft: DeviceFields) => void;
  onClose: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const [stage, setStage] = useState<Stage>("camera");
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState<string | null>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PlateResult | null>(null);
  const [draft, setDraft] = useState<DeviceFields>({ kind: "", brand: "", model: "", serial: "" });
  /** Куда вставить строку из «Весь текст» — поле, в котором был курсор. */
  const [target, setTarget] = useState<PlateKey>("model");

  const stop = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setCameraReady(false);
  }, []);

  const start = useCallback(
    async (deviceId: string | null) => {
      stop();
      setCameraError(null);
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError("Браузер не даёт доступа к камере на этой странице. Выберите фото кнопкой ниже.");
        return;
      }
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } }),
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        });
        stream.current = s;
        if (video.current) {
          video.current.srcObject = s;
          await video.current.play().catch(() => {});
        }
        setCameraReady(true);
        // Названия камер браузер открывает только после разрешения.
        const all = await navigator.mediaDevices.enumerateDevices();
        setCameras(all.filter((d) => d.kind === "videoinput"));
        setCameraId(s.getVideoTracks()[0]?.getSettings().deviceId ?? deviceId);
      } catch (err) {
        const name = err instanceof DOMException ? err.name : "";
        setCameraError(
          name === "NotAllowedError"
            ? "Доступ к камере запрещён. Разрешите его в настройках браузера или выберите фото кнопкой ниже."
            : name === "NotFoundError" || name === "OverconstrainedError"
              ? "Камера не найдена. Выберите фото кнопкой ниже."
              : "Камера не включилась — возможно, её занимает другая программа. Выберите фото кнопкой ниже."
        );
      }
    },
    [stop]
  );

  useEffect(() => {
    void start(null);
    return () => stop();
  }, [start, stop]);

  // Пока наводят камеру, распознаватель уже грузится.
  useEffect(() => {
    void plateApi.warmUp(mode).catch(() => {});
  }, [mode]);

  // После «Переснять» окно видео появляется заново, а поток уже включён —
  // подключаем его к новому окну.
  useEffect(() => {
    const v = video.current;
    if (stage === "camera" && v && stream.current && v.srcObject !== stream.current) {
      v.srcObject = stream.current;
      void v.play().catch(() => {});
    }
  }, [stage, cameraReady]);

  // Снимок живёт как адрес в памяти браузера — освобождаем его за собой.
  useEffect(() => () => void (shot && URL.revokeObjectURL(shot)), [shot]);

  async function recognize(image: Blob) {
    stop();
    setShot(URL.createObjectURL(image));
    setStage("busy");
    setError(null);
    try {
      const r = await plateApi.recognize(image, mode);
      setResult(r);
      setDraft(draftOf(r));
      setTarget(r.serial ? (r.model ? "brand" : "model") : "serial");
      setStage("result");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось распознать снимок");
      setStage("result");
    }
  }

  async function capture() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    try {
      await recognize(await toJpeg(v, v.videoWidth, v.videoHeight));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось снять кадр");
    }
  }

  async function pickFile(file: File | undefined) {
    if (!file) return;
    try {
      await recognize(await fileToJpeg(file));
    } catch {
      setError("Не удалось открыть снимок — это точно фотография?");
      setStage("result");
    }
  }

  function retake() {
    setResult(null);
    setError(null);
    setShot(null);
    setStage("camera");
    void start(cameraId);
  }

  const nothing = result && !result.brand && !result.model && !result.serial;
  const anything = Object.values(draft).some((v) => v.trim());

  return (
    <Modal title="Шильдик камерой" onClose={onClose}>
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        // На телефоне открывает камеру сразу, на компьютере — выбор файла.
        capture="environment"
        className="hidden"
        onChange={(e) => {
          void pickFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />

      {stage === "camera" && (
        <div className="space-y-4">
          {cameraError ? (
            <Banner>{cameraError}</Banner>
          ) : (
            <>
              <div className="relative overflow-hidden rounded-field bg-black">
                <video ref={video} playsInline muted className="block aspect-[4/3] w-full object-cover" />
                {/* Рамка-подсказка. Кадр снимается целиком: шильдик часто
                    шире рамки, и обрезать его было бы хуже, чем снять лишнее. */}
                <div className="pointer-events-none absolute inset-[9%] rounded-[10px] border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
                {!cameraReady && (
                  <div className="absolute inset-0 flex items-center justify-center text-sm text-white/80">
                    Включаем камеру…
                  </div>
                )}
              </div>
              <p className="text-[13px] text-ink-dim">
                Наведите на шильдик так, чтобы строки с моделью и серийным номером были в рамке и
                без бликов. Ближе — лучше, лишь бы текст оставался чётким.
              </p>
              {cameras.length > 1 && (
                <div className="flex flex-wrap gap-1.5">
                  {cameras.map((c, i) => (
                    <button
                      key={c.deviceId}
                      type="button"
                      onClick={() => void start(c.deviceId)}
                      aria-pressed={c.deviceId === cameraId}
                      className={
                        "rounded-pill border px-3 py-1.5 text-[13px] font-medium transition-colors duration-150 " +
                        (c.deviceId === cameraId
                          ? "border-brand bg-brand-tint text-brand-ink"
                          : "border-line bg-surface-raised text-ink-muted hover:text-ink")
                      }
                    >
                      {c.label || `Камера ${i + 1}`}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            {!cameraError && (
              <Button
                type="button"
                icon={<IconCamera />}
                onClick={() => void capture()}
                disabled={!cameraReady}
                className="sm:flex-1"
              >
                Снять
              </Button>
            )}
            <Button type="button" variant="secondary" onClick={() => fileInput.current?.click()} className="sm:flex-1">
              Выбрать фото
            </Button>
          </div>
        </div>
      )}

      {stage === "busy" && (
        <div className="space-y-4">
          {shot && <img src={shot} alt="Снимок шильдика" className="w-full rounded-field opacity-60" />}
          <div className="flex items-center justify-center gap-3 text-ink-muted" role="status">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-line-strong border-t-brand" />
            {mode === "browser"
              ? "Распознаём на этом компьютере — несколько секунд…"
              : "Распознаём — обычно пару секунд…"}
          </div>
        </div>
      )}

      {stage === "result" && (
        <div className="space-y-4">
          {error && <Banner tone="error">{error}</Banner>}
          {nothing && (
            <Banner>
              На снимке не нашлось ни бренда, ни модели, ни серийного номера. Переснимите ближе и без
              бликов — или выберите нужную строку в распознанном тексте ниже.
            </Banner>
          )}

          {shot && <img src={shot} alt="Снимок шильдика" className="max-h-[160px] w-full rounded-field object-contain" />}

          {result && (
            <>
              {FIELDS.map(({ key, label }) => {
                const options =
                  key === "kind" ? [] : (result[key]?.options ?? []).filter((o) => o !== draft[key]);
                const now = current[key].trim();
                const replaces = key !== "kind" && now && draft[key].trim() && now !== draft[key].trim();
                return (
                  <div key={key}>
                    <div className="mb-1.5 flex items-center gap-2">
                      <span className="text-[13px] font-semibold text-ink-soft">{label}</span>
                      {key === "serial" && result.serialConfirmed && draft.serial === result.serial?.value && (
                        <span className="rounded-full bg-stage-done/10 px-2 py-0.5 text-[11.5px] font-semibold text-stage-done">
                          сверен со штрихкодом
                        </span>
                      )}
                    </div>
                    <Input
                      value={draft[key]}
                      onFocus={() => setTarget(key)}
                      onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                      placeholder={key === "kind" ? "Не определён" : "Не найдено"}
                      className={key === "serial" ? "font-mono" : undefined}
                    />
                    {options.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {options.map((o) => (
                          <button
                            key={o}
                            type="button"
                            onClick={() => setDraft((d) => ({ ...d, [key]: o }))}
                            className="rounded-pill border border-line bg-surface-raised px-3 py-1 text-[12.5px] font-medium text-ink-muted transition-colors duration-150 hover:border-line-strong hover:text-ink"
                          >
                            {o}
                          </button>
                        ))}
                      </div>
                    )}
                    {replaces && (
                      <p className="mt-1.5 text-[12.5px] text-ink-dim">Сейчас в бланке «{now}» — будет заменено</p>
                    )}
                    {key === "kind" && now && draft.kind.trim() && (
                      <p className="mt-1.5 text-[12.5px] text-ink-dim">Тип в бланке уже указан — его не трогаем</p>
                    )}
                  </div>
                );
              })}

              {result.text.length > 0 && (
                <details className="rounded-field border border-line px-3 py-2">
                  <summary className="cursor-pointer text-[13px] font-semibold text-ink-muted">
                    Весь распознанный текст
                  </summary>
                  <p className="mt-2 text-[12.5px] text-ink-dim">
                    Нажмите строку — она встанет в поле «{FIELDS.find((f) => f.key === target)?.label}».
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {result.text.map((line, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setDraft((d) => ({ ...d, [target]: line.trim() }))}
                        className="rounded-[8px] border border-line bg-surface-raised px-2 py-1 text-left font-mono text-[12px] text-ink-muted hover:text-ink"
                      >
                        {line}
                      </button>
                    ))}
                  </div>
                </details>
              )}
            </>
          )}

          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            {result && (
              <Button type="button" onClick={() => onApply(draft)} disabled={!anything} className="sm:flex-1">
                Подставить в бланк
              </Button>
            )}
            <Button type="button" variant="secondary" onClick={retake} className="sm:flex-1">
              Переснять
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
