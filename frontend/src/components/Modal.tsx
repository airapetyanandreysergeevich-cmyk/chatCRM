import { useEffect, type ReactNode } from "react";

/**
 * На десктопе — окно по центру, на телефоне — лист снизу.
 * Нативные alert/confirm не используем: они блокируют страницу и выглядят чужеродно.
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-[rgba(6,8,13,.72)] p-0 backdrop-blur-[2px] sm:items-center sm:p-5"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-[20px] border border-line bg-surface p-5 shadow-modal sm:max-w-[520px] sm:rounded-panel sm:p-7"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-4 h-[4px] w-10 rounded-full bg-line-strong sm:hidden" />
        <h2 className="mb-4 text-xl font-extrabold tracking-tight">{title}</h2>
        {children}
      </div>
    </div>
  );
}
