import { useEffect, useState } from "react";
import {
  androidAppState,
  APK_URL,
  reportAndroidApp,
  type AndroidAppState,
} from "../lib/androidApp";
import { Card, SectionLabel } from "./ui";
import { IconBell } from "./icons";

/** Отложенный баннер не показываем неделю: напоминание раз в день — это раздражение. */
const SNOOZE_KEY = "finecrm.installApp.snoozeUntil";
const SNOOZE_DAYS = 7;

function snoozed(): boolean {
  try {
    const until = Number(localStorage.getItem(SNOOZE_KEY) ?? 0);
    return Number.isFinite(until) && until > Date.now();
  } catch {
    // Приватный режим или запрет на хранение — просто показываем баннер.
    return false;
  }
}

function snooze(): void {
  try {
    localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_DAYS * 86400_000));
  } catch {
    /* переживём */
  }
}

/** Общий опрос состояния — и для баннера, и для карточки на экране оповещений. */
export function useAndroidApp(): AndroidAppState | null {
  const [state, setState] = useState<AndroidAppState | null>(null);

  useEffect(() => {
    let alive = true;
    androidAppState()
      .then((s) => {
        if (!alive) return;
        setState(s);
        reportAndroidApp(s);
      })
      .catch(() => alive && setState("unknown"));
    return () => {
      alive = false;
    };
  }, []);

  return state;
}

/**
 * Полоса вверху экрана: видна только тем, у кого Android без нашего
 * приложения. Внутри приложения, на компьютере и на iPhone её нет.
 */
export function InstallAppBanner() {
  const state = useAndroidApp();
  const [hidden, setHidden] = useState(snoozed);

  if (state !== "missing" || hidden) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-brand-tint px-4 py-2.5 text-[13.5px] sm:px-5">
      {/* На телефоне полоса не должна съедать пол-экрана, поэтому пояснение
          видно только там, где для него есть место. Подробности всё равно
          лежат ниже, на экране «Оповещения». */}
      <span className="flex-1 text-brand-ink">
        <span className="font-semibold">Установите приложение FineCRM</span>
        <span className="hidden sm:inline">
          {" "}— заказы будут приходить оповещением на телефон, а не ждать, пока вы откроете сайт.
        </span>
      </span>
      <span className="flex items-center gap-2">
        <a
          href={APK_URL}
          download
          className="rounded-pill bg-brand px-3.5 py-1.5 text-[13px] font-semibold text-white transition-opacity duration-150 hover:opacity-90"
        >
          Скачать
        </a>
        <button
          onClick={() => {
            snooze();
            setHidden(true);
          }}
          className="rounded-pill px-3 py-1.5 text-[13px] font-medium text-ink-muted transition-colors duration-150 hover:text-ink"
        >
          Позже
        </button>
      </span>
    </div>
  );
}

/** Подробный блок на экране «Оповещения»: что это, зачем и как поставить. */
export function InstallAppCard() {
  const state = useAndroidApp();
  if (state === null || state === "not-android" || state === "unknown") return null;

  if (state === "in-app" || state === "installed") {
    return (
      <Card>
        <SectionLabel>Приложение для Android</SectionLabel>
        <div className="mt-3 flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-field bg-brand-tint text-brand">
            <IconBell className="h-[18px] w-[18px]" />
          </span>
          <p className="text-[14px] leading-relaxed text-ink-muted">
            {state === "in-app"
              ? "Вы работаете в приложении — всё на месте."
              : "Приложение установлено. Открывайте FineCRM с домашнего экрана: так оповещения приходят надёжнее."}
          </p>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <SectionLabel>Приложение для Android</SectionLabel>
      <p className="mt-3 text-[14px] leading-relaxed text-ink-muted">
        В приложении FineCRM открывается на весь экран, без адресной строки, и
        оповещения о заказах приходят как у обычной программы.
      </p>
      <div className="mt-4">
        {/* Ссылка, а не кнопка: скачивание файла — это переход по адресу.
            Стиль повторяет основную кнопку, чтобы не выбиваться из интерфейса. */}
        <a
          href={APK_URL}
          download
          className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-field bg-brand px-4 text-sm font-semibold text-white transition-all duration-150 hover:bg-brand-press active:scale-[.985]"
        >
          Скачать приложение
        </a>
      </div>
      <p className="mt-3 text-[13px] leading-relaxed text-ink-dim">
        Приложение не из Google Play, поэтому при установке Android один раз
        спросит разрешение ставить из этого источника. Это нормально: файл
        подписан нашим ключом и обновляется только нами.
      </p>
    </Card>
  );
}
