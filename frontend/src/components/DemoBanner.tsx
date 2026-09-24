import { useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { demoApi, reloadAfterDemo, type DemoState } from "../lib/demoApi";
import { Modal } from "./Modal";
import { Banner, Button } from "./ui";

/**
 * Окно «Убрать тестовые данные». Одно на полосу и на «Базы».
 *
 * Слова подтверждения здесь нет, в отличие от стирания раздела: убирается
 * только заведённое кнопкой «Заполнить», настоящие записи остаются. Но что
 * именно уйдёт — говорим до нажатия.
 */
export function RemoveDemoModal({ state, onClose }: { state: Extract<DemoState, { active: true }>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await demoApi.remove();
      reloadAfterDemo();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось убрать");
      setBusy(false);
    }
  }

  return (
    <Modal title="Убрать тестовые данные" onClose={onClose}>
      <div className="space-y-4">
        <p className="text-[14px] leading-relaxed text-ink-soft">
          Уйдут тестовые заказы ({state.orders}), клиенты ({state.customers}), склад, прайс, тестовые
          сотрудники и деньги по тестовым заказам. То, что вы завели сами, останется — в том числе
          тестовый клиент, если на него уже принят настоящий заказ.
        </p>
        {error && <Banner tone="error">{error}</Banner>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="danger" onClick={() => void run()} disabled={busy}>
            {busy ? "Убираем…" : "Убрать и начать работу"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Полоса над рабочим окном, пока в базе тестовые данные.
 *
 * Видит только владелец: сотруднику убрать их нечем, а пароль тестовых учёток
 * ему знать незачем. Скрыть полосу нельзя — это не реклама, а напоминание,
 * что в кассе не настоящие деньги.
 */
export function DemoBanner() {
  const { me } = useAuth();
  const isOwner = me?.kind === "tenant" && me.user.isOwner;
  const [state, setState] = useState<DemoState | null>(null);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    if (!isOwner) return;
    let alive = true;
    demoApi
      .state()
      .then((s) => alive && setState(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [isOwner]);

  if (!isOwner || !state?.active) return null;

  const example = state.logins.find((l) => l.startsWith("oleg")) ?? state.logins[0];

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-state-waiting/30 bg-state-waiting/10 px-4 py-2.5 text-[13.5px] sm:px-5">
      <span className="flex-1 text-ink">
        <span className="font-semibold text-state-waiting">В базе тестовые данные.</span>{" "}
        <span className="text-ink-soft">
          {example ? (
            <>
              Тестовые сотрудники входят с паролем <b className="font-mono">{state.password}</b> — например,{" "}
              <span className="font-mono">{example}</span>.{" "}
            </>
          ) : null}
          Насмотрелись — уберите их и начинайте работу.
        </span>
      </span>
      <button
        onClick={() => setRemoving(true)}
        className="rounded-pill bg-state-waiting px-3.5 py-1.5 text-[13px] font-semibold text-white transition-opacity duration-150 hover:opacity-90"
      >
        Убрать тестовые данные
      </button>
      {removing && <RemoveDemoModal state={state} onClose={() => setRemoving(false)} />}
    </div>
  );
}
