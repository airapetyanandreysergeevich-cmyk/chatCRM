import { useState } from "react";
import { ApiError } from "../lib/api";
import { folderBridge, folderRequest, orderFolderApi, type FolderResult } from "../lib/orderFolder";
import { ordersApi, type Order } from "../lib/orders";
import { Modal } from "./Modal";
import { Banner, Button } from "./ui";

/**
 * «Папка заказа»: открыть (и завести, если ещё нет) папку заказа в Проводнике.
 *
 * Только в программе FineCRM: available = false в браузере и на телефоне —
 * там кнопку и пункт меню не показываем. На этом компьютере общая папка ещё
 * не выбрана или пропала (диск не подключён) — окно предлагает выбрать её
 * сразу, и после выбора папка заказа открывается без второго нажатия.
 */

type Dialog =
  | { kind: "root"; order: Order; reason: "none" | "missing"; error?: string }
  | { kind: "error"; order: Order; message: string };

export function useOrderFolder() {
  const bridge = folderBridge();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(o: Order): Promise<FolderResult | null> {
    if (!bridge) return null;
    const s = await orderFolderApi.get();
    const r = await bridge.open(folderRequest(o, s));
    if (r.ok) return r;
    if (r.needRoot) setDialog({ kind: "root", order: o, reason: "none" });
    else if (r.missingRoot) setDialog({ kind: "root", order: o, reason: "missing", error: r.error });
    else setDialog({ kind: "error", order: o, message: r.error ?? "Папка заказа не открылась" });
    return r;
  }

  async function open(target: Order | string) {
    if (!bridge || busy) return;
    setBusy(true);
    try {
      const o = typeof target === "string" ? await ordersApi.get(target) : target;
      await run(o);
    } catch (e) {
      setDialog({
        kind: "error",
        order: typeof target === "string" ? ({ id: target } as Order) : target,
        message: e instanceof ApiError ? e.message : "Нет связи с сервером",
      });
    } finally {
      setBusy(false);
    }
  }

  async function pickAndOpen(o: Order) {
    if (!bridge) return;
    const picked = await bridge.pickRoot();
    if (!picked.ok) return; // отменили — окно остаётся, можно выбрать снова или закрыть
    setDialog(null);
    await run(o);
  }

  const element = dialog && (
    <Modal title={dialog.kind === "root" ? "Папка заказов на этом компьютере" : "Папка заказа"} onClose={() => setDialog(null)}>
      <div className="space-y-4" data-order-folder-dialog>
        {dialog.kind === "root" ? (
          <>
            {dialog.reason === "missing" && <Banner tone="warning">{dialog.error}</Banner>}
            <p className="text-[14px] leading-relaxed text-ink-soft">
              {dialog.reason === "none"
                ? "Выберите общую папку, в которой лежат папки заказов. Внутри программа сама заведёт папку этого заказа."
                : "Выберите папку заново или подключите диск и попробуйте ещё раз."}
            </p>
            <p className="text-[13px] leading-relaxed text-ink-muted">
              На компьютере с Основой это обычно папка на диске, например D:\Заказы. На остальных — та же папка по сети
              (\\ОСНОВА\Заказы) или подключённый сетевой диск. Папку каждый компьютер помнит свою.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="button" onClick={() => pickAndOpen(dialog.order)} className="sm:flex-1">
                Выбрать папку…
              </Button>
              <Button type="button" variant="secondary" onClick={() => setDialog(null)} className="sm:flex-1">
                Отмена
              </Button>
            </div>
          </>
        ) : (
          <>
            <Banner tone="error">{dialog.message}</Banner>
            <div className="flex flex-col gap-2 sm:flex-row">
              {dialog.order.number && (
                <Button type="button" variant="secondary" onClick={() => pickAndOpen(dialog.order)} className="sm:flex-1">
                  Выбрать другую общую папку…
                </Button>
              )}
              <Button type="button" onClick={() => setDialog(null)} className="sm:flex-1">
                Закрыть
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );

  return { available: !!bridge, open, busy, element };
}
