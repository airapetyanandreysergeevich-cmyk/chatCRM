import { useState } from "react";
import { Modal } from "./Modal";
import { IconDownload, IconShare } from "./icons";
import { APK_URL } from "../lib/androidApp";

/**
 * Как поставить программу на телефон.
 *
 * Стоит на странице входа, потому что именно там человек оказывается, впервые
 * открыв сайт с телефона — и именно тогда вопрос «а приложение есть?»
 * возникает. Отдельная страница «Приложения» этот момент бы не поймала: на неё
 * надо ещё догадаться зайти.
 *
 * Android и iPhone здесь не равны, и притворяться, что равны, — вредно.
 * Android получает настоящий файл, который ставится как обычное приложение.
 * На iPhone поставить что-либо мимо App Store нельзя вовсе, и единственный
 * честный ответ — «добавьте на экран Домой»: это не обходной путь, а
 * стандартный для iOS способ, после которого сайт открывается своим окном без
 * адресной строки. Поэтому у второй плитки не «скачать», а «как установить».
 *
 * Значки взяты свои, из общего набора: рисовать чужие фирменные знаки на своей
 * странице нельзя, а стрелка вниз и квадрат со стрелкой вверх понятны и без них
 * — вторая к тому же в точности повторяет кнопку «Поделиться» в Safari, о
 * которой и говорит инструкция.
 */

const STEPS = [
  "Откройте этот сайт в Safari — в других браузерах на iPhone кнопки не будет.",
  "Нажмите «Поделиться» — квадрат со стрелкой вверх внизу экрана.",
  "Пролистайте список и выберите «На экран „Домой“».",
  "Нажмите «Добавить». Значок появится среди приложений.",
];

function Tile({
  icon,
  title,
  text,
  as,
  ...rest
}: {
  icon: React.ReactNode;
  title: string;
  text: string;
  as: "a" | "button";
  href?: string;
  download?: boolean;
  onClick?: () => void;
}) {
  const Tag = as as "a";
  return (
    <Tag
      {...rest}
      className="flex flex-1 items-center gap-3 rounded-card border border-line bg-surface p-3 text-left transition-colors duration-150 hover:border-line-strong hover:bg-surface-hover"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-field bg-surface-raised text-ink-muted [&>svg]:h-[18px] [&>svg]:w-[18px]">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[14px] font-bold leading-tight">{title}</span>
        <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-muted">{text}</span>
      </span>
    </Tag>
  );
}

export function AppLinks() {
  const [ios, setIos] = useState(false);

  return (
    <>
      <div className="mt-8 border-t border-line pt-5">
        <p className="mb-2.5 text-[12.5px] font-semibold uppercase tracking-wide text-ink-dim">
          На телефон
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Tile
            as="a"
            href={APK_URL}
            download
            icon={<IconDownload />}
            title="Android"
            text="Скачать приложение"
          />
          <Tile
            as="button"
            onClick={() => setIos(true)}
            icon={<IconShare />}
            title="iPhone"
            text="Как установить"
          />
        </div>
      </div>

      {ios && (
        <Modal title="FineCRM на iPhone" onClose={() => setIos(false)}>
          <p className="text-[13.5px] leading-relaxed text-ink-muted">
            Отдельного приложения для iPhone нет: поставить что-либо мимо App Store там нельзя.
            Но сайт умеет жить на экране «Домой» своим значком и открываться без адресной строки —
            от приложения не отличить.
          </p>

          <ol className="mt-4 space-y-2.5">
            {STEPS.map((step, i) => (
              <li key={step} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-raised text-[12px] font-bold text-ink-muted">
                  {i + 1}
                </span>
                <span className="text-[14px] leading-relaxed">{step}</span>
              </li>
            ))}
          </ol>

          <p className="mt-4 text-[12.5px] leading-relaxed text-ink-dim">
            Оповещения о заказах на iPhone приходят только так — добавленному на экран «Домой»
            сайту. Открытому в браузере их не отдаёт сама iOS.
          </p>
        </Modal>
      )}
    </>
  );
}
