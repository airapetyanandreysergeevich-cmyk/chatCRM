import { useEffect, useState, type ReactNode } from "react";
import { Modal } from "./Modal";
import { IconDesktopDownload, IconPhoneDownload, IconPhoneShare } from "./icons";
import { APK_URL } from "../lib/androidApp";

/**
 * Откуда взять программу.
 *
 * Стоит на странице входа, потому что именно там человек оказывается, впервые
 * открыв сайт, — и именно тогда возникает вопрос «а приложение есть?».
 * Отдельная страница этот момент бы не поймала: на неё надо ещё догадаться
 * зайти.
 *
 * Три платформы, и все три разные по сути, так что притворяться, будто они
 * одинаковы, вредно:
 *
 * — **Android** получает файл, который ставится как обычное приложение.
 * — **iOS** не получает ничего: поставить что-либо мимо App Store там
 *   нельзя вовсе. Единственный честный ответ — «добавьте на экран Домой»; это
 *   не обходной путь, а штатный для iOS способ, после которого сайт
 *   открывается своим окном без адресной строки. Поэтому у плитки не
 *   «скачать», а «как установить».
 * — **Windows** получает установщик с базой внутри — это уже не окно к сайту,
 *   а отдельная программа, которая умеет работать без интернета.
 *
 * Значки по умолчанию — силуэты устройств из общего набора, а не фирменные
 * знаки Google, Apple и Microsoft: чужие логотипы принадлежат им, и рисовать
 * их своей рукой нельзя. Стрелка при этом держит смысл действия: вниз —
 * скачать файл, вверх из корпуса — то самое «Поделиться», с которого
 * начинается установка на iPhone.
 *
 * Но если положить официальные знаки в `public/brands/` (см. README там же),
 * плитки подхватят их сами. Файла нет или он не открылся — остаётся силуэт,
 * и страница не показывает битую картинку. Знак должен приехать от владельца
 * марки, а не быть нарисован нами; всё остальное здесь к этому готово.
 */

/** Раздаётся сервером из папки, не попадающей в сборку, — см. deploy/nginx. */
const SETUP_URL = "/download/FineCRM-setup.exe";

const STEPS = [
  "Откройте этот сайт в Safari — в других браузерах на iPhone кнопки не будет.",
  "Нажмите «Поделиться» — квадрат со стрелкой вверх внизу экрана.",
  "Пролистайте список и выберите «На экран „Домой“».",
  "Нажмите «Добавить». Значок появится среди приложений.",
];

/**
 * Фирменный знак, если он есть, и силуэт, если его нет.
 *
 * Проверять наличие файла заранее было бы лишним запросом на каждую плитку:
 * браузер и так скажет, если картинка не открылась, — этим и пользуемся.
 */
function PlatformMark({ file, fallback }: { file: string; fallback: ReactNode }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <>{fallback}</>;
  return (
    <img
      src={`/brands/${file}`}
      alt=""
      className="h-[18px] w-[18px] object-contain"
      onError={() => setFailed(true)}
    />
  );
}

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
  const [hasSetup, setHasSetup] = useState(false);

  // Спрашиваем сервер, лежит ли установщик. Кнопка, ведущая в «не найдено»,
  // хуже отсутствующей: первая обещает и обманывает, вторая просто молчит.
  useEffect(() => {
    let alive = true;
    fetch(SETUP_URL, { method: "HEAD" })
      .then((res) => {
        if (alive && res.ok) setHasSetup(true);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <div className="mt-8 border-t border-line pt-5">
        <div className="flex flex-col gap-2 sm:flex-row">
          <Tile
            as="a"
            href={APK_URL}
            download
            icon={<PlatformMark file="android.svg" fallback={<IconPhoneDownload />} />}
            title="Android"
            text="Скачать приложение"
          />
          <Tile
            as="button"
            onClick={() => setIos(true)}
            icon={<PlatformMark file="ios.svg" fallback={<IconPhoneShare />} />}
            title="iOS"
            text="Как установить"
          />
          {hasSetup && (
            <Tile
              as="a"
              href={SETUP_URL}
              download
              icon={<PlatformMark file="windows.svg" fallback={<IconDesktopDownload />} />}
              title="Windows"
              text="Скачать приложение"
            />
          )}
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
