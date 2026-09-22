import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * Камера в окне: веб-камера компьютера или задняя камера телефона.
 *
 * Поток живёт, пока открыто окно, и выключается при закрытии — иначе
 * лампочка камеры горела бы до перезагрузки страницы.
 */
export function useCamera(video: RefObject<HTMLVideoElement>, active: boolean) {
  const stream = useRef<MediaStream | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState<string | null>(null);

  const stop = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setReady(false);
  }, []);

  const start = useCallback(
    async (deviceId: string | null) => {
      stop();
      setError(null);
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("Браузер не даёт доступа к камере на этой странице. Добавьте снимки из галереи.");
        return;
      }
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: "environment" } }),
            width: { ideal: 2560 },
            height: { ideal: 1440 },
          },
        });
        stream.current = s;
        if (video.current) {
          video.current.srcObject = s;
          await video.current.play().catch(() => {});
        }
        setReady(true);
        const all = await navigator.mediaDevices.enumerateDevices();
        setCameras(all.filter((d) => d.kind === "videoinput"));
        setCameraId(s.getVideoTracks()[0]?.getSettings().deviceId ?? deviceId);
      } catch (err) {
        const name = err instanceof DOMException ? err.name : "";
        setError(
          name === "NotAllowedError"
            ? "Доступ к камере запрещён. Разрешите его в настройках браузера или добавьте снимки из галереи."
            : name === "NotFoundError" || name === "OverconstrainedError"
              ? "Камера не найдена. Добавьте снимки из галереи."
              : "Камера не включилась — возможно, её занимает другая программа. Добавьте снимки из галереи."
        );
      }
    },
    [stop, video]
  );

  useEffect(() => {
    if (!active) return;
    void start(null);
    return () => stop();
  }, [active, start, stop]);

  return { ready, error, cameras, cameraId, start, stop };
}
