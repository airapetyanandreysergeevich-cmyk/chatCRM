import { useState } from "react";
import { useDesktopUpdate } from "../lib/desktopUpdate";
import { Modal } from "./Modal";
import { Button } from "./ui";

/**
 * Значок «есть обновление» слева от часов на главной. Нажали — окно: что
 * нового и «Установить сейчас» / «Позже». «Позже» — значок остаётся до
 * установки; после обновления программа перезапускается уже без него.
 */
export function UpdateBadge() {
  const { update, install } = useDesktopUpdate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!update) return null;
  const lines = update.notes
    .split("\n")
    .map((l) => l.replace(/^[•\-*]\s*/, "").trim())
    .filter(Boolean);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`Доступна версия ${update.version} — нажмите, чтобы посмотреть и установить`}
        aria-label={`Доступно обновление ${update.version}`}
        data-update-badge={update.version}
        className="relative flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] border border-state-done/45 bg-state-done/15 text-state-done shadow-[0_0_18px_-4px_rgb(var(--state-done))] transition-transform duration-150 hover:scale-105"
      >
        <svg aria-hidden viewBox="0 0 24 24" className="h-[22px] w-[22px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />
        </svg>
        <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-state-done ring-2 ring-surface" />
      </button>
      {open && (
        <Modal title={`Доступна версия ${update.version}`} onClose={() => setOpen(false)}>
          <div className="space-y-4" data-update-dialog>
            <p className="text-[13.5px] text-ink-muted">
              Сейчас установлена {update.current}.{" "}
              {update.ready ? "Обновление уже загружено — можно ставить." : update.download ? "Откроется загрузка новой версии." : ""}
            </p>
            {/* Весь список изменений; длинный — прокручивается, кнопки остаются
                на виду (Андрей, 27.10.2026: «не весь текст влезает»). */}
            {lines.length > 0 && (
              <div className="max-h-[min(52vh,460px)] overflow-y-auto rounded-field border border-line bg-surface-input/40 py-3 pl-2 pr-3" data-update-notes>
                <ul className="list-disc space-y-2 pl-5 text-[13.5px] leading-snug text-ink-soft">
                  {lines.map((l, i) =>
                    /^\d+\.\d+\.\d+:?$/.test(l) ? (
                      <li key={i} className="-ml-5 list-none pt-1 text-[11.5px] font-bold uppercase tracking-[0.08em] text-ink-dim">
                        Версия {l.replace(/:$/, "")}
                      </li>
                    ) : (
                      <li key={i}>{l}</li>
                    )
                  )}
                </ul>
              </div>
            )}
            <p className="text-[12.5px] text-ink-dim">
              {update.download
                ? "Закройте FineCRM, откройте скачанный файл и перетащите FineCRM в «Программы» с заменой. База заказов и настройки останутся на месте."
                : "Программа закроется примерно на минуту: копия базы, установка, запуск. Сотрудники на других компьютерах на это время потеряют связь с Основой — лучше выбрать момент, когда никто не оформляет заказ."}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void install().finally(() => {
                    setBusy(false);
                    setOpen(false);
                  });
                }}
                data-update-install
              >
                {update.download ? "Скачать" : busy ? "Готовим установку…" : "Установить сейчас"}
              </Button>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Позже
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

/** Маленькая точка у «Сводки» в меню — обновление ждёт на главной. */
export function UpdateDot() {
  const { update } = useDesktopUpdate();
  if (!update) return null;
  return <span aria-label="Есть обновление программы" title={`Доступна версия ${update.version} — значок на главной`} className="ml-auto h-2 w-2 shrink-0 rounded-full bg-state-done shadow-[0_0_8px_1px_rgb(var(--state-done))]" data-update-dot />;
}
