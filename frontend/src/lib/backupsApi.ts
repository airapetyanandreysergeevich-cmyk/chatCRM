import { api } from "./api";

/**
 * Резервные копии Основы.
 *
 * Два источника. Сервер отдаёт состояние для просмотра — его видно с любого
 * компьютера. Менять места и делать копию умеет только окно программы на
 * самой Основе: папки — это диски того компьютера, и выбрать их можно только
 * там (мостик `window.finecrmDesktop`, см. desktop/src/preload.js).
 */

export interface BackupPlace {
  path: string;
  primary: boolean;
  available: boolean;
  sameDisk: boolean;
  copies: number;
  lastAt: string | null;
  lastOk: boolean | null;
  lastError: string | null;
}

export interface BackupStatus {
  available: boolean;
  enabled?: boolean;
  keep?: number;
  onExit?: boolean;
  atHour?: number;
  running?: boolean;
  last?: { at: string | null; ok: boolean | null; error: string | null; bytes: number | null };
  sameDisk?: boolean;
  places?: BackupPlace[];
}

interface DesktopStatus extends BackupStatus {
  ok: boolean;
  /** Окно открыто на самой Основе — можно менять. */
  here: boolean;
}

interface DesktopResult {
  ok: boolean;
  canceled?: boolean;
  error?: string;
  sameDisk?: boolean;
  placesFailed?: number;
  places?: Array<{ path: string; ok: boolean; error?: string }>;
  status?: BackupStatus;
}

declare global {
  interface Window {
    finecrmDesktop?: {
      backups: {
        status: () => Promise<DesktopStatus>;
        addPlace: () => Promise<DesktopResult>;
        removePlace: (placePath: string) => Promise<DesktopResult>;
        runNow: () => Promise<DesktopResult>;
        open: (placePath: string) => Promise<DesktopResult>;
      };
    };
  }
}

export const backupsApi = {
  status: () => api.get<BackupStatus>("/data/backups"),
  /** Мостик программы, если страница открыта в окне на самой Основе. */
  async desktop() {
    const bridge = window.finecrmDesktop?.backups;
    if (!bridge) return null;
    try {
      const st = await bridge.status();
      return st.here ? bridge : null;
    } catch {
      return null;
    }
  },
};
