import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError } from "../lib/api";
import { printAndWait, printingApi, targetLabel, type PrintingOverview, type PrintJob } from "../lib/printing";
import { Modal } from "./Modal";
import { Banner, Button, Checkbox, Spinner } from "./ui";

/**
 * Печать бланка заказа: на принтер через CRM или обычным окном печати.
 *
 * Одно окно на все случаи: кнопки «Квитанция» и «Акт работ» в карточке и
 * предложение распечатать квитанцию сразу после приёма. В режиме auto
 * (настройка «Печатать сразу») задание уходит само, окно показывает только
 * ход печати и закрывается, когда лист напечатан.
 */
export function PrintDialog({
  orderId,
  number,
  doc,
  afterIntake = false,
  auto = false,
  onClose,
}: {
  orderId: string;
  number: string;
  doc: "intake" | "act";
  /** Открыто сразу после «Принять в ремонт». */
  afterIntake?: boolean;
  /** Не спрашивать — отправить сразу (настройка «Печатать сразу»). */
  auto?: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [data, setData] = useState<PrintingOverview | null>(null);
  const [job, setJob] = useState<PrintJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [always, setAlways] = useState(false);
  const started = useRef(false);

  const name = doc === "act" ? "Акт работ" : "Квитанция";
  const openPage = () => navigate(`/orders/${orderId}/print?doc=${doc}`);

  async function send() {
    setBusy(true);
    setError(null);
    setJob(null);
    try {
      if (always) await printingApi.setMine({ intake: "auto" }).catch(() => undefined);
      const done = await printAndWait({ doc, orderId }, setJob);
      setJob(done);
      if (done.status === "DONE") setTimeout(onClose, 1500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось отправить на принтер");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    printingApi
      .overview()
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось узнать принтер"));
  }, []);

  // «Печатать сразу»: принтер известен и на связи — отправляем без вопросов.
  useEffect(() => {
    if (!auto || !data || started.current) return;
    started.current = true;
    if (data.effective?.online) void send();
  }, [auto, data]); // eslint-disable-line react-hooks/exhaustive-deps

  const t = data?.effective ?? null;
  const usable = !!t && t.online && !t.stationGone && !t.printerGone;
  const loading = data === null && !error;

  return (
    <Modal title={afterIntake ? `Заказ ${number} принят` : `${name} · ${number}`} onClose={onClose}>
      <div className="space-y-4">
        {afterIntake && !job && !busy && <p className="text-[15px]">Распечатать квитанцию о приёме?</p>}

        {loading ? (
          <Spinner label="Ищем принтер" />
        ) : (
          <>
            {t ? (
              <p className="text-[13.5px] text-ink-muted">
                Принтер: <span className="font-semibold text-ink">{targetLabel(t)}</span>
                {t.copies === 2 ? " · 2 копии" : ""}
                {t.source === "mine" ? " · ваш" : ""}
              </p>
            ) : (
              <Banner tone="warning">
                Принтер не назначен — печать откроется обычным окном.{" "}
                <Link to="/settings/peripherals" className="font-semibold underline">
                  Назначить принтер
                </Link>
              </Banner>
            )}
            {t && !usable && !job && (
              <Banner tone="warning">
                {t.stationGone
                  ? "Компьютер с этим принтером убран из списка — назначьте принтер заново в «Настройки → Периферия»."
                  : t.printerGone
                    ? `Windows на компьютере «${t.stationName}» больше не видит этот принтер.`
                    : `Компьютер «${t.stationName}» сейчас не на связи: он выключен или программа FineCRM на нём закрыта.`}
              </Banner>
            )}
          </>
        )}

        {error && <Banner tone="error">{error}</Banner>}
        {job && (
          <Banner tone={job.status === "FAILED" ? "error" : "info"}>
            {job.status === "DONE"
              ? `Напечатано на «${job.printer}»${job.copies === 2 ? " — 2 копии" : ""}.`
              : job.status === "FAILED"
                ? `Не напечатано: ${job.error ?? "причина неизвестна"}`
                : job.status === "SENT"
                  ? `Печатаем на «${job.printer}»…`
                  : `Отправлено на «${job.printer}», ждём компьютер «${job.station ?? ""}»…`}
          </Banner>
        )}

        {afterIntake && usable && !auto && !job && (
          <Checkbox label="Печатать сразу после приёма, не спрашивать" checked={always} onChange={setAlways} />
        )}

        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          {usable && job?.status !== "DONE" && (
            <Button type="button" disabled={busy} onClick={() => void send()} className="sm:flex-1">
              {busy ? "Печатаем…" : job?.status === "FAILED" ? "Ещё раз" : "На принтер"}
            </Button>
          )}
          {!loading && (
            <Button type="button" variant={usable ? "secondary" : "primary"} onClick={openPage} className="sm:flex-1">
              {usable ? "Открыть для печати" : `Открыть ${doc === "act" ? "акт" : "квитанцию"}`}
            </Button>
          )}
          {afterIntake && (
            <Button type="button" variant="ghost" onClick={onClose} className="sm:flex-1">
              {job?.status === "DONE" ? "Готово" : "Не сейчас"}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
