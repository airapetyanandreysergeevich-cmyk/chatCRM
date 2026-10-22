import { Panel } from "../components/Panel";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { IconBell, IconShare } from "../components/icons";
import { Banner, Button, Card, PageHeader, Spinner } from "../components/ui";
import { ApiError, api } from "../lib/api";
import { InstallAppCard } from "../components/InstallApp";
import { useAuth } from "../lib/auth";
import { announceUnreadChanged } from "../lib/unread";
import { formatDateTime } from "../lib/format";
import {
  disablePush,
  enablePush,
  pushOwner,
  isIos,
  pushState,
  testPush,
  type PushState,
} from "../lib/push";

interface SettingsResponse {
  roles: Array<{ id: string; name: string }>;
  events: Array<{
    code: string;
    title: string;
    hint: string;
    hasDirectTarget: boolean;
    roles: string[];
    configured: boolean;
  }>;
}

/** Что показать человеку в каждом состоянии подписки — без жаргона про service worker. */
const STATE_TEXT: Record<PushState, { title: string; text: string }> = {
  on: {
    title: "Оповещения включены",
    text: "Это устройство получает push. На другом телефоне включите отдельно — подписка своя у каждого устройства.",
  },
  off: {
    title: "Оповещения выключены",
    text: "Включите, чтобы заказы приходили на телефон, а не ждали, пока вы откроете список.",
  },
  denied: {
    title: "Браузер запретил оповещения",
    text: "Разрешение отклонено раньше. Снимите запрет в настройках сайта в браузере — иначе спросить второй раз система не даст.",
  },
  "needs-install": {
    title: "Сначала добавьте FineCRM на экран «Домой»",
    text: "На iPhone оповещения приходят только установленному приложению. Во вкладке Safari их нет вовсе — это ограничение Apple, а не системы.",
  },
  insecure: {
    title: "Нужен защищённый адрес",
    text: "Оповещения работают только по https. Пока сайт открыт по http, браузер не даст их включить.",
  },
  "not-configured": {
    title: "Канал оповещений не настроен на сервере",
    text: "Не заданы ключи VAPID. Это делается один раз при установке.",
  },
  unsupported: {
    title: "Браузер не умеет оповещения",
    text: "Откройте FineCRM в Chrome, Firefox, Edge или Safari посвежее.",
  },
};

function DeviceCard() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [whom, setWhom] = useState<{ state: "mine" | "other" | "none"; name?: string | null } | null>(null);
  useEffect(() => {
    pushState().then(setState).catch(() => setState("unsupported"));
  }, []);
  useEffect(() => {
    if (state === "on") void pushOwner().then(setWhom);
    else setWhom(null);
  }, [state]);

  async function run(fn: () => Promise<PushState>) {
    setBusy(true);
    setError(null);
    try {
      setState(await fn());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не получилось");
    } finally {
      setBusy(false);
    }
  }

  if (!state) return <Card><Spinner label="Проверяем устройство" /></Card>;

  const info = STATE_TEXT[state];
  const canToggle = state === "on" || state === "off";

  return (
    <Panel id="notifications:Это устройство" title="Это устройство">
      <div className="mt-3 flex items-start gap-3">
        <span
          className={
            "mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-field " +
            (state === "on" ? "bg-brand-tint text-brand" : "bg-surface-raised text-ink-muted")
          }
        >
          <IconBell className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0">
          <p className="text-[15px] font-semibold">{info.title}</p>
          <p className="mt-1 text-[13.5px] leading-relaxed text-ink-muted">{info.text}</p>
        </div>
      </div>

      {state === "needs-install" && isIos() && (
        <div className="mt-4 rounded-card border border-line bg-surface-input p-3.5 text-[13.5px] leading-relaxed text-ink-soft">
          <p className="flex items-center gap-2 font-semibold text-ink">
            <IconShare className="h-4 w-4" /> Как установить
          </p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-ink-muted">
            <li>Нажмите «Поделиться» внизу Safari.</li>
            <li>Выберите «На экран „Домой“».</li>
            <li>Откройте FineCRM с домашнего экрана и вернитесь сюда.</li>
          </ol>
        </div>
      )}

      {state === "on" && whom?.state === "mine" && (
        <p className="mt-3 text-[13px] text-ink-muted" data-push-owner="mine">
          Оповещения на это устройство приходят вам. Войдёт другой сотрудник — они перейдут к нему, а при выходе снимаются.
        </p>
      )}
      {state === "on" && whom && whom.state !== "mine" && (
        <div className="mt-3" data-push-owner="other">
          <Banner tone="warning">
            {whom.state === "other"
              ? `Это устройство получает оповещения ${whom.name ? `для «${whom.name}»` : "другого сотрудника"}, а не ваши.`
              : "Сервер не знает это устройство — оповещения сюда не приходят."}{" "}
            Нажмите «Получать мне».
          </Banner>
          <div className="mt-2">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={async () => {
                await run(enablePush);
                setWhom(await pushOwner());
              }}
            >
              Получать мне
            </Button>
          </div>
        </div>
      )}

      {error && <div className="mt-3"><Banner tone="error">{error}</Banner></div>}
      {notice && <div className="mt-3"><Banner>{notice}</Banner></div>}

      {canToggle && (
        <div className="mt-4 flex flex-wrap gap-2">
          {state === "off" ? (
            <Button disabled={busy} onClick={() => void run(enablePush)}>
              Включить оповещения
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  setNotice(null);
                  try {
                    const r = await testPush();
                    // Раньше здесь было «отправили» на любой ответ сервера.
                    // Отказ сервиса push выглядел успехом, и человек ждал
                    // оповещение, которое не могло прийти.
                    if (r.sent > 0) {
                      setNotice("Отправили. Оповещение придёт через несколько секунд.");
                    } else if (r.reasons.length) {
                      setError(r.reasons.join(". "));
                    } else if (r.removed > 0) {
                      setError("Подписка этого устройства устарела. Выключите и включите оповещения заново.");
                    } else {
                      setError("Отправить не удалось, причина неизвестна — посмотрите журнал сервера.");
                    }
                  } catch (err) {
                    setError(err instanceof ApiError ? err.message : "Не получилось");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Проверить
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => void run(disablePush)}>
                Выключить
              </Button>
            </>
          )}
        </div>
      )}
    </Panel>
  );
}

