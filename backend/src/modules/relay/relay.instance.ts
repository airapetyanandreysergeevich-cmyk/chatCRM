import type { Server as HttpServer } from "http";
import { env } from "../../lib/env";
import { createRelayAgent, type AgentState } from "./relay.agent";
import { createRelayHub } from "./relay.hub";
import { authenticateBox, markSeen } from "./boxes.service";
import { readRemoteAccess } from "./remoteAccess";

/**
 * Два конца одного провода, включённые по настройкам.
 *
 * Один и тот же сервер бывает и облаком, и Основой: в облаке он принимает
 * соединения от мастерских, в мастерской — сам соединяется с облаком. Что
 * именно включить, решают переменные окружения, а не отдельные сборки.
 */

let hub: ReturnType<typeof createRelayHub> | null = null;

export const relayHub = () => hub;

/** Облачная сторона: принимаем Основы и раздаём их по /b/<код>/. */
export function startRelayHub(server: HttpServer) {
  if (!env.relayEnabled) return null;
  hub = createRelayHub({
    authenticate: authenticateBox,
    timeoutMs: 600_000,
    log: (line, extra) => console.log(`[туннель] ${line}`, extra ?? ""),
    onSeen: (code) => void markSeen(code),
  });
  hub.attach(server, env.relayPath);
  console.log(`[туннель] принимаем Основы на ${env.relayPath}`);
  return hub;
}

/**
 * Сторона мастерской.
 *
 * Ключ владелец вводит в настройках прямо в программе, и лежит он в базе
 * мастерской — не в файле с переменными. Это не мелочь: иначе включить доступ
 * можно было бы только из-под администратора компьютера, отредактировав файл
 * и перезапустив сервер, а выключить в спешке (сотрудник уволился, ключ
 * утёк) — тем более.
 *
 * Переменные окружения остаются запасным путём: с ними Основа поднимает
 * туннель и на голом сервере, где никакой мастер настроек не открыть.
 */
let agent: ReturnType<typeof createRelayAgent> | null = null;
let current = { url: "", key: "" };
let state: { state: AgentState; detail?: string } = { state: "off" };

export const relayAgentState = () => ({ ...state, enabled: !!agent, url: current.url });

/** Включить, выключить или переключить на другой ключ — на ходу. */
export function applyRemoteAccess(next: { url: string; key: string } | null) {
  const same = next && next.url === current.url && next.key === current.key;
  if (same && agent) return relayAgentState();

  agent?.stop();
  agent = null;
  state = { state: "off" };
  current = { url: next?.url ?? "", key: next?.key ?? "" };
  if (!next || !next.url || !next.key) return relayAgentState();

  agent = createRelayAgent({
    url: next.url,
    key: next.key,
    // Свой же сервер: запрос из интернета выполняется так же, как из
    // соседнего кабинета.
    target: `http://127.0.0.1:${env.port}`,
    log: (line) => console.log(`[доступ из интернета] ${line}`),
    onState: (s, detail) => {
      state = { state: s, detail };
      console.log(`[доступ из интернета] ${s}${detail ? `: ${detail}` : ""}`);
    },
  });
  agent.start();
  return relayAgentState();
}

/** Запуск вместе с сервером: ключ из настроек мастерской, иначе из переменных. */
export async function startRelayAgent() {
  const saved = await readRemoteAccess().catch(() => null);
  const url = saved?.url || env.relayUrl;
  const key = saved?.key || env.relayKey;
  if (!url || !key || saved?.enabled === false) return relayAgentState();
  return applyRemoteAccess({ url, key });
}
