import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { masterLabel, ordersApi, type Order, type OrderStatus, type Reference, type StatusGroup } from "../lib/orders";
import { smsApi, type ReadyHint } from "../lib/sms";
import type { BoardCard } from "../lib/workshop";
import { copyText } from "./CopyMenu";
import {
  IconCamera,
  IconChevronLeft,
  IconChevronRight,
  IconDelete,
  IconEdit,
  IconOrders,
  IconPerson,
  IconPlus,
  IconPrint,
  IconSearch,
  IconSms,
  IconStatusProgress,
  IconUrgent,
} from "./icons";
import { IssueDialog } from "./IssueDialog";
import { LabelDialog } from "./LabelDialog";
import { Modal } from "./Modal";
import { OrderEditModal } from "./OrderEditModal";
import { OrderPeek } from "./OrderPeek";
import { SmsModal } from "./OrderSms";
import { PhotoShooter } from "./PhotoShooter";
import { PrintDialog } from "./PrintDialog";
import { Banner, Button, Field, Input } from "./ui";

/**
 * Меню заказа: правая кнопка мыши по заказу на доске и в списке, на телефоне —
 * долгое нажатие (лист снизу).
 *
 * Всё, что делают с заказом десятки раз в день, — сменить статус, напечатать
 * наклейку, написать клиенту, — без захода в карточку: заказ остаётся в
 * списке, человек — на своём экране. Окна те же, что в карточке заказа
 * (печать, наклейки, SMS, правка, выдача), и права те же: чего нельзя в
 * карточке, того нет и в меню, а сервер всё равно проверяет сам.
 *
 * Смена статуса — и отсюда, и перетаскиванием на доске — идёт через одну
 * функцию changeStatus: внизу «Р-… → Ремонт · Отменить», у «Готов» —
 * предложение SMS клиенту, как в карточке.
 */

export interface MenuOrder {
  id: string;
  number: string;
  status: { id: string; name: string; group: StatusGroup };
  masterId: string | null;
  isUrgent: boolean;
  /** Ремонт окончен (есть «Готов»): акт работ, выдача. */
  completed: boolean;
  issued: boolean;
  phone?: string | null;
}

export const menuFromBoard = (c: BoardCard): MenuOrder => ({
  id: c.id,
  number: c.number,
  status: c.status,
  masterId: c.master?.id ?? null,
  isUrgent: c.isUrgent,
  completed: c.status.group === "DONE",
  issued: false,
});

export const menuFromOrder = (o: Order): MenuOrder => ({
  id: o.id,
  number: o.number,
  status: o.status,
  masterId: o.assignedMaster?.id ?? null,
  isUrgent: o.isUrgent,
  completed: !!o.completedAt,
  issued: !!o.issuedAt,
  phone: o.customer.phone ?? null,
});

type Dialog =
  | { kind: "peek"; o: MenuOrder }
  | { kind: "print"; o: MenuOrder; doc: "intake" | "act" }
  | { kind: "labels"; order: Order }
  | { kind: "edit"; order: Order }
  | { kind: "sms"; o: MenuOrder; sms: "free" | "ready" }
  | { kind: "photo"; o: MenuOrder }
  | { kind: "issue"; o: MenuOrder }
  | { kind: "delete"; o: MenuOrder };

interface Open {
  o: MenuOrder;
  x: number;
  y: number;
  /** Телефон: лист снизу вместо меню у курсора. */
  sheet: boolean;
}

interface Toast {
  text: string;
  tone?: "error";
  undo?: () => void;
}

const LONG_PRESS = 550;

