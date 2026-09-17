import { useEffect, useRef, useState } from "react";
import { IconDelete } from "./icons";
import { Input } from "./ui";

/**
 * Поле ввода, которое помнит, что в него вводили раньше.
 *
 * Отличие от обычного автодополнения браузера в том, что список общий на всю
 * мастерскую: марку, которую записал сменщик утром, вечером увидит второй
 * приёмщик. Браузерный autocomplete так не умеет — он хранит историю в одном
 * профиле на одном устройстве, и после переустановки её нет.
 *
 * Свой вариант всегда можно набрать руками: список ничего не навязывает и
 * ничего не подставляет сам.
 */

export interface Suggestion {
  id: string;
  value: string;
  /** Приписка справа: сколько раз пригодилось, цена — что уместно полю. */
  meta?: string;
}

export function SuggestInput({
  value,
  onChange,
  items,
  onForget,
  placeholder,
  emptyHint,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  items: Suggestion[];
  /** Если задано — в строке появляется урна, убирающая вариант из памяти. */
  onForget?: (item: Suggestion) => void;
  placeholder?: string;
  /** Что сказать, когда память пуста и подсказывать нечего. */
  emptyHint?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  const show = open && items.length > 0;

  // Подсветка сбрасывается, когда список перестроился под новый текст:
  // иначе Enter выбрал бы вариант, который человек уже не видит.
  useEffect(() => setHighlight(0), [value]);

  // Клик мимо закрывает список. Только blur здесь мало: по нему список
  // закрывается и при переходе к урне внутри самого списка.
  useEffect(() => {
    if (!show) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [show]);

  function pick(item: Suggestion) {
    onChange(item.value);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") return setOpen(false);
    if (!show) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => (h + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => (h - 1 + items.length) % items.length);
    } else if (e.key === "Enter") {
      // Enter перехватываем только при открытом списке: иначе отберём у
      // формы обычное подтверждение.
      e.preventDefault();
      pick(items[highlight] ?? items[0]);
    }
  }

  return (
    <div className="relative" ref={box}>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        // Свой список вместо браузерного: тот перекрывает наш собственной
        // панелью, и получаются две подсказки одна поверх другой.
        autoComplete="off"
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={show}
        aria-autocomplete="list"
      />

      {show && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-[280px] overflow-y-auto rounded-field border border-line bg-surface-raised shadow-modal">
          {items.map((item, i) => (
            <div
              key={item.id}
              onMouseEnter={() => setHighlight(i)}
              className={
                "flex items-center border-b border-line last:border-b-0 " +
                (i === highlight ? "bg-surface-hover" : "")
              }
            >
              <button
                type="button"
                // onMouseDown, а не onClick: клик иначе сначала снимает фокус
                // с поля, список закрывается, и выбор не доходит.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(item);
                }}
                className={
                  "flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left text-[13.5px] " +
                  (i === highlight ? "text-ink" : "text-ink-soft")
                }
              >
                <span className="min-w-0 flex-1 truncate">{item.value}</span>
                {item.meta && <span className="shrink-0 text-[12px] text-ink-dim">{item.meta}</span>}
              </button>

              {onForget && (
                <button
                  type="button"
                  title={`Забыть «${item.value}»`}
                  aria-label={`Забыть вариант ${item.value}`}
                  onMouseDown={(e) => {
                    // Нажатие на урну не должно выбрать вариант, который
                    // человек как раз убирает.
                    e.preventDefault();
                    e.stopPropagation();
                    onForget(item);
                  }}
                  className="mr-1.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] text-ink-dim transition-colors duration-150 hover:bg-state-off/15 hover:text-state-off [&>svg]:h-[15px] [&>svg]:w-[15px]"
                >
                  <IconDelete />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {open && items.length === 0 && emptyHint && (
        <p className="mt-1 text-[12px] text-ink-dim">{emptyHint}</p>
      )}
    </div>
  );
}
