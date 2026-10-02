import { useSearchParams } from "react-router-dom";
import { SMS_APP_URL } from "../lib/sms";

/**
 * Страница из QR-кода «Подключить телефон» (Настройки → Интеграции).
 *
 * Камера телефона открывает ссылку в браузере; отсюда приложение «FineCRM SMS»
 * запускается уже с адресом мастерской и кодом. Нет приложения — Chrome сам
 * уйдёт на скачивание (S.browser_fallback_url). Входа здесь нет и не нужен:
 * код одноразовый и живёт 10 минут.
 */
export default function SmsPhoneLink() {
  const [params] = useSearchParams();
  const code = (params.get("c") ?? "").replace(/\D/g, "").slice(0, 6);
  const server = params.get("u") ?? "";
  const intent =
    `intent://pair?u=${encodeURIComponent(server)}&c=${code}` +
    `#Intent;scheme=finecrmsms;package=ru.finecrm.sms;S.browser_fallback_url=${encodeURIComponent(SMS_APP_URL)};end`;

  return (
    <div className="mx-auto max-w-[460px] space-y-5 p-5 pt-10">
      <h1 className="text-[24px] font-extrabold leading-tight tracking-tight">Подключение телефона к FineCRM</h1>
      <p className="text-[14.5px] leading-relaxed text-ink-muted">
        Этот телефон будет отправлять SMS клиентам мастерской со своей SIM-карты.
      </p>
      <a
        href={intent}
        className="flex min-h-[50px] items-center justify-center rounded-field bg-brand px-4 text-[15px] font-bold text-white"
      >
        Открыть в приложении FineCRM SMS
      </a>
      <a
        href={SMS_APP_URL}
        className="flex min-h-[46px] items-center justify-center rounded-field border border-line bg-surface-raised px-4 text-[14.5px] font-semibold"
      >
        Скачать приложение
      </a>
      <div className="rounded-card border border-line bg-surface p-4 text-[14px]">
        <p className="text-ink-dim">Если приложение не открылось само — введите в нём вручную:</p>
        <p className="mt-2">
          <span className="text-ink-dim">Адрес: </span>
          <span className="break-all font-mono font-semibold">{server || "—"}</span>
        </p>
        <p className="mt-1">
          <span className="text-ink-dim">Код: </span>
          <span className="font-mono text-[20px] font-extrabold tracking-[0.18em]">{code || "—"}</span>
        </p>
      </div>
    </div>
  );
}