export function useOrderMenu({ onChanged }: { onChanged: () => unknown }) {
  const { can, me } = useAuth();
  const navigate = useNavigate();
  const myId = me?.kind === "tenant" ? me.user.id : null;
  const [ref, setRef] = useState<Reference | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  useEffect(() => {
    ordersApi.reference().then(setRef).catch(() => undefined);
  }, []);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = useCallback((t: Toast) => {
    setToast(t);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), t.undo ? 7000 : 4000);
  }, []);
  useEffect(() => () => void (toastTimer.current && clearTimeout(toastTimer.current)), []);

  const fail = useCallback((err: unknown, fallback: string) => say({ text: err instanceof ApiError ? err.message : fallback, tone: "error" }), [say]);

  const canStatus = useCallback(
    (o: Pick<MenuOrder, "masterId">) => can("orders.status") || (can("orders.status.own") && !!myId && o.masterId === myId),
    [can, myId]
  );

  /**
   * Сменить статус. note — дописать к подсказке по тому, что вернула
   * перезагрузка (на доске: «в колонке не видно — скрыт фильтром»).
   */
  const changeStatus = useCallback(
    async (o: MenuOrder, to: OrderStatus, opts: { note?: (reloaded: unknown) => string | null } = {}) => {
      if (to.id === o.status.id) return;
      try {
        const res = (await ordersApi.setStatus(o.id, to.id)) as { sms?: ReadyHint; warn?: string } | undefined;
        const reloaded = await changed.current();
        const sms = res?.sms;
        const extra = [
          sms && "auto" in sms ? "SMS клиенту отправляется" : null,
          // «Готов» без диагноза: не мешаем, но говорим.
          res?.warn ? "диагноз не заполнен" : null,
          opts.note?.(reloaded) ?? null,
        ]
          .filter(Boolean)
          .join(" · ");
        const from = o.status;
        say({
          text: `${o.number} → ${to.name}${extra ? ` · ${extra}` : ""}`,
          undo: () => {
            setToast(null);
            ordersApi
              .setStatus(o.id, from.id)
              .then(() => changed.current())
              .then(() => say({ text: `${o.number} — снова «${from.name}»` }))
              .catch((err) => fail(err, "Не удалось вернуть статус"));
          },
        });
        if (sms && "offer" in sms) setDialog({ kind: "sms", o: { ...o, status: to }, sms: "ready" });
      } catch (err) {
        await changed.current();
        fail(err, "Не удалось сменить статус");
      }
    },
    [say, fail]
  );

  // ---------------------------------------------------------------- как открывается

  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  const lastPointer = useRef("mouse");

  const show = useCallback((o: MenuOrder, x: number, y: number, sheet: boolean) => {
    setOpen({ o, x, y, sheet });
  }, []);

  /** Обработчики для элемента заказа: правая кнопка, долгое нажатие, кнопка «⋯». */
  const bind = useCallback(
    (o: MenuOrder) => ({
      onContextMenu: (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const touch = lastPointer.current === "touch" || lastPointer.current === "pen";
        if (touch) {
          // Android присылает contextmenu на долгое нажатие — лист уже открыт таймером или откроется сейчас.
          if (press.current) clearTimeout(press.current.timer);
          press.current = null;
          suppressClick.current = true;
          show(o, 0, 0, true);
          return;
        }
        show(o, e.clientX, e.clientY, false);
      },
      onPointerDown: (e: React.PointerEvent) => {
        lastPointer.current = e.pointerType;
        if (e.pointerType === "mouse") return;
        if (press.current) clearTimeout(press.current.timer);
        const x = e.clientX, y = e.clientY;
        press.current = {
          x,
          y,
          timer: setTimeout(() => {
            press.current = null;
            suppressClick.current = true;
            navigator.vibrate?.(12);
            show(o, x, y, true);
          }, LONG_PRESS),
        };
      },
      onPointerMove: (e: React.PointerEvent) => {
        const p = press.current;
        if (p && Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y) > 10) {
          clearTimeout(p.timer);
          press.current = null;
        }
      },
      onPointerUp: () => {
        if (press.current) clearTimeout(press.current.timer);
        press.current = null;
      },
      onPointerCancel: () => {
        if (press.current) clearTimeout(press.current.timer);
        press.current = null;
      },
      onClickCapture: (e: React.MouseEvent) => {
        // Долгое нажатие открыло лист — отпускание пальца не должно ещё и открыть заказ.
        if (suppressClick.current) {
          suppressClick.current = false;
          e.preventDefault();
          e.stopPropagation();
        }
      },
      style: { WebkitTouchCallout: "none" } as React.CSSProperties,
    }),
    [show]
  );

  /** Кнопка «⋯»: меню под кнопкой (на телефоне — листом). */
  const openFrom = useCallback(
    (o: MenuOrder, e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const sheet = !window.matchMedia("(min-width: 640px)").matches;
      show(o, r.right, r.bottom + 4, sheet);
    },
    [show]
  );

  // ---------------------------------------------------------------- окна

  async function withOrder(id: string, then: (o: Order) => void) {
    try {
      then(await ordersApi.get(id));
    } catch (err) {
      fail(err, "Не удалось открыть заказ");
    }
  }

  const done = (text: string) => {
    setDialog(null);
    void Promise.resolve(changed.current()).then(() => say({ text }));
  };

  const dialogs: ReactNode = dialog && (
    <>
      {dialog.kind === "peek" && <OrderPeek orderId={dialog.o.id} onClose={() => setDialog(null)} />}
      {dialog.kind === "print" && (
        <PrintDialog orderId={dialog.o.id} number={dialog.o.number} doc={dialog.doc} onClose={() => setDialog(null)} />
      )}
      {dialog.kind === "labels" && <LabelDialog order={dialog.order} onClose={() => setDialog(null)} />}
      {dialog.kind === "edit" && ref && (
        <OrderEditModal order={dialog.order} reference={ref} onClose={() => setDialog(null)} onSaved={() => done(`${dialog.order.number} — изменения сохранены`)} />
      )}
      {dialog.kind === "sms" && (
        <SmsModal orderId={dialog.o.id} kind={dialog.sms} onClose={() => setDialog(null)} onSent={() => done(`${dialog.o.number} — SMS клиенту отправлена`)} />
      )}
      {dialog.kind === "photo" && (
        <PhotoShooter
          orderId={dialog.o.id}
          defaultKind={dialog.o.completed ? "COMPLETION" : "INTAKE"}
          onClose={() => setDialog(null)}
          onDone={(n) => done(`${dialog.o.number} — ${n === 1 ? "снимок загружен" : `загружено снимков: ${n}`}`)}
        />
      )}
      {dialog.kind === "issue" && (
        <IssueDialog
          orderId={dialog.o.id}
          onClose={() => setDialog(null)}
          onIssue={async (payment) => {
            await ordersApi.issue(dialog.o.id, { payment });
            done(`${dialog.o.number} выдан клиенту`);
          }}
        />
      )}
      {dialog.kind === "delete" && (
        <DeleteDialog
          o={dialog.o}
          onClose={() => setDialog(null)}
          onDeleted={() => done(`Заказ ${dialog.o.number} удалён`)}
        />
      )}
    </>
  );

  const element = (
    <>
      {open && (
        <OrderMenu
          key={open.o.id + open.x + open.y}
          at={open}
          reference={ref}
          canStatus={canStatus(open.o)}
          onClose={() => setOpen(null)}
          act={(a) => {
            const o = open.o;
            setOpen(null);
            switch (a.kind) {
              case "open":
                return navigate(`/orders/${o.id}`);
              case "peek":
              case "photo":
              case "issue":
              case "delete":
                return setDialog({ kind: a.kind, o });
              case "print":
                return setDialog({ kind: "print", o, doc: a.doc });
              case "sms":
                return setDialog({ kind: "sms", o, sms: "free" });
              case "labels":
                return void withOrder(o.id, (order) => setDialog({ kind: "labels", order }));
              case "edit":
                return void withOrder(o.id, (order) => setDialog({ kind: "edit", order }));
              case "status":
                return void changeStatus(o, a.status);
              case "master":
                return void ordersApi
                  .assignMaster(o.id, a.masterId)
                  .then(() => changed.current())
                  .then(() => say({ text: `${o.number} — ${a.masterId ? `мастер: ${a.name}` : "мастер снят"}` }))
                  .catch((err) => fail(err, "Не удалось назначить мастера"));
              case "urgent":
                return void ordersApi
                  .update(o.id, { isUrgent: !o.isUrgent })
                  .then(() => changed.current())
                  .then(() =>
                    say({
                      text: `${o.number} — ${o.isUrgent ? "больше не срочный" : "срочный"}`,
                      undo: () => {
                        setToast(null);
                        ordersApi
                          .update(o.id, { isUrgent: o.isUrgent })
                          .then(() => changed.current())
                          .catch((err) => fail(err, "Не получилось"));
                      },
                    })
                  )
                  .catch((err) => fail(err, "Не получилось"));
              case "copy":
                return void copyText(o.number).then((ok) => say({ text: ok ? `Скопировано: ${o.number}` : "Не удалось скопировать", tone: ok ? undefined : "error" }));
              case "repeat":
                return navigate("/orders/new", { state: { repeatFrom: o.id } });
            }
          }}
          perms={{
            edit: can("orders.edit"),
            work: can("orders.edit") || (!!myId && open.o.masterId === myId),
            del: can("orders.delete"),
            issue: can("orders.issue") && open.o.completed && !open.o.issued,
            repeat: can("orders.create"),
          }}
        />
      )}
      {dialogs}
      {toast && (
        <div
          role="status"
          data-order-toast
          className={
            "fixed bottom-24 left-1/2 z-[95] flex max-w-[94vw] -translate-x-1/2 items-center gap-3 rounded-[18px] px-4 py-2 text-[13.5px] font-semibold shadow-raised sm:bottom-6 " +
            (toast.tone === "error" ? "bg-state-off text-white" : "bg-ink text-surface")
          }
        >
          <span className="line-clamp-2 min-w-0">{toast.text}</span>
          {toast.undo && (
            <button type="button" onClick={toast.undo} className="shrink-0 rounded-pill px-2 py-0.5 font-bold text-brand underline-offset-2 hover:underline">
              Отменить
            </button>
          )}
        </div>
      )}
    </>
  );

  return { bind, openFrom, element, changeStatus, canStatus, reference: ref, say };
}

