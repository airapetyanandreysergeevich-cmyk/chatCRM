import type { ReactNode } from "react";
import { IconClose } from "./icons";

/**
 * На десктопе — окно по центру, на телефоне — лист снизу.
 * Нативные alert/confirm не используем: они блокируют страницу и выглядят чужеродно.
 *
 * Закрывается окно только своими кнопками — «Отмена», «Сохранить» или
 * крестиком в углу. Ни щелчок мимо окна, ни Escape его не закрывают.
 *
 * Раньше закрывали, и это стоило введённого. Выделяешь мышью имя в анкете
 * клиента, ведёшь чуть дальше края окна, отпускаешь — браузер считает это
 * щелчком по подложке, и анкета исчезает вместе со всем набранным. Escape
 * тем же ударом закрывал и подсказку в поле, и окно под ней. Лишнее нажатие
 * на кнопку стоит секунды; потерянная анкета — нового звонка клиенту.
 *
 * Крестик в заголовке есть у каждого окна, поэтому выход всегда на виду, даже
 * у тех, где своей кнопки «Отмена» не предусмотрено.
 */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    // Подложка закрывает и нижнее меню (переход по нему потерял бы набранное
    // в окне), а сам лист кончается над меню: иначе кнопки «Сохранить» и
    // «Подставить» уезжали под него. Высоту меню кладёт Layout в --bottom-nav.
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-[rgba(6,8,13,.72)] p-0 pb-[var(--bottom-nav,0px)] backdrop-blur-[2px] sm:items-center sm:p-5 sm:pb-[calc(var(--bottom-nav,0px)+20px)]">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[calc(100dvh-var(--bottom-nav,0px)-24px)] w-full overflow-y-auto rounded-t-[20px] border border-line bg-surface p-5 shadow-modal sm:max-w-[520px] sm:rounded-panel sm:p-7"
      >
        <div className="mx-auto mb-4 h-[4px] w-10 rounded-full bg-line-strong sm:hidden" />
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-xl font-extrabold tracking-tight">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            title="Закрыть"
            className="-mr-1.5 -mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-field text-ink-muted transition-colors duration-150 hover:bg-surface-raised hover:text-ink [&>svg]:h-[18px] [&>svg]:w-[18px]"
          >
            <IconClose />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
