/**
 * Единая точка для внешних уведомлений платформы.
 *
 * Сейчас событие только пишется в лог — заявки видно в панели по счётчику.
 * Когда появится своё приложение, бот или вебхук, реализация добавляется здесь одна,
 * а вызовы по коду уже расставлены и трогать их не придётся.
 */
export type PlatformEvent = {
  type: "APPLICATION_CREATED";
  applicationId: string;
  workshopName: string;
  ownerFullName: string;
  ownerPhone: string;
  city?: string | null;
};

export async function notifyPlatform(event: PlatformEvent): Promise<void> {
  // Уведомление не должно ронять то действие, ради которого его послали.
  try {
    console.log(`[platform] ${event.type} ${JSON.stringify(event)}`);
  } catch {
    /* пусто */
  }
}
