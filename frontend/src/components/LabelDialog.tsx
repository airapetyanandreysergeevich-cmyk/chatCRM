import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { labelData, labelItems, useLabelLogo } from "../lib/labels";
import type { Order } from "../lib/orders";
import { printAndWait, printingApi, targetLabel, type PrintingOverview, type PrintJob } from "../lib/printing";
import { Label } from "./Label";
import { Modal } from "./Modal";
import { Banner, Button, Checkbox, Spinner } from "./ui";

/**
 * Наклейки заказа: на какие вещи, и — на принтер этикеток или обычным окном.
 *
 * Вещи — сама техника и то из комплекта, что отмечено в настройке наклейки
 * («Блок питания», «Сумка или чехол»). Отмечены все; лишнее снимают.
 * После приёма в режиме «Печатать сразу» уходят все, без вопросов.
 */
export function LabelDialog({
  order,
  afterIntake = false,
  auto = false,
  onClose,
}: {
  order: Order;
  afterIntake?: boolean;
  auto?: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { me } = useAuth();
  const [data, setData] = useState<PrintingOverview | null>(null);
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [job, setJob] = useState<PrintJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    printingApi
      .overview()
      .then((d) => {
        setData(d);
        setPicked(new Set(labelItems(order, d.labels.settings).map((i) => i.key)));
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось узнать принтер этикеток"));
  }, [order]);

  const items = data ? labelItems(order, data.labels.settings) : [];
  const chosen = items.filter((i) => picked?.has(i.key));
  const t = data?.labels.effective ?? null;
  const usable = !!t && t.online && !t.stationGone && !t.printerGone;
  const workshop = me?.kind === "tenant" ? (me.tenant?.name ?? "") : "";

  async function send() {
    if (!chosen.length) return;
    setBusy(true);
    setError(null);
    setJob(null);
    try {
      const done = await printAndWait({ doc: "label", orderId: order.id, items: chosen.map((i) => i.key) }, setJob);
      setJob(done);
      if (done.status === "DONE") setTimeout(onClose, 1500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось отправить на принтер этикеток");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!auto || !data || started.current) return;
    started.current = true;
    if (usable) void send();
  }, [auto, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const openPage = () => navigate(`/orders/${order.id}/label?${chosen.map((i) => `i=${encodeURIComponent(i.key)}`).join("&")}`);
  const count = chosen.length;
  const word = count === 1 ? "наклейку" : count >= 2 && count <= 4 ? "наклейки" : "наклеек";
  const logo = useLabelLogo(!!data?.labels.settings.fields.logo);
  const preview = data && chosen[0] ? { ...labelData(order, chosen[0], 1, chosen.length, workshop), logo: logo.logo } : null;
  const S = data?.labels.settings;
  const scale = S ? Math.min(1.4, 300 / ((S.width * 96) / 25.4)) : 1;

  return (
    <Modal title={`Наклейки · ${order.number}`} onClose={onClose}>
      <div className="space-y-4">
        {!data && !error ? (
          <Spinner label="Ищем принтер этикеток" />
        ) : data && S ? (
          <>
            {afterIntake && !job && !busy && <p className="text-[15px]">Распечатать наклейки на технику?</p>}
            <div className="grid gap-2">
              {items.map((it, i) => (
                <Checkbox
                  key={it.key}
                  checked={!!picked?.has(it.key)}
                  onChange={(v) =>
                    setPicked((p) => {
                      const n = new Set(p);
                      if (v) n.add(it.key);
                      else n.delete(it.key);
                      return n;
                    })
                  }
                  label={
                    <span>
                      {it.title}
                      {i === 0 && <span className="text-ink-dim"> — сама техника</span>}
                    </span>
                  }
                />
              ))}
            </div>
            {preview && (
              <div className="flex justify-center rounded-card bg-[#6B7280] p-4">
                <div style={{ width: ((S.width * 96) / 25.4) * scale, height: ((S.height * 96) / 25.4) * scale }}>
                  <div style={{ width: `${S.width}mm`, transform: `scale(${scale})`, transformOrigin: "top left" }}>
                    <Label settings={S} data={preview} />
                  </div>
                </div>
              </div>
            )}
            {t ? (
              <p className="text-[13.5px] text-ink-muted">
                Принтер этикеток: <span className="font-semibold text-ink">{targetLabel(t)}</span>
                {t.source === "mine" ? " · ваш" : ""}
              </p>
            ) : (
              <Banner tone="warning">
                Принтер этикеток не назначен — наклейки откроются обычным окном печати.{" "}
                <Link to="/settings/peripherals" className="font-semibold underline">
                  Назначить
                </Link>
              </Banner>
            )}
            {t && !usable && !job && (
              <Banner tone="warning">
                {t.stationGone
                  ? "Компьютер с принтером этикеток убран из списка — назначьте принтер заново в «Настройки → Периферия»."
                  : t.printerGone
                    ? `Windows на компьютере «${t.stationName}» больше не видит этот принтер.`
                    : `Компьютер «${t.stationName}» сейчас не на связи: он выключен или программа FineCRM на нём закрыта.`}
              </Banner>
            )}
          </>
        ) : null}

        {error && <Banner tone="error">{error}</Banner>}
        {job && (
          <Banner tone={job.status === "FAILED" ? "error" : "info"}>
            {job.status === "DONE"
              ? `Напечатано на «${job.printer}».`
              : job.status === "FAILED"
                ? `Не напечатано: ${job.error ?? "причина неизвестна"}`
                : job.status === "SENT"
                  ? `Печатаем на «${job.printer}»…`
                  : `Отправлено на «${job.printer}», ждём компьютер «${job.station ?? ""}»…`}
          </Banner>
        )}

        {data && (
          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            {usable && job?.status !== "DONE" && (
              <Button type="button" disabled={busy || !count} onClick={() => void send()} className="sm:flex-1">
                {busy ? "Печатаем…" : job?.status === "FAILED" ? "Ещё раз" : count ? `Напечатать ${count} ${word}` : "Ничего не выбрано"}
              </Button>
            )}
            <Button type="button" variant={usable ? "secondary" : "primary"} disabled={!count} onClick={openPage} className="sm:flex-1">
              Открыть для печати
            </Button>
            {afterIntake && (
              <Button type="button" variant="ghost" onClick={onClose} className="sm:flex-1">
                {job?.status === "DONE" ? "Готово" : "Не сейчас"}
              </Button>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
