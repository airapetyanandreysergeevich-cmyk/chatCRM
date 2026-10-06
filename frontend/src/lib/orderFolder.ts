import { api } from "./api";

/**
 * Папка заказа на компьютере.
 *
 * Как называть папки — общее на мастерскую (сервер, Настройки → Базы). Где
 * лежит общая папка — своё у каждого компьютера: его помнит программа FineCRM
 * (desktop/src/orderFolders.js), в браузере и на телефоне папок нет вовсе.
 */

export type FolderTemplate = "number" | "number_device" | "number_customer" | "number_device_customer";

export interface FolderSettings {
  template: FolderTemplate;
  byYear: boolean;
  createOnIntake: boolean;
}

export interface FolderRequest {
  number: string;
  parts: string[];
  year: number;
  byYear: boolean;
}

export interface FolderResult {
  ok: boolean;
  path?: string | null;
  created?: boolean;
  error?: string;
  /** На этом компьютере общая папка не выбрана. */
  needRoot?: boolean;
  /** Выбрана, но её нет (диск не подключён). */
  missingRoot?: boolean;
  canceled?: boolean;
  root?: string | null;
}

export interface OrderFolderBridge {
  info: () => Promise<{ ok: boolean; root?: string | null }>;
  pickRoot: () => Promise<FolderResult>;
  forgetRoot: () => Promise<FolderResult>;
  open: (req: FolderRequest) => Promise<FolderResult>;
  ensure: (req: FolderRequest) => Promise<FolderResult>;
}

export const TEMPLATES: { value: FolderTemplate; label: string }[] = [
  { value: "number", label: "Номер" },
  { value: "number_device", label: "Номер_Техника" },
  { value: "number_customer", label: "Номер_Клиент" },
  { value: "number_device_customer", label: "Номер_Техника_Фамилия клиента" },
];

/** Мостик программы; null — браузер, телефон или программа старше 0.1.44. */
export const folderBridge = (): OrderFolderBridge | null =>
  (typeof window !== "undefined" && window.finecrmDesktop?.orderFolder) || null;

export type NameSource = {
  number: string;
  acceptedAt?: string;
  device?: { kind?: string | null; brand?: string | null; model?: string | null } | null;
  customer?: { name?: string | null } | null;
};

/** Части имени после номера — по выбранному виду. Чистит их программа. */
export function folderParts(o: NameSource, template: FolderTemplate): string[] {
  const device = [o.device?.kind, o.device?.brand, o.device?.model].filter(Boolean).join(" ").trim();
  const customer = (o.customer?.name ?? "").trim();
  const surname = customer.split(/\s+/)[0] ?? "";
  switch (template) {
    case "number":
      return [];
    case "number_device":
      return [device];
    case "number_customer":
      return [customer];
    case "number_device_customer":
      return [device, surname];
  }
}

/** Как будет выглядеть имя — для примера в настройках (программа ещё уберёт запрещённые знаки). */
export const folderPreview = (o: NameSource, template: FolderTemplate) =>
  [o.number, ...folderParts(o, template)].filter((x) => x && x.trim()).join("_");

export function folderRequest(o: NameSource, s: FolderSettings): FolderRequest {
  const d = o.acceptedAt ? new Date(o.acceptedAt) : new Date();
  return { number: o.number, parts: folderParts(o, s.template), year: d.getFullYear(), byYear: s.byYear };
}

let cached: Promise<FolderSettings> | null = null;

export const orderFolderApi = {
  /** Правила мастерской; запоминаются до перезагрузки страницы или сохранения. */
  get: (fresh = false) => {
    if (!cached || fresh) cached = api.get<FolderSettings>("/settings/order-folder").catch((e) => ((cached = null), Promise.reject(e)));
    return cached;
  },
  save: async (s: FolderSettings) => {
    const saved = await api.put<FolderSettings>("/settings/order-folder", s);
    cached = Promise.resolve(saved);
    return saved;
  },
};

/**
 * Завести папку только что принятого заказа — если так настроено и на этом
 * компьютере выбрана общая папка. Тихо: приём не ждёт и не спотыкается о диск.
 */
export async function ensureOnIntake(order: NameSource): Promise<FolderResult | null> {
  const bridge = folderBridge();
  if (!bridge) return null;
  try {
    const s = await orderFolderApi.get();
    if (!s.createOnIntake) return null;
    const info = await bridge.info();
    if (!info.root) return null;
    return await bridge.ensure(folderRequest(order, s));
  } catch {
    return null;
  }
}
