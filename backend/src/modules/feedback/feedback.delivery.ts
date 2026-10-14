import { withPlatform } from "../../lib/db";
import { env, isBox } from "../../lib/env";
import { sendPush } from "../../lib/push";
import { cloudBase, defaultRelayUrl, readRemoteAccess } from "../relay/remoteAccess";

/**
 * Обращения мастерских доходят до владельца платформы.
 *
 * В облаке обращение сразу лежит в общей базе — его видно в панели
 * «Замечания». Основа же пишет в свою базу на компьютере мастерской, и до
 * 14.10.2026 обращения оттуда не уходили никуда: мастерская видела
 * «Отправлено», а владелец платформы — пустой список.
 *
 * Теперь Основа после записи отправляет обращение в облако и помечает
 * отправленным. Нет связи — повторяет сама, пока не дойдёт: сразу после
 * записи, через минуту после запуска, каждые десять минут и когда владелец
 * открывает страницу обратной связи.
 *
 * С доступом из интернета Основа представляется своим ключом — облако знает,
 * какая это мастерская. Без него — просто называет себя: название мастерской,
 * почта владельца, версия программы. Обращение не секрет, и требовать
 * подключения ради письма разработчику — значит снова его потерять.
 */

const EVERY_MS = 10 * 60_000;
const BATCH = 20;
const TIMEOUT_MS = 10_000;

export type FeedbackPost = {
  localId: string;
  kind: "REMARK" | "WISH" | "BUG";
  text: string;
  writtenAt: string;
  workshop: string;
  email?: string;
  version?: string;
};

/** Куда и с чем стучаться. Без ключа — общий адрес облака. */
async function target(): Promise<{ url: string; key: string | null }> {
  const saved = await readRemoteAccess().catch(() => null);
  const withKey = saved && saved.enabled !== false && saved.key ? saved : null;
  const base = cloudBase(withKey?.url ?? defaultRelayUrl()) || "https://www.finecrm.ru";
  return { url: `${base}/api/box/feedback`, key: withKey?.key ?? null };
}

export type Sender = (url: string, key: string | null, body: FeedbackPost) => Promise<{ ok: boolean; error?: string }>;

const httpSender: Sender = async (url, key, body) => {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { "x-box-key": key } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    if (res.status === 429) return { ok: false, error: "облако просит подождать — отправим позже" };
    return { ok: false, error: `облако ответило ошибкой ${res.status}` };
  } catch (err) {
    const name = (err as Error)?.name;
    return {
      ok: false,
      error: name === "TimeoutError" || name === "AbortError" ? "облако не ответило — отправим позже" : "нет связи с интернетом — отправим, когда появится",
    };
  }
};

let running: Promise<{ sent: number; failed: number }> | null = null;

/**
 * Отправить всё, что ждёт. Одновременно — один проход: страница и таймер
 * не должны отправить одно и то же дважды (облако бы и так не задвоило, но
 * зачем лишние запросы).
 */
export function deliverPending(sender: Sender = httpSender): Promise<{ sent: number; failed: number }> {
  if (running) return running;
  running = (async () => {
    let sent = 0;
    let failed = 0;
    const items = await withPlatform((tx) =>
      tx.feedback.findMany({
        where: { sentAt: null },
        orderBy: { createdAt: "asc" },
        take: BATCH,
        include: {
          tenant: { select: { name: true } },
          author: { select: { email: true } },
        },
      })
    );
    if (!items.length) return { sent, failed };
    const to = await target();
    for (const it of items) {
      const r = await sender(to.url, to.key, {
        localId: it.id,
        kind: it.kind,
        text: it.text,
        writtenAt: it.createdAt.toISOString(),
        workshop: (it.tenant?.name || "Мастерская без названия").slice(0, 120),
        email: it.author?.email?.slice(0, 200) || undefined,
        version: env.appVersion || undefined,
      });
      await withPlatform((tx) =>
        tx.feedback.update({
          where: { id: it.id },
          data: r.ok ? { sentAt: new Date(), sendError: null } : { sendError: (r.error ?? "не отправлено").slice(0, 200) },
        })
      );
      if (r.ok) sent += 1;
      else {
        failed += 1;
        // Связи нет — остальные тоже не уйдут; попробуем всё разом позже.
        break;
      }
    }
    return { sent, failed };
  })().finally(() => {
    running = null;
  });
  return running;
}

/** Только у Основы. */
export function startFeedbackDelivery(): void {
  if (!isBox) return;
  const run = () =>
    void deliverPending()
      .then((r) => {
        if (r.sent) console.log(`[обратная связь] отправлено в облако: ${r.sent}`);
      })
      .catch((err) => console.warn(`[обратная связь] не отправлено: ${(err as Error).message}`));
  setTimeout(run, 60_000).unref();
  setInterval(run, EVERY_MS).unref();
}

let lastNudge = 0;
/** Владелец открыл страницу — подтолкнуть отправку, но не чаще раза в минуту. */
export function nudgeDelivery(): void {
  if (!isBox || Date.now() - lastNudge < 60_000) return;
  lastNudge = Date.now();
  void deliverPending().catch(() => undefined);
}

// ------------------------------------------------------------ облако: оповестить владельца платформы

const KIND_WORD = { REMARK: "Замечание", WISH: "Пожелание", BUG: "Баг" } as const;

/**
 * Новое обращение — оповещение на телефоны владельцев платформы, которые
 * включили оповещения на своём устройстве (Оповещения → «Это устройство»).
 * Ошибка оповещения не мешает сохранить обращение.
 */
export async function notifyPlatform(id: string, kind: keyof typeof KIND_WORD, workshop: string, text: string): Promise<void> {
  try {
    const targets = await withPlatform((tx) =>
      tx.pushSubscription.findMany({
        where: { platformUserId: { not: null } },
        select: { id: true, endpoint: true, p256dh: true, auth: true },
      })
    );
    if (!targets.length) return;
    const short = text.replace(/\s+/g, " ").trim();
    const result = await sendPush(targets, {
      title: `${KIND_WORD[kind]} · ${workshop}`.slice(0, 120),
      body: short.length > 140 ? `${short.slice(0, 139)}…` : short,
      url: "/platform/feedback",
      tag: `feedback:${id}`,
    });
    if (result.dead.length) {
      await withPlatform((tx) => tx.pushSubscription.deleteMany({ where: { id: { in: result.dead } } }));
    }
  } catch (err) {
    console.warn(`[обратная связь] оповещение не ушло: ${(err as Error).message}`);
  }
}
