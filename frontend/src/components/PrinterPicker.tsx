import { useState } from "react";
import { ApiError } from "../lib/api";
import { plural } from "../lib/format";
import { printAndWait, type PrintJob, type Station, type Target } from "../lib/printing";
import { Modal } from "./Modal";
import { Banner, Button } from "./ui";

/**
 * Выбор принтера: все принтеры всех компьютеров мастерской с программой
 * FineCRM. Тестовая страница печатается прямо отсюда, до «Назначить», —
 * чтобы назначали принтер, который точно печатает.
 */
export function PrinterPicker({
  title,
  stations,
  current,
  onSave,
  onReload,
  onClose,
}: {
  title: string;
  stations: Station[];
  current: Target | null;
  onSave: (t: Target) => Promise<void>;
  onReload: () => void;
  onClose: () => void;
}) {
  const [pick, setPick] = useState<{ stationId: string; printer: string } | null>(
    current ? { stationId: current.stationId, printer: current.printer } : null
  );
  const [copies, setCopies] = useState(current?.copies ?? 1);
  const [test, setTest] = useState<PrintJob | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const station = pick ? stations.find((s) => s.id === pick.stationId) : undefined;
  const total = stations.reduce((n, s) => n + s.printers.length, 0);

  async function runTest() {
    if (!pick) return;
    setTesting(true);
    setError(null);
    setTest(null);
    try {
      const job = await printAndWait({ doc: "test", stationId: pick.stationId, printer: pick.printer }, setTest);
      setTest(job);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось отправить тестовую страницу");
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    if (!pick) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ ...pick, copies });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить");
      setSaving(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-4">
        {error && <Banner tone="error">{error}</Banner>}

        {stations.length === 0 ? (
          <Banner>
            Пока ни один компьютер не сообщил о своих принтерах. Запустите программу FineCRM для Windows на
            компьютере, к которому подключён принтер, и войдите в неё — через минуту принтеры появятся здесь.
          </Banner>
        ) : (
          <div className="space-y-3">
            <p className="text-[13px] text-ink-muted">
              {plural(total, "принтер", "принтера", "принтеров")} на{" "}
              {plural(stations.length, "компьютере", "компьютерах", "компьютерах")} с FineCRM. Выберите, куда печатать.
            </p>
            {stations.map((s) => (
              <div key={s.id} className="overflow-hidden rounded-field border border-line">
                <div className="flex items-center justify-between gap-3 bg-surface-raised/60 px-3.5 py-2">
                  <span className="text-[13px] font-bold">{s.name}</span>
                  <span className={"text-[12px] font-semibold " + (s.online ? "text-state-done" : "text-ink-dim")}>
                    {s.online ? "на связи" : "не на связи"}
                  </span>
                </div>
                {s.printers.length === 0 ? (
                  <p className="px-3.5 py-2.5 text-[13px] text-ink-dim">Windows на этом компьютере не видит принтеров</p>
                ) : (
                  s.printers.map((p) => {
                    const on = pick?.stationId === s.id && pick.printer === p.name;
                    return (
                      <button
                        key={p.name}
                        type="button"
                        aria-pressed={on}
                        onClick={() => {
                          setPick({ stationId: s.id, printer: p.name });
                          setTest(null);
                        }}
                        className={
                          "flex w-full items-center gap-3 border-t border-line px-3.5 py-2.5 text-left transition-colors duration-150 " +
                          (on ? "bg-brand-tint" : "hover:bg-surface-raised")
                        }
                      >
                        <span
                          className={
                            "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2 " +
                            (on ? "border-brand" : "border-line-strong")
                          }
                        >
                          {on && <span className="h-2 w-2 rounded-full bg-brand" />}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className={"block truncate text-[14px] font-semibold " + (on ? "text-brand-ink" : "")}>
                            {p.displayName}
                          </span>
                          {p.isDefault && <span className="text-[12px] text-ink-dim">по умолчанию в Windows</span>}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>
            ))}
          </div>
        )}

        {pick && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold text-ink-soft">Копий:</span>
            {[1, 2].map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={copies === n}
                onClick={() => setCopies(n)}
                className={
                  "rounded-pill border px-3.5 py-1.5 text-[13px] font-semibold transition-colors duration-150 " +
                  (copies === n ? "border-brand bg-brand-tint text-brand-ink" : "border-line bg-surface-raised text-ink-muted hover:text-ink")
                }
              >
                {n === 1 ? "1" : "2 — клиенту и себе"}
              </button>
            ))}
          </div>
        )}

        {test && (
          <Banner tone={test.status === "FAILED" ? "error" : "info"}>
            {test.status === "DONE"
              ? "Тестовая страница напечатана. Если лист вышел — назначайте."
              : test.status === "FAILED"
                ? `Не напечатано: ${test.error ?? "причина неизвестна"}`
                : test.status === "SENT"
                  ? "Компьютер печатает…"
                  : "Отправлено, ждём компьютер…"}
          </Banner>
        )}

        <p className="text-[12.5px] text-ink-dim">
          Нет нужного принтера? Добавьте его в Windows на компьютере, к которому он подключён («Параметры → Принтеры и
          сканеры»). Программа FineCRM на том компьютере сообщит о нём в течение минуты —{" "}
          <button type="button" onClick={onReload} className="font-semibold text-brand hover:text-brand-ink">
            обновить список
          </button>
          .
        </p>

        <div className="flex flex-col gap-2 sm:flex-row-reverse">
          <Button type="button" disabled={!pick || saving} onClick={() => void save()} className="sm:flex-1">
            {saving ? "Сохраняем…" : "Назначить"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={!pick || testing || !station?.online}
            title={station && !station.online ? "Компьютер с этим принтером сейчас не на связи" : undefined}
            onClick={() => void runTest()}
            className="sm:flex-1"
          >
            {testing ? "Печатаем…" : "Тестовая страница"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
