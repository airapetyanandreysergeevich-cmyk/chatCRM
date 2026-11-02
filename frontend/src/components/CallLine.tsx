import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../lib/api";
import { DIRECTION_LABEL, callsApi, durationText, type CallItem } from "../lib/calls";
import { fileUrl } from "../lib/basePath";
import { formatDateShort } from "../lib/format";
import { IconCallIn, IconCallMissed, IconCallOut, IconDownload, IconMore, IconPause, IconPlay } from "./icons";
import { Modal } from "./Modal";
import { Button } from "./ui";

/**
 * Звонок клиента строкой — в истории ремонта и в карточке клиента
 * (Андрей, 28.10.2026): «📞 Входящий · 14:32 · 3:42 [▶ ━━━━━]».
 *
 * Плеер свой, а не стандартный <audio controls>: тот в каждом браузере свой и
 * в узкой колонке истории разваливается. Скорость 1× / 1,5× / 2× — разговоры
 * слушают, чтобы найти одну фразу, а не ради удовольствия.
 */

const time = (iso: string) => {
  const d = new Date(iso);
  const today = d.toDateString() === new Date().toDateString();
  const hm = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return today ? hm : `${formatDateShort(d)}, ${hm}`;
};

export function CallLine({
  call,
  canMove,
  showOrder = false,
  onMoved,
}: {
  call: CallItem;
  canMove?: boolean;
  /** В карточке клиента — к какому заказу звонок. */
  showOrder?: boolean;
  onMoved?: () => void;
}) {
  const [moving, setMoving] = useState(false);
  const missed = call.direction === "MISSED" || call.direction === "REJECTED";
  const Icon = missed ? IconCallMissed : call.direction === "OUT" ? IconCallOut : IconCallIn;
  return (
    <div className="flex items-start gap-2 px-1 text-[13px] leading-snug" data-call={call.direction} data-call-id={call.id}>
      <span
        className={
          "mt-[1px] flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full [&>svg]:h-3 [&>svg]:w-3 " +
          (missed ? "bg-state-off/15 text-state-off" : "bg-brand/15 text-brand-ink")
        }
      >
        <Icon />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-ink-soft">
          <b className={missed ? "text-state-off" : "text-ink"}>{DIRECTION_LABEL[call.direction]} звонок</b>
          {!missed && call.durationSec > 0 && <span className="font-mono text-[12.5px]"> · {durationText(call.durationSec)}</span>}
          <span className="text-[12px] text-ink-dim">
            {" "}
            · {call.number}
            {showOrder && (call.order ? <> · заказ <Link to={`/orders/${call.order.id}`} className="font-mono text-brand-ink hover:underline">{call.order.number}</Link></> : " · без заказа")}
            {" "}· {time(call.startedAt)}
          </span>
          {canMove && (
            <button
              type="button"
              onClick={() => setMoving(true)}
              aria-label="Перенести звонок"
              title="Перенести в другой заказ"
              className="ml-1 inline-flex h-5 w-5 translate-y-[3px] items-center justify-center rounded-[6px] text-ink-dim hover:bg-surface-raised hover:text-ink [&>svg]:h-3.5 [&>svg]:w-3.5"
              data-call-move
            >
              <IconMore />
            </button>
          )}
        </p>
        {call.audio ? (
          <Player src={call.audio} duration={call.durationSec} />
        ) : call.hasAudio ? (
          <p className="mt-0.5 text-[12px] text-ink-dim">Есть запись разговора — слушают сотрудники с правом «Слушает записи звонков».</p>
        ) : null}
      </div>
      {moving && (
        <MoveCall
          call={call}
          onClose={() => setMoving(false)}
          onMoved={() => {
            setMoving(false);
            onMoved?.();
          }}
        />
      )}
    </div>
  );
}

const SPEEDS = [1, 1.5, 2];

