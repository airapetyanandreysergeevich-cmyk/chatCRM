import { api, ApiError } from "./api";
import { BASE } from "./basePath";

/**
 * Печать через CRM.
 *
 * Печатает компьютер мастерской с программой FineCRM — «станция печати».
 * Отсюда, с любого устройства, задание уходит на сервер, станция его
 * забирает и печатает молча (backend/src/modules/printing, desktop/src/printing.js).
 *
 * Здесь же — сама станция: если страница открыта в окне программы, она
 * сообщает серверу принтеры этого компьютера и печатает задания.
 */

export type PrintDoc = "intake" | "act" | "test";
export type IntakeMode = "ask" | "auto" | "off";

export interface PrinterInfo {
  name: string;
  displayName: string;
  isDefault: boolean;
}

export interface Station {
  id: string;
  name: string;
  online: boolean;
  lastSeenAt: string;
  printers: PrinterInfo[];
}

export interface Target {
  stationId: string;
  printer: string;
  copies: number;
}

export interface TargetView extends Target {
  stationName: string | null;
  printerLabel: string;
  stationGone: boolean;
  printerGone: boolean;
  online: boolean;
}

export interface PrintingOverview {
  stations: Station[];
  workshop: TargetView | null;
  mine: TargetView | null;
  effective: (TargetView & { source: "mine" | "workshop" }) | null;
  intake: IntakeMode;
  canManage: boolean;
  personal: boolean;
}

export interface PrintJob {
  id: string;
  status: "QUEUED" | "SENT" | "DONE" | "FAILED";
  error: string | null;
  printer: string;
  copies: number;
  station: string | null;
}

export const printingApi = {
  overview: () => api.get<PrintingOverview>("/printing"),
  setWorkshop: (documents: Target | null) => api.put<{ ok: true }>("/printing/workshop", { documents }),
  setMine: (body: { documents?: Target | null; intake?: IntakeMode }) => api.put<{ ok: true }>("/printing/mine", body),
  removeStation: (id: string) => api.del(`/printing/stations/${id}`),
  send: (body: { doc: PrintDoc; orderId?: string; stationId?: string; printer?: string; copies?: number }) =>
    api.post<PrintJob>("/printing/jobs", body),
  job: (id: string) => api.get<PrintJob>(`/printing/jobs/${id}`),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Отправить и дождаться ответа станции. onStep — для строки «Отправлено…».
 * Ошибка сервера (принтер не назначен, компьютер не на связи) — исключением
 * ApiError с кодом, ответ станции — в самом задании.
 */
export async function printAndWait(
  body: Parameters<typeof printingApi.send>[0],
  onStep?: (job: PrintJob) => void,
  timeoutMs = 120_000
): Promise<PrintJob> {
  let job = await printingApi.send(body);
  onStep?.(job);
  const until = Date.now() + timeoutMs;
  while (job.status === "QUEUED" || job.status === "SENT") {
    if (Date.now() > until) {
      return { ...job, status: "FAILED", error: "Нет ответа от компьютера с принтером — проверьте, вышел ли лист" };
    }
    await sleep(job.status === "QUEUED" ? 800 : 1200);
    try {
      job = await printingApi.job(job.id);
      onStep?.(job);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) throw err;
      // связь моргнула — спросим ещё раз
    }
  }
  return job;
}

/** Подпись принтера: «HP LaserJet · Приёмка». */
export const targetLabel = (t: TargetView) => `${t.printerLabel}${t.stationName ? ` · ${t.stationName}` : ""}`;

// ---------------------------------------------------------------- станция печати

export interface PrintBridge {
  info: () => Promise<{ ok: boolean; deviceId?: string; name?: string }>;
  printers: () => Promise<{ ok: boolean; printers?: PrinterInfo[] }>;
  print: (job: { url: string; printer: string; copies: number }) => Promise<{ ok: boolean; error?: string }>;
}

export const printBridge = (): PrintBridge | null =>
  (typeof window !== "undefined" && window.finecrmDesktop?.printing) || null;

/** Заголовки, по которым программа понимает, что бланк дорисован (desktop/src/printing.js). */
export const STATION_READY = "FINECRM-PRINT-READY";
export const STATION_FAILED = "FINECRM-PRINT-ERROR:";
export const isStationPage = () => new URLSearchParams(window.location.search).get("station") === "1";

/** Адрес бланка для станции — на этом же сервере, с приставкой /b/<код>/, если она есть. */
export function stationUrl(job: { doc: string; orderId: string | null; printer: string }, stationName: string): string {
  const path =
    job.doc === "test" || !job.orderId
      ? `print-test?station=1&printer=${encodeURIComponent(job.printer)}&pc=${encodeURIComponent(stationName)}`
      : `orders/${job.orderId}/print?doc=${job.doc === "act" ? "act" : "intake"}&station=1`;
  return new URL(BASE + path, window.location.origin).toString();
}

/**
 * Запустить станцию в окне программы. Возвращает «остановить».
 *
 * Раз в минуту — «я здесь, вот мои принтеры», в остальное время — долгий
 * опрос: сервер держит запрос до 25 секунд и отвечает, как только появилось
 * задание. Ошибки связи не роняют цикл: подождали и пробуем снова.
 */
export function startPrintStation(bridge: PrintBridge): () => void {
  let stopped = false;
  let stationId: string | null = null;
  let stationName = "";
  let lastBeat = 0;

  async function beat() {
    const info = await bridge.info();
    if (!info.ok || !info.deviceId) throw new Error("не окно программы");
    const list = await bridge.printers();
    stationName = info.name || "Компьютер";
    const r = await api.post<{ id: string }>("/printing/stations", {
      deviceId: info.deviceId,
      name: stationName.slice(0, 80),
      printers: (list.printers ?? []).slice(0, 60),
    });
    stationId = r.id;
    lastBeat = Date.now();
  }

  async function loop() {
    let pause = 0;
    while (!stopped) {
      if (pause) await sleep(pause);
      if (stopped) break;
      try {
        if (!stationId || Date.now() - lastBeat > 60_000) await beat();
        const r = await api.get<{ job: { id: string; doc: string; orderId: string | null; printer: string; copies: number } | null }>(
          `/printing/stations/${stationId}/next?wait=25`
        );
        pause = 0;
        if (!r.job || stopped) continue;
        const done = await bridge
          .print({ url: stationUrl(r.job, stationName), printer: r.job.printer, copies: r.job.copies })
          .catch((err: unknown) => ({ ok: false, error: String((err as Error)?.message ?? err) }));
        await api
          .post(`/printing/jobs/${r.job.id}/result`, done.ok ? { ok: true } : { ok: false, error: (done.error ?? "").slice(0, 500) })
          .catch(() => undefined);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) stationId = null; // станцию убрали — заведём заново
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          stopped = true; // вышли из программы — печатать не от кого
          break;
        }
        pause = Math.min(30_000, (pause || 2_000) * 2);
      }
    }
  }

  void loop();
  return () => {
    stopped = true;
  };
}