interface Notice {
  id: string;
  title: string;
  body: string | null;
  url: string | null;
  /** Почему пришло именно вам (с 22.10.2026). */
  why?: string | null;
  readAt: string | null;
  createdAt: string;
}

/**
 * «Только по моим заказам» — своя настройка сотрудника (22.10.2026): события
 * про чужие заказы не приходят, даже если его роль отмечена в матрице.
 * Владельцу или совладельцу, который сам чинит, — ровно то, что нужно.
 */
function OwnOnlyCard() {
  const [state, setState] = useState<{ ownOnly: boolean; personal: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<{ ownOnly: boolean; personal: boolean }>("/notifications/prefs")
      .then(setState)
      .catch(() => setState(null));
  }, []);
  if (!state?.personal) return null;
  const set = (ownOnly: boolean) => {
    const before = state;
    setState({ ...state, ownOnly });
    setError(null);
    api.put("/notifications/prefs", { ownOnly }).catch((e) => {
      setState(before);
      setError(e instanceof ApiError ? e.message : "Не удалось сохранить");
    });
  };
  return (
    <Panel id="notifications:Мои оповещения" title="Мои оповещения" summary={state.ownOnly ? "Только по моим заказам" : "Обо всех заказах, что положены роли"}>
      <p className="mt-2 text-[13.5px] text-ink-muted">О каких заказах приходят оповещения лично вам.</p>
      <div className="mt-3 inline-flex flex-wrap rounded-field border border-line bg-surface-input p-1" role="radiogroup" aria-label="О каких заказах">
        {(
          [
            [false, "Обо всех, что положены моей роли"],
            [true, "Только по моим заказам"],
          ] as const
        ).map(([v, label]) => (
          <button
            key={String(v)}
            type="button"
            role="radio"
            aria-checked={state.ownOnly === v}
            data-own-only={String(v)}
            onClick={() => set(v)}
            className={
              "min-h-[40px] rounded-[9px] px-4 text-[14px] font-semibold transition-colors duration-150 " +
              (state.ownOnly === v ? "bg-surface-raised text-ink shadow-sm" : "text-ink-muted hover:text-ink")
            }
          >
            {label}
          </button>
        ))}
      </div>
      <p className="mt-2 text-[12.5px] text-ink-dim">
        «Только по моим» — оповещения о заказах, где вы мастер или участвуете в переписке. Остальное из «Кому какие события» вам
        приходить не будет.
      </p>
      {error && (
        <div className="mt-2">
          <Banner tone="error">{error}</Banner>
        </div>
      )}
    </Panel>
  );
}

/**
 * Лента оповещений. Открыли экран — всё помечается прочитанным: держать
 * счётчик, который нечем сбросить, хуже, чем не иметь его вовсе.
 */