function Player({ src: given, duration }: { src: string; duration: number }) {
  // Ссылка от сервера — «/api/files/…»: в Основу из интернета заходят через
  // /b/<код>/, и без приставки телефон шёл за записью в облако, где её нет
  // (Андрей, 02.11.2026: «на телефоне не проигрывается запись»).
  const fresh = fileUrl(given);
  // История перечитывается каждые несколько секунд, и ссылка на запись каждый
  // раз подписывается заново. Держим взятую: новая оборвала бы разговор на
  // середине. Подпись живёт час — старше 50 минут или отказала, берём свежую
  // (вкладки на телефоне висят открытыми сутками).
  const [src, setSrc] = useState(fresh);
  const takenAt = useRef(Date.now());
  const latest = useRef(fresh);
  latest.current = fresh;
  const retried = useRef(false);
  const wantPlay = useRef(false);
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [total, setTotal] = useState(duration);
  const [speed, setSpeed] = useState(1);
  const [failed, setFailed] = useState(false);
  // AMR и 3GP звонилок Honor/Huawei и части Xiaomi не играет ни один браузер — только скачать.
  const ext = /\.([a-z0-9]{2,4})(?:\?|#|$)/i.exec(fresh)?.[1]?.toLowerCase() ?? "";
  const unplayable = ext === "amr" || ext === "3gp";

  /** Взять свежую ссылку и продолжить с того же места. */
  const refresh = () => {
    const a = audio.current;
    if (!a || latest.current === src) return false;
    const at = a.currentTime;
    takenAt.current = Date.now();
    setSrc(latest.current);
    // После смены src браузер перечитывает запись — ставим место, когда прочтёт.
    const resume = () => {
      if (at > 0) a.currentTime = at;
      a.playbackRate = speed;
      if (wantPlay.current) void a.play().then(() => setPlaying(true), () => setFailed(true));
      a.removeEventListener("loadedmetadata", resume);
    };
    a.addEventListener("loadedmetadata", resume);
    return true;
  };

  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    const onTime = () => setPos(a.currentTime);
    const onMeta = () => Number.isFinite(a.duration) && a.duration > 0 && setTotal(a.duration);
    const onEnd = () => ((wantPlay.current = false), setPlaying(false));
    const onErr = () => {
      // Протухла подпись — один раз пробуем свежую ссылку, потом сдаёмся.
      if (!retried.current) {
        retried.current = true;
        if (refresh()) return;
      }
      setFailed(true);
      setPlaying(false);
    };
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("ended", onEnd);
    a.addEventListener("error", onErr);
    return () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("ended", onEnd);
      a.removeEventListener("error", onErr);
    };
  }, [src]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (playing) {
      wantPlay.current = false;
      a.pause();
      setPlaying(false);
    } else {
      wantPlay.current = true;
      setFailed(false);
      // Играет одна запись: остальные плееры на странице замолкают.
      document.querySelectorAll<HTMLAudioElement>("audio[data-call-audio]").forEach((x) => x !== a && x.pause());
      if (Date.now() - takenAt.current > 50 * 60_000 && refresh()) return;
      void a.play().then(
        () => setPlaying(true),
        () => {
          if (!retried.current && (retried.current = true) && refresh()) return;
          setFailed(true);
        }
      );
    }
  };

  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    const onPause = () => setPlaying(false);
    a.addEventListener("pause", onPause);
    return () => a.removeEventListener("pause", onPause);
  }, []);

  if (unplayable) {
    return (
      <div className="mt-1.5 flex max-w-[460px] flex-wrap items-center gap-2 rounded-pill border border-line bg-surface-raised py-1.5 pl-3 pr-2 text-[12px] text-ink-muted" data-call-player data-call-unplayable>
        <span className="min-w-0 flex-1">Запись в формате {ext.toUpperCase()} — браузер её не играет. Скачайте и откройте плеером.</span>
        <a href={src} download className="flex items-center gap-1 font-semibold text-brand-ink hover:underline [&>svg]:h-3.5 [&>svg]:w-3.5">
          <IconDownload /> Скачать
        </a>
      </div>
    );
  }

  const share = total > 0 ? Math.min(1, pos / total) : 0;
  return (
    <div className="mt-1.5 flex max-w-[460px] items-center gap-2 rounded-pill border border-line bg-surface-raised py-1 pl-1 pr-2" data-call-player>
      <audio ref={audio} src={src} preload="metadata" data-call-audio />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "Пауза" : "Слушать запись"}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-white [&>svg]:h-3.5 [&>svg]:w-3.5"
        data-call-play
      >
        {playing ? <IconPause /> : <IconPlay />}
      </button>
      <input
        type="range"
        min={0}
        max={Math.max(1, total)}
        step={0.1}
        value={pos}
        aria-label="Перемотка"
        onChange={(e) => {
          const a = audio.current;
          const v = Number(e.target.value);
          if (a) a.currentTime = v;
          setPos(v);
        }}
        className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-line accent-[rgb(var(--brand))]"
        style={{ background: `linear-gradient(to right, rgb(var(--brand)) ${share * 100}%, rgb(var(--line)) ${share * 100}%)` }}
      />
      <span className="shrink-0 font-mono text-[11.5px] text-ink-muted">
        {durationText(pos)} / {durationText(total)}
      </span>
      <button
        type="button"
        onClick={() => {
          const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
          setSpeed(next);
          if (audio.current) audio.current.playbackRate = next;
        }}
        className="shrink-0 rounded-[6px] px-1 font-mono text-[11.5px] font-bold text-ink-muted hover:text-ink"
        title="Скорость"
        data-call-speed
      >
        {String(speed).replace(".", ",")}×
      </button>
      <a href={src} download className="shrink-0 text-ink-dim hover:text-ink [&>svg]:h-3.5 [&>svg]:w-3.5" aria-label="Скачать запись" title="Скачать запись">
        <IconDownload />
      </a>
      {failed && <span className="shrink-0 text-[11.5px] text-state-off">не играет</span>}
    </div>
  );
}