// ---------------------------------------------------------------- само меню

type Action =
  | { kind: "open" | "peek" | "labels" | "edit" | "sms" | "photo" | "issue" | "delete" | "urgent" | "copy" | "repeat" }
  | { kind: "print"; doc: "intake" | "act" }
  | { kind: "status"; status: OrderStatus }
  | { kind: "master"; masterId: string | null; name: string };

const GROUP_LABEL: Partial<Record<StatusGroup, string>> = {
  NEW: "Диагностика",
  WAITING: "Согласование",
  IN_PROGRESS: "Ремонт",
  DONE: "Выдача",
};

function OrderMenu({
  at,
  reference,
  canStatus,
  perms,
  act,
  onClose,
}: {
  at: Open;
  reference: Reference | null;
  canStatus: boolean;
  perms: { edit: boolean; work: boolean; del: boolean; issue: boolean; repeat: boolean };
  act: (a: Action) => void;
  onClose: () => void;
}) {
  const o = at.o;
  const [view, setView] = useState<"main" | "status" | "master">("main");
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: at.x, top: at.y, ready: at.sheet });
  const [sms, setSms] = useState<boolean | null>(null);

  // SMS — только если подключены, есть право и телефон: спрашиваем сервер при открытии.
  useEffect(() => {
    let live = true;
    smsApi
      .order(o.id)
      .then((d) => live && setSms(d.enabled && d.canSend && d.hasPhone))
      .catch(() => live && setSms(false));
    return () => {
      live = false;
    };
  }, [o.id]);

  // У края окна — открываемся влево и вверх.
  useLayoutEffect(() => {
    if (at.sheet || !box.current) return;
    const r = box.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(at.x + 2, window.innerWidth - r.width - 8));
    const top = at.y + r.height + 8 > window.innerHeight ? Math.max(8, at.y - r.height - 2) : at.y + 4;
    setPos({ left, top, ready: true });
  }, [at, view, sms]);

  // Фокус — на первый пункт, когда меню уже видно (невидимое фокус не принимает).
  useEffect(() => {
    // На телефоне — без фокуса: подсвеченный первый пункт под пальцем выглядит как уже нажатый.
    if (!pos.ready || at.sheet) return;
    box.current?.querySelector<HTMLElement>("[role^=menuitem]:not([disabled])")?.focus({ preventScroll: true });
  }, [view, pos.ready, at.sheet]);

  useEffect(() => {
    const down = (e: Event) => {
      if (box.current?.contains(e.target as Node)) return;
      onClose();
    };
    const opened = Date.now();
    const close = () => onClose();
    // Прокрутка закрывает меню, но не та, что ещё доезжает от щелчка, открывшего его.
    const scrolled = () => Date.now() - opened > 200 && onClose();
    // Esc — и когда фокус ушёл из меню (щёлкнули мимо пункта, но внутри меню).
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !box.current?.contains(document.activeElement)) onClose();
    };
    document.addEventListener("keydown", key);
    document.addEventListener("mousedown", down);
    document.addEventListener("touchstart", down);
    if (!at.sheet) window.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("keydown", key);
      document.removeEventListener("mousedown", down);
      document.removeEventListener("touchstart", down);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [at.sheet, onClose]);

  function onKey(e: React.KeyboardEvent) {
    const items = [...(box.current?.querySelectorAll<HTMLElement>("[role^=menuitem]:not([disabled])") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      if (view !== "main") setView("main");
      else onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === "ArrowRight" && (document.activeElement as HTMLElement)?.dataset.sub) {
      e.preventDefault();
      (document.activeElement as HTMLElement).click();
    } else if (e.key === "ArrowLeft" && view !== "main") {
      e.preventDefault();
      setView("main");
    }
  }

  const big = at.sheet;
  const Sep = Separator;
  const ico = "h-[17px] w-[17px]";

  const statuses = (reference?.statuses ?? []).filter((s) => s.group !== "CLOSED" && s.group !== "CANCELLED");

  let body: ReactNode;
  if (view === "status") {
    let lastGroup: StatusGroup | null = null;
    body = (
      <>
        <MenuItem big={big} icon={<IconChevronLeft className={ico} />} onClick={() => setView("main")}>
          Статус
        </MenuItem>
        <Sep />
        {statuses.map((s) => {
          const head = s.group !== lastGroup ? GROUP_LABEL[s.group] : null;
          lastGroup = s.group;
          return (
            <div key={s.id}>
              {head && <p className={"px-3 pb-0.5 pt-1.5 text-[11px] font-bold uppercase tracking-wide text-ink-dim " + (big ? "px-4" : "")}>{head}</p>}
              <MenuItem big={big} checked={s.id === o.status.id} onClick={() => (s.id === o.status.id ? onClose() : act({ kind: "status", status: s }))}>
                {s.name}
              </MenuItem>
            </div>
          );
        })}
        <p className={"px-3 pb-1 pt-1.5 text-[11.5px] leading-snug text-ink-dim " + (big ? "px-4" : "")}>
          Выдают клиенту — из карточки заказа: там оплата.
        </p>
      </>
    );
  } else if (view === "master") {
    body = (
      <>
        <MenuItem big={big} icon={<IconChevronLeft className={ico} />} onClick={() => setView("main")}>
          Мастер
        </MenuItem>
        <Sep />
        <MenuItem big={big} checked={!o.masterId} onClick={() => act({ kind: "master", masterId: null, name: "" })}>
          Не назначен
        </MenuItem>
        {(reference?.masters ?? []).map((m) => (
          <MenuItem big={big} key={m.id} checked={m.id === o.masterId} onClick={() => act({ kind: "master", masterId: m.id, name: m.fullName })}>
            {masterLabel(m)}
          </MenuItem>
        ))}
      </>
    );
  } else {
    body = (
      <>
        <MenuItem big={big} icon={<IconOrders className={ico} />} onClick={() => act({ kind: "open" })} >
          Открыть заказ
        </MenuItem>
        <MenuItem big={big} icon={<IconSearch className={ico} />} onClick={() => act({ kind: "peek" })}>
          Быстрый просмотр
        </MenuItem>
        <Sep />
        {canStatus && (
          <MenuItem big={big} icon={<IconStatusProgress className={ico} />} sub disabled={!reference} onClick={() => setView("status")} hint={o.status.name}>
            Статус
          </MenuItem>
        )}
        {perms.edit && (
          <MenuItem big={big} icon={<IconPerson className={ico} />} sub disabled={!reference} onClick={() => setView("master")}>
            Мастер
          </MenuItem>
        )}
        {perms.edit && (
          <MenuItem big={big} icon={<IconUrgent className={ico} />} onClick={() => act({ kind: "urgent" })}>
            {o.isUrgent ? "Снять «срочный»" : "Сделать срочным"}
          </MenuItem>
        )}
        {perms.edit && (
          <MenuItem big={big} icon={<IconEdit className={ico} />} disabled={!reference} onClick={() => act({ kind: "edit" })}>
            Изменить…
          </MenuItem>
        )}
        {perms.work && (
          <MenuItem big={big} icon={<IconCamera className={ico} />} onClick={() => act({ kind: "photo" })}>
            Добавить фото…
          </MenuItem>
        )}
        {(canStatus || perms.edit || perms.work) && <Sep />}
        <MenuItem big={big} icon={<IconPrint className={ico} />} onClick={() => act({ kind: "print", doc: "intake" })}>
          Квитанция…
        </MenuItem>
        <MenuItem big={big} icon={<IconPrint className={ico} />} onClick={() => act({ kind: "labels" })}>
          Наклейки…
        </MenuItem>
        {o.completed && (
          <MenuItem big={big} icon={<IconPrint className={ico} />} onClick={() => act({ kind: "print", doc: "act" })}>
            Акт работ…
          </MenuItem>
        )}
        {sms && (
          <MenuItem big={big} icon={<IconSms className={ico} />} onClick={() => act({ kind: "sms" })}>
            SMS клиенту…
          </MenuItem>
        )}
        {big && o.phone && (
          <a
            role="menuitem"
            href={`tel:${o.phone}`}
            onClick={onClose}
            className="flex min-h-[48px] w-full items-center gap-2.5 px-4 text-left text-[15px] text-ink hover:bg-surface-input"
          >
            <span className="flex w-[18px] shrink-0 justify-center text-ink-dim">
              <PhoneIcon />
            </span>
            Позвонить клиенту
          </a>
        )}
        <MenuItem big={big} icon={<CopyIcon />} onClick={() => act({ kind: "copy" })}>
          Копировать номер
        </MenuItem>
        {(perms.issue || perms.repeat) && <Sep />}
        {perms.issue && (
          <MenuItem big={big} icon={<IconOrders className={ico} />} onClick={() => act({ kind: "issue" })}>
            Выдать клиенту…
          </MenuItem>
        )}
        {perms.repeat && (
          <MenuItem big={big} icon={<IconPlus className={ico} />} onClick={() => act({ kind: "repeat" })}>
            Принять снова — та же техника
          </MenuItem>
        )}
        {perms.del && (
          <>
            <Sep />
            <MenuItem big={big} icon={<IconDelete className={ico} />} danger onClick={() => act({ kind: "delete" })}>
              Удалить заказ…
            </MenuItem>
          </>
        )}
      </>
    );
  }

  if (at.sheet) {
    return (
      <div className="fixed inset-0 z-[70] flex items-end bg-[rgba(6,8,13,.55)]" onContextMenu={(e) => e.preventDefault()}>
        <div
          ref={box}
          role="menu"
          aria-label={`Заказ ${o.number}`}
          onKeyDown={onKey}
          className="max-h-[85vh] w-full overflow-y-auto rounded-t-panel border-t border-line bg-surface-raised pb-[max(12px,env(safe-area-inset-bottom))] pt-2 shadow-modal"
        >
          <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-1">
            <p className="min-w-0 truncate font-mono text-[15px] font-bold">{o.number}</p>
            <span className="shrink-0 text-[12.5px] text-ink-dim">{o.status.name}</span>
          </div>
          <Sep />
          {body}
          <div className="px-4 pt-2">
            <Button type="button" variant="secondary" className="w-full" onClick={onClose}>
              Закрыть
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={box}
      role="menu"
      aria-label={`Заказ ${o.number}`}
      onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[90] max-h-[calc(100vh-16px)] w-[264px] overflow-y-auto rounded-field border border-line bg-surface-raised py-1 shadow-raised"
      style={{ left: pos.left, top: pos.top, visibility: pos.ready ? "visible" : "hidden" }}
    >
      <p className="truncate px-3 pb-1 pt-1 font-mono text-[12px] font-semibold text-ink-dim">{o.number}</p>
      {body}
    </div>
  );
}

interface ItemProps {
  icon?: ReactNode;
  children: ReactNode;
  onClick: () => void;
  sub?: boolean;
  danger?: boolean;
  checked?: boolean;
  hint?: string;
  disabled?: boolean;
}

function MenuItem({ icon, children, onClick, sub, danger, checked, hint, disabled, big }: ItemProps & { big: boolean }) {
  return (
    <button
      type="button"
      role={checked === undefined ? "menuitem" : "menuitemradio"}
      aria-checked={checked}
      data-sub={sub ? "1" : undefined}
      disabled={disabled}
      onClick={onClick}
      className={
        "flex w-full items-center gap-2.5 text-left transition-colors duration-100 hover:bg-surface-input focus:bg-surface-input focus:outline-none disabled:opacity-45 disabled:hover:bg-transparent " +
        (big ? "min-h-[48px] px-4 text-[15px] " : "px-3 py-[7px] text-[13.5px] ") +
        (danger ? "text-state-off" : "text-ink")
      }
    >
      <span className={"flex w-[18px] shrink-0 justify-center " + (danger ? "" : "text-ink-dim")}>
        {checked !== undefined ? (checked ? <Check /> : null) : icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="max-w-[45%] shrink-0 truncate text-[12px] text-ink-dim">{hint}</span>}
      {sub && <IconChevronRight className="h-4 w-4 shrink-0 text-ink-dim" />}
    </button>
  );
}

const Separator = () => <div role="separator" className="my-1 border-t border-line" />;

// ---------------------------------------------------------------- удаление

function DeleteDialog({ o, onClose, onDeleted }: { o: MenuOrder; onClose: () => void; onDeleted: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`Удалить заказ ${o.number}`} onClose={onClose}>
      <p className="text-[13.5px] text-ink-muted">
        Заказ уйдёт из списков и с доски. Списанные запчасти и движения по кассе останутся на месте — их поправляют в своих
        разделах.
      </p>
      <div className="mt-4">
        <Field label="Причина" hint="Останется в журнале — через полгода это будет единственное объяснение">
          <Input value={reason} autoFocus onChange={(e) => setReason(e.target.value)} placeholder="Завели по ошибке, дубль заказа" />
        </Field>
      </div>
      {error && (
        <div className="mt-3">
          <Banner tone="error">{error}</Banner>
        </div>
      )}
      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="secondary" onClick={onClose}>
          Отмена
        </Button>
        <Button
          type="button"
          variant="danger"
          disabled={busy || reason.trim().length < 3}
          onClick={() => {
            setBusy(true);
            setError(null);
            ordersApi
              .remove(o.id, reason.trim())
              .then(onDeleted)
              .catch((err) => {
                setError(err instanceof ApiError ? err.message : "Не удалось удалить заказ");
                setBusy(false);
              });
          }}
        >
          Удалить
        </Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- значки

function Check() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className="h-4 w-4 text-brand" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 10.5l3.5 3.5 7.5-8" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className="h-[16px] w-[16px]" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="7" y="7" width="10" height="10" rx="2" />
      <path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="h-[17px] w-[17px]" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 4h3l1.5 4-2 1.5a11 11 0 0 0 5 5l1.5-2 4 1.5v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />
    </svg>
  );
}
