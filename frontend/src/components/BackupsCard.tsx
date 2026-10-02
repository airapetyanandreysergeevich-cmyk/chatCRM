import { Panel } from "./Panel";
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import { backupsApi, type BackupPlace, type BackupStatus } from "../lib/backupsApi";
import { formatDateTime, plural } from "../lib/format";
import { Banner, Button } from "./ui";

/**
 * «Резервные копии» в «Настройки → Базы».
 *
 * Только у Основы: в облаке копии делает сервер, и раздела нет вовсе.
 *
 * Смотреть можно с любого компьютера — владелец редко сидит за Основой.
 * Менять места и делать копию — только в окне программы на самой Основе:
 * флешка и второй диск подключены к ней, и выбрать папку можно только там.
 * Остальным честно говорим, где это делается, а не прячем кнопки молча.
 */

type Bridge = NonNullable<Awaited<ReturnType<typeof backupsApi.desktop>>>;

function placeTitle(p: BackupPlace) {
  return p.primary ? "На этом компьютере, рядом с базой" : p.path;
}

function PlaceRow({
  place,
  bridge,
  busy,
  onOpen,
  onRemove,
}: {
  place: BackupPlace;
  bridge: Bridge | null;
  busy: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const bad = place.lastOk === false || !place.available;
  return (
    <li className="rounded-field border border-line bg-surface-raised px-3.5 py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="break-all text-[14px] font-semibold">{placeTitle(place)}</p>
          {place.primary && <p className="mt-0.5 break-all font-mono text-[12px] text-ink-dim">{place.path}</p>}
          <p className={"mt-1 text-[12.5px] " + (bad ? "font-semibold text-state-off" : "text-ink-muted")}>
            {!place.available
              ? "Недоступно — диск или флешка не подключены"
              : place.lastOk === false
                ? `Последняя копия не записалась${place.lastError ? `: ${place.lastError}` : ""}`
                : place.lastAt
                  ? `Последняя копия: ${formatDateTime(place.lastAt)} · ${plural(place.copies, "копия", "копии", "копий")}`
                  : "Копий сюда ещё не было"}
          </p>
          {!place.primary && place.sameDisk && (
            <p className="mt-1 text-[12.5px] text-state-waiting">
              Тот же диск, что и у базы: при поломке диска эта копия пропадёт вместе с ней.
            </p>
          )}
        </div>
        {bridge && (
          <div className="flex shrink-0 gap-2">
            <Button variant="secondary" disabled={busy || !place.available} onClick={onOpen}>
              Открыть
            </Button>
            {!place.primary && (
              <Button variant="ghost" disabled={busy} onClick={onRemove}>
                Убрать
              </Button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

export function BackupsCard() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [bridge, setBridge] = useState<Bridge | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await backupsApi.status());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось узнать о резервных копиях");
    }
  }, []);

  useEffect(() => {
    void load();
    void backupsApi.desktop().then(setBridge);
  }, [load]);

  // Из меню значка у часов сюда приходят по ссылке #backups.
  useEffect(() => {
    if (status?.available && window.location.hash === "#backups") {
      document.getElementById("backups")?.scrollIntoView({ block: "start" });
    }
  }, [status?.available]);

  if (!status || !status.available) return null;

  type Result = { ok: boolean; canceled?: boolean; error?: string; placesFailed?: number; sameDisk?: boolean };
  const act = async (fn: () => Promise<Result>, done?: (r: Result) => string | null) => {
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const r = await fn();
      if (r.canceled) return;
      if (!r.ok) setError(r.error ?? "Не получилось");
      else if (done) setNotice(done(r));
      await load();
    } finally {
      setBusy(false);
    }
  };

  const places = status.places ?? [];
  const last = status.last;

  return (
    <Panel id="data:Резервные копии" title="Резервные копии" defaultOpen={window.location.hash === "#backups"}>
      <div id="backups" className="scroll-mt-4" />
      <p className="mt-2 text-[13px] leading-relaxed text-ink-dim">
        Копия базы и всех фотографий делается раз в сутки, перед обновлением программы
        {status.onExit ? " и при её закрытии" : ""}. В каждом месте хранится{" "}
        {plural(status.keep ?? 7, "последняя копия", "последние копии", "последних копий")}. Если компьютер
        сломается, поставьте программу заново и на первом экране выберите «Восстановить из резервной копии».
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className={"text-[14px] " + (last?.ok === false ? "font-semibold text-state-off" : "")}>
          {last?.at
            ? last.ok
              ? `Последняя копия: ${formatDateTime(last.at)}`
              : `Копия не сделана ${formatDateTime(last.at)}${last.error ? `: ${last.error}` : ""}`
            : "Копий ещё не было"}
        </p>
        {bridge && (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void act(
                () => bridge.runNow(),
                (r) =>
                  r.placesFailed ? `Копия сделана, но в ${plural(r.placesFailed, "месте", "местах", "местах")} не записалась` : "Копия сделана"
              )
            }
          >
            {busy ? "Делаю копию…" : "Сделать копию сейчас"}
          </Button>
        )}
      </div>

      {status.sameDisk && (
        <div className="mt-3">
          <Banner tone="warning">
            Все копии лежат на том же диске, что и база. Если диск сломается, пропадут и база, и копии. Добавьте
            место на флешке, втором диске или в сетевой папке.
          </Banner>
        </div>
      )}
      {notice && (
        <div className="mt-3">
          <Banner>{notice}</Banner>
        </div>
      )}
      {error && (
        <div className="mt-3">
          <Banner tone="error">{error}</Banner>
        </div>
      )}

      <p className="mt-5 text-[11px] font-bold uppercase tracking-[0.12em] text-ink-dim">Куда сохраняются</p>
      <ul className="mt-2 space-y-2">
        {places.map((p) => (
          <PlaceRow
            key={p.path}
            place={p}
            bridge={bridge}
            busy={busy}
            onOpen={() => void act(() => bridge!.open(p.path))}
            onRemove={() =>
              void act(
                () => bridge!.removePlace(p.path),
                () => "Место убрано из списка. Копии, которые там уже лежат, остались на месте."
              )
            }
          />
        ))}
      </ul>

      {bridge ? (
        <div className="mt-3">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void act(
                () => bridge.addPlace(),
                (r) =>
                  r.sameDisk
                    ? "Место добавлено. Оно на том же диске, что и база, — лучше добавить ещё флешку или второй диск."
                    : "Место добавлено. Первая копия туда ляжет при следующей копии — или нажмите «Сделать копию сейчас»."
              )
            }
          >
            Добавить место…
          </Button>
        </div>
      ) : (
        <p className="mt-3 text-[12.5px] text-ink-dim">
          Добавить место или сделать копию можно в программе на компьютере с Основой: там же, в «Настройки → Базы»,
          или в меню значка возле часов.
        </p>
      )}
    </Panel>
  );
}