function MoveCall({ call, onClose, onMoved }: { call: CallItem; onClose: () => void; onMoved: () => void }) {
  const [items, setItems] = useState<Awaited<ReturnType<typeof callsApi.targets>>["items"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    callsApi
      .targets(call.id)
      .then((r) => setItems(r.items))
      .catch((e) => setError(e instanceof ApiError ? e.message : "Не удалось загрузить заказы"));
  }, [call.id]);
  const go = (orderId: string | null) => {
    setBusy(true);
    callsApi
      .move(call.id, orderId)
      .then(onMoved)
      .catch((e) => {
        setError(e instanceof ApiError ? e.message : "Не получилось");
        setBusy(false);
      });
  };
  return (
    <Modal title="Перенести звонок" onClose={onClose}>
      <div className="space-y-3" data-call-move-dialog>
        <p className="text-[13.5px] text-ink-soft">
          {DIRECTION_LABEL[call.direction]} звонок {time(call.startedAt)}. Куда его положить:
        </p>
        {error && <p className="text-[13px] text-state-off">{error}</p>}
        {!items ? (
          <p className="text-[13px] text-ink-dim">Загружаем…</p>
        ) : (
          <div className="max-h-[50vh] space-y-1.5 overflow-y-auto">
            {items.map((o) => {
              const here = call.order?.id === o.id;
              const dev = [o.device?.kind, o.device?.brand, o.device?.model].filter(Boolean).join(" ");
              return (
                <button
                  key={o.id}
                  type="button"
                  disabled={busy || here}
                  onClick={() => go(o.id)}
                  className={"flex w-full items-center gap-3 rounded-card border px-3 py-2 text-left text-[13.5px] " + (here ? "border-brand bg-brand-tint" : "border-line hover:border-line-strong")}
                >
                  <span className="font-mono font-bold">{o.number}</span>
                  <span className="min-w-0 flex-1 truncate text-ink-soft">{dev || "—"}</span>
                  <span className="shrink-0 text-[12px] text-ink-dim">{o.issuedAt ? `выдан ${formatDateShort(o.issuedAt)}` : "в работе"}</span>
                  {here && <span className="shrink-0 text-[12px] font-semibold text-brand-ink">здесь</span>}
                </button>
              );
            })}
          </div>
        )}
        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button type="button" variant="secondary" disabled={busy || !call.order} onClick={() => go(null)}>
            Только в карточке клиента
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Отменить
          </Button>
        </div>
      </div>
    </Modal>
  );
}
