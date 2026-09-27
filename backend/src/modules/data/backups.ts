import fs from "fs";
import path from "path";

/**
 * Резервные копии Основы — только для чтения, для «Настройки → Базы».
 *
 * Копии делает программа для Windows, а не сервер: ей принадлежат и база, и
 * расписание, и выбор папок (выбрать папку может только окно на самом
 * компьютере). Но смотреть, когда была последняя копия и куда она легла,
 * нужно и с других компьютеров — владелец редко сидит за Основой. Поэтому
 * программа передаёт серверу путь к своему файлу настроек, а сервер читает
 * из него ровно раздел о копиях. Пароли базы из того же файла наружу не
 * уходят никогда.
 *
 * В облаке пути нет — там раздела нет вовсе: копии облака делает сервер.
 */

const PLACE_DIR = "FineCRM копии";

interface RawPlace {
  path?: unknown;
  lastAt?: unknown;
  lastOk?: unknown;
  lastError?: unknown;
}

const str = (v: unknown) => (typeof v === "string" ? v : null);
const bool = (v: unknown) => (typeof v === "boolean" ? v : null);

function countDumps(dir: string): number {
  try {
    return fs.readdirSync(path.join(dir, "db")).filter((f) => f.endsWith(".dump")).length;
  } catch {
    return 0;
  }
}

const rootOf = (p: string) => path.parse(path.resolve(p)).root.toLowerCase();

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
  last?: { at: string | null; ok: boolean | null; error: string | null; bytes: number | null };
  /** Все места на одном диске с базой — копия не переживёт смерть диска. */
  sameDisk?: boolean;
  places?: BackupPlace[];
}

export function readBackupStatus(configPath = process.env.FINECRM_CONFIG): BackupStatus {
  if (!configPath) return { available: false };
  let raw: { backup?: Record<string, unknown> };
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return { available: false };
  }
  const b = raw.backup ?? {};
  const dataRoot = path.dirname(configPath);
  const primaryDir = str(b.folder) || path.join(dataRoot, "backups");

  const extra = (Array.isArray(b.places) ? (b.places as RawPlace[]) : [])
    .filter((p) => typeof p?.path === "string" && p.path)
    .map((p) => {
      const chosen = p.path as string;
      const dir = path.basename(path.resolve(chosen)) === PLACE_DIR ? chosen : path.join(chosen, PLACE_DIR);
      return {
        path: chosen,
        primary: false,
        available: fs.existsSync(chosen),
        sameDisk: rootOf(dir) === rootOf(dataRoot),
        copies: countDumps(dir),
        lastAt: str(p.lastAt),
        lastOk: bool(p.lastOk),
        lastError: str(p.lastError),
      };
    });

  // Прежняя «своя папка» (до нескольких мест) — считается дополнительным
  // местом: так её и переносит программа при следующем запуске.
  if (str(b.folder) && !extra.some((p) => p.path === b.folder)) {
    const legacy = b.folder as string;
    extra.push({
      path: legacy,
      primary: false,
      available: fs.existsSync(legacy),
      sameDisk: rootOf(legacy) === rootOf(dataRoot),
      copies: countDumps(legacy),
      lastAt: null,
      lastOk: null,
      lastError: null,
    });
  }

  const primary: BackupPlace = {
    path: path.join(dataRoot, "backups"),
    primary: true,
    available: true,
    sameDisk: true,
    copies: countDumps(str(b.folder) ? path.join(dataRoot, "backups") : primaryDir),
    lastAt: str(b.lastAt),
    lastOk: bool(b.lastOk),
    lastError: str(b.lastError),
  };
  const places = [primary, ...extra];

  const keep = typeof b.keep === "number" && b.keep !== 14 ? b.keep : 7;
  return {
    available: true,
    enabled: b.enabled !== false,
    keep,
    onExit: b.onExit !== false,
    atHour: typeof b.atHour === "number" ? b.atHour : 20,
    last: {
      at: str(b.lastAt),
      ok: bool(b.lastOk),
      error: str(b.lastError),
      bytes: typeof b.lastBytes === "number" ? b.lastBytes : null,
    },
    sameDisk: places.every((p) => p.sameDisk),
    places,
  };
}
