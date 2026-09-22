import { prisma } from "../../lib/db";
import { env } from "../../lib/env";

/**
 * Настройка «Доступ из интернета» у коробочной мастерской.
 *
 * Хранится в настройках мастерской, рядом с оформлением и оповещениями. У
 * коробочной версии мастерская в базе одна, поэтому читаем первую попавшуюся:
 * спрашивать, «какая из», здесь не у кого.
 *
 * Ключ — как пароль: наружу, в интерфейс, он не отдаётся никогда, только
 * последние четыре знака. Заменить его можно, подсмотреть — нет.
 */

/**
 * Через type, а не interface: значение уходит в Json-колонку Prisma, а туда
 * принимаются только типы с неявной индексной сигнатурой (см. «Грабли»).
 */
export type RemoteAccess = {
  enabled: boolean;
  url: string;
  key: string;
};

const KEY = "remoteAccess";

/** Адрес узла связи по умолчанию — наш же сервер обновлений. */
export const defaultRelayUrl = () => env.relayUrl || "wss://www.finecrm.ru/relay/agent";

export async function readRemoteAccess(): Promise<RemoteAccess | null> {
  const tenant = await prisma.tenant.findFirst({ select: { id: true, settings: true } });
  const raw = ((tenant?.settings as Record<string, unknown> | null) ?? {})[KEY] as
    | Partial<RemoteAccess>
    | undefined;
  if (!raw) return null;
  return {
    enabled: raw.enabled !== false,
    url: typeof raw.url === "string" && raw.url ? raw.url : defaultRelayUrl(),
    key: typeof raw.key === "string" ? raw.key : "",
  };
}

export async function saveRemoteAccess(next: RemoteAccess): Promise<void> {
  const tenant = await prisma.tenant.findFirst({ select: { id: true, settings: true } });
  if (!tenant) return;
  const settings = { ...((tenant.settings as object) ?? {}), [KEY]: next };
  await prisma.tenant.update({ where: { id: tenant.id }, data: { settings } });
}