function Feed() {
  const navigate = useNavigate();
  const [items, setItems] = useState<Notice[] | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .get<{ items: Notice[] }>("/notifications")
      .then((r) => {
        if (!alive) return;
        setItems(r.items);
        // Пометка «прочитано» — отдельно и без ожидания: если она не пройдёт,
        // счётчик просто не сбросится, а лента должна остаться на экране.
        if (r.items.some((i) => !i.readAt)) {
          void api
            .post("/notifications/read", {})
            .then(() => announceUnreadChanged())
            .catch(() => undefined);
        }
      })
      .catch(() => alive && setItems([]));
    return () => {
      alive = false;
    };
  }, []);

  if (!items) return null;

  return (
    <Panel id="notifications:Что происходило" title="Что происходило">
      {items.length === 0 ? (
        <p className="mt-3 text-[13.5px] text-ink-dim">Пока ничего не приходило.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {items.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                disabled={!n.url}
                onClick={() => n.url && navigate(n.url)}
                className="flex w-full items-start gap-3 py-3 text-left transition-colors duration-150 enabled:hover:opacity-80"
              >
                <span
                  className={
                    "mt-1.5 h-2 w-2 shrink-0 rounded-full " + (n.readAt ? "bg-transparent" : "bg-brand")
                  }
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14.5px] font-semibold">{n.title}</span>
                  {n.body && <span className="mt-0.5 block text-[13.5px] text-ink-muted">{n.body}</span>}
                  {n.why && (
                    <span className="mt-0.5 block text-[12px] text-ink-dim" data-notice-why>
                      Вам — потому что {n.why}
                    </span>
                  )}
                </span>
                <span className="shrink-0 text-[12px] text-ink-dim">{formatDateTime(n.createdAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export default function Notifications() {
  const { can, me } = useAuth();
  // Матрица принадлежит мастерской. Собственник платформы, пока он не вошёл
  // в конкретную мастерскую, настраивает только своё устройство: чужие
  // правила оповещений — не его дело.
  const inWorkshop = me?.kind === "tenant" || (me?.kind === "platform" && !!me.impersonating);
  const canManage = inWorkshop && can("settings.manage");

  const [data, setData] = useState<SettingsResponse | null>(null);
  const [matrix, setMatrix] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!canManage) return;
    try {
      const res = await api.get<SettingsResponse>("/notifications/settings");
      setData(res);
      setMatrix(Object.fromEntries(res.events.map((e) => [e.code, e.roles])));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить настройки");
    }
  }, [canManage]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = (code: string, roleId: string) =>
    setMatrix((m) => {
      const current = m[code] ?? [];
      return {
        ...m,
        [code]: current.includes(roleId)
          ? current.filter((r) => r !== roleId)
          : [...current, roleId],
      };
    });

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.put("/notifications/settings", { matrix });
      setNotice("Настройки сохранены");
      setTimeout(() => setNotice(null), 4000);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Мастерская"
        title="Оповещения"
        subtitle="Что приходит на телефон и кому именно."
      />

      <DeviceCard />
      <InstallAppCard />
      {inWorkshop && <OwnOnlyCard />}
      {inWorkshop && <Feed />}

      {canManage && (
        <>
          {error && <Banner tone="error">{error}</Banner>}
          {notice && <Banner>{notice}</Banner>}

          {!data ? (
            <Spinner label="Загружаем настройки" />
          ) : (
            <Panel id="notifications:Кому какие события" title="Кому какие события">
              <p className="mt-2 text-[13.5px] text-ink-muted">
                Отмеченные роли получают оповещение и в системе, и на телефон.
                Тот, кто сам совершил действие, себе оповещение не получает.
              </p>

              <div className="mt-5 space-y-5">
                {data.events.map((e) => (
                  <div key={e.code} className="border-t border-line pt-4 first:border-0 first:pt-0">
                    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                      <p className="text-[15px] font-semibold">{e.title}</p>
                      {!e.configured && (
                        <span className="rounded-pill bg-surface-raised px-2 py-0.5 text-[11.5px] font-semibold text-ink-dim">
                          по умолчанию
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[13px] text-ink-muted">{e.hint}</p>

                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {data.roles.map((r) => {
                        const on = (matrix[e.code] ?? []).includes(r.id);
                        return (
                          <button
                            key={r.id}
                            type="button"
                            onClick={() => toggle(e.code, r.id)}
                            className={
                              "rounded-pill px-3.5 py-1.5 text-[13px] font-semibold transition-colors duration-150 " +
                              (on
                                ? "bg-brand text-white"
                                : "border border-line bg-surface-raised text-ink-muted hover:text-ink")
                            }
                          >
                            {r.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              <div className="mt-5 border-t border-line pt-4">
                <Button disabled={saving} onClick={() => void save()}>
                  {saving ? "Сохраняем…" : "Сохранить"}
                </Button>
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
