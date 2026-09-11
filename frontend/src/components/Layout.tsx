import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { BrandMark, BrandRow } from "./Brand";
import { InstallAppBanner } from "./InstallApp";
import {
  IconAdmins,
  IconApplications,
  IconBell,
  IconCash,
  IconChevronLeft,
  IconChevronRight,
  IconClients,
  IconDashboard,
  IconJournal,
  IconLogout,
  IconMore,
  IconOrders,
  IconPurchases,
  IconSettings,
  IconStaff,
  IconStock,
  IconWorkshops,
} from "./icons";

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  badge?: number;
}

/** Красный счётчик непрочитанного. */
function Badge({ count }: { count: number }) {
  return (
    <span className="inline-flex h-[20px] min-w-[20px] items-center justify-center rounded-full bg-state-off px-1.5 text-[11px] font-bold text-white">
      {count > 99 ? "99+" : count}
    </span>
  );
}

export default function Layout() {
  const { me, can, logout, applyToken } = useAuth();
  const [pending, setPending] = useState(0);
  const [unread, setUnread] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const location = useLocation();

  /**
   * Свёрнутое меню — это выбор рабочего места, а не настройка учётной записи:
   * на ноутбуке приёмщика место на экране дороже подписей, на большом мониторе
   * мастерской — наоборот. Поэтому выбор живёт в этом браузере и никуда не
   * уезжает вместе с человеком.
   */
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("sidebar:collapsed") === "1";
    } catch {
      // Приватное окно или запрещённые данные сайта — меню просто развёрнуто.
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("sidebar:collapsed", collapsed ? "1" : "0");
    } catch {
      /* не сохранилось — переживём, это всего лишь ширина меню */
    }
  }, [collapsed]);

  // Меню «Ещё» закрывается при переходе: иначе оно накрывает страницу,
  // на которую только что нажали.
  useEffect(() => setMoreOpen(false), [location.pathname]);

  const isPlatformPanel = me?.kind === "platform" && !me.impersonating;
  useEffect(() => {
    if (!isPlatformPanel) return;
    let alive = true;
    const load = () =>
      api
        .get<{ pendingApplications: number }>("/platform/summary")
        .then((s) => alive && setPending(s.pendingApplications))
        .catch(() => undefined);
    void load();
    // Уведомление пока живёт внутри системы, поэтому счётчик обновляем сами.
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [isPlatformPanel]);

  const inWorkshopNow = me?.kind === "tenant" || (me?.kind === "platform" && !!me.impersonating);
  useEffect(() => {
    if (!inWorkshopNow) return;
    let alive = true;
    const load = () =>
      api
        .get<{ unread: number }>("/notifications")
        .then((r) => alive && setUnread(r.unread))
        .catch(() => undefined);
    void load();
    // Push доносит оповещение мгновенно, но он есть не у всех и не всегда.
    // Счётчик в меню — тот канал, который работает у любого сотрудника.
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [inWorkshopNow]);

  if (!me) return null;

  const impersonating = me.kind === "platform" ? me.impersonating : null;
  const inWorkshop = me.kind === "tenant" || !!impersonating;

  const workshopNav: NavItem[] = [
    { to: "/", label: "Сводка", icon: <IconDashboard /> },
    { to: "/orders", label: "Заказы", icon: <IconOrders /> },
    { to: "/clients", label: "Клиенты", icon: <IconClients /> },
    { to: "/stock", label: "Склад", icon: <IconStock /> },
    { to: "/purchases", label: "Закупки", icon: <IconPurchases /> },
    { to: "/finance", label: "Касса", icon: <IconCash /> },
    { to: "/staff", label: "Сотрудники", icon: <IconStaff /> },
    { to: "/settings", label: "Настройки", icon: <IconSettings /> },
  ].filter((i) => {
    if (i.to === "/clients") return can("customers.view", "customers.edit");
    if (i.to === "/stock") return can("stock.view");
    if (i.to === "/purchases") return can("purchases.view", "purchases.create");
    if (i.to === "/finance") return can("finance.view", "finance.payment", "finance.manage");
    if (i.to === "/staff") return can("staff.manage");
    // «Настройки» видны всем: внутри у каждого своё — мастеру только
    // оповещения, владельцу ещё и базы.
    if (i.to === "/settings") return true;
    if (i.to === "/orders")
      return can("orders.view.all", "orders.view.assigned", "orders.view.delivery");
    return true;
  });

  const platformNav: NavItem[] = [
    { to: "/platform/tenants", label: "Мастерские", icon: <IconWorkshops /> },
    { to: "/platform/applications", label: "Заявки", icon: <IconApplications />, badge: pending },
    { to: "/platform/admins", label: "Администраторы", icon: <IconAdmins /> },
    { to: "/platform/audit", label: "Журнал", icon: <IconJournal /> },
    { to: "/settings/notifications", label: "Оповещения", icon: <IconBell /> },
  ];

  // Оповещения переехали в «Настройки», но лента нужна всем и часто —
  // мастеру в том числе, а настройки ему недоступны. Поэтому колокольчик
  // живёт отдельной кнопкой: в боковом меню сверху и в шапке телефона.
  const items = inWorkshop ? workshopNav : platformNav;
  // На телефоне в ряд помещается четыре подписи. Пятой кнопкой открываем
  // остальные списком: горизонтальная прокрутка внизу экрана не работает —
  // о том, что там что-то есть, никто не догадывается.
  const bottomItems = items.slice(0, 4);
  const restItems = items.slice(4);
  const title = me.kind === "tenant" ? (me.tenant?.name ?? "Мастерская") : (impersonating?.name ?? "Платформа");
  const subtitle =
    me.kind === "tenant"
      ? (me.user.role?.name ?? (me.user.isOwner ? "владелец" : "сотрудник"))
      : me.platformUser.fullName;

  async function stopImpersonation() {
    const data = await api.post<{ accessToken: string }>("/platform/impersonate/stop");
    await applyToken(data.accessToken);
  }

  const sideLink = ({ isActive }: { isActive: boolean }) =>
    "group relative flex h-11 items-center rounded-field text-[14.5px] font-medium " +
    "transition-all duration-150 " +
    (collapsed ? "justify-center px-0" : "gap-3 px-3") +
    " " +
    (isActive
      ? "bg-brand-tint text-brand-ink font-semibold"
      : "text-ink-muted hover:bg-surface-raised hover:text-ink");

  return (
    <div className="min-h-full bg-bg">
      <InstallAppBanner />
      {impersonating && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#3A3320] bg-[#221E12] px-5 py-2.5 text-[13px] font-medium text-[#E4BE7C]">
          <span>
            Вы в мастерской «{impersonating.name}» от лица платформы. Действия записываются в журнал.
          </span>
          <button onClick={() => void stopImpersonation()} className="font-bold underline underline-offset-2">
            Вернуться в панель
          </button>
        </div>
      )}

      <div className="lg:flex">
        <aside
          className={
            "hidden shrink-0 border-r border-line bg-surface p-3 transition-[width] duration-200 lg:flex lg:min-h-screen lg:flex-col " +
            (collapsed ? "w-[76px] items-center" : "w-[240px]")
          }
        >
          <div className={"mb-6 flex items-center gap-2 pt-1.5 " + (collapsed ? "" : "justify-between px-1.5")}>
            {collapsed ? <BrandMark size={34} /> : <BrandRow />}
            {!collapsed && (
              <NavLink
                to="/settings/notifications"
                aria-label="Оповещения"
                className={({ isActive }) =>
                  "relative flex h-9 w-9 shrink-0 items-center justify-center rounded-field transition-colors duration-150 " +
                  (isActive ? "bg-brand-tint text-brand" : "text-ink-muted hover:bg-surface-raised hover:text-ink")
                }
              >
                <IconBell className="h-[18px] w-[18px]" />
                {!!unread && (
                  <span className="absolute -right-1 -top-1">
                    <Badge count={unread} />
                  </span>
                )}
              </NavLink>
            )}
          </div>

          <nav className={"space-y-1 " + (collapsed ? "w-[52px]" : "")}>
            {/* Свёрнутое меню — это ряд значков без подписей, поэтому
                колокольчик встаёт в тот же ряд: отдельная кнопка сверху
                в узкой полосе выглядит потерянной. */}
            {collapsed && (
              <NavLink to="/settings/notifications" className={sideLink} title="Оповещения">
                <span className="relative [&>svg]:h-[19px] [&>svg]:w-[19px]">
                  <IconBell />
                  {!!unread && (
                    <span className="absolute -right-2.5 -top-1.5">
                      <Badge count={unread} />
                    </span>
                  )}
                </span>
              </NavLink>
            )}

            {items.map((i) => (
              <NavLink
                key={i.to}
                to={i.to}
                end={i.to === "/"}
                className={sideLink}
                // В свёрнутом виде подпись остаётся только подсказкой: без неё
                // ряд одинаковых значков приходится разгадывать.
                title={collapsed ? i.label : undefined}
              >
                {({ isActive }) => (
                  <>
                    <span
                      className={
                        "absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r bg-brand transition-opacity duration-150 " +
                        (isActive ? "opacity-100" : "opacity-0")
                      }
                    />
                    <span className="relative [&>svg]:h-[19px] [&>svg]:w-[19px] [&>svg]:transition-transform [&>svg]:duration-150 group-hover:[&>svg]:scale-110">
                      {i.icon}
                      {collapsed && !!i.badge && (
                        <span className="absolute -right-2.5 -top-1.5">
                          <Badge count={i.badge} />
                        </span>
                      )}
                    </span>
                    {!collapsed && (
                      <>
                        <span className="flex-1">{i.label}</span>
                        {!!i.badge && <Badge count={i.badge} />}
                      </>
                    )}
                  </>
                )}
              </NavLink>
            ))}
          </nav>

          <div className={"mt-auto border-t border-line pt-3 " + (collapsed ? "w-[52px]" : "w-full")}>
            <button
              onClick={() => setCollapsed((v) => !v)}
              aria-label={collapsed ? "Развернуть меню" : "Свернуть меню"}
              title={collapsed ? "Развернуть меню" : "Свернуть меню"}
              className={
                "flex h-10 items-center rounded-field text-[13.5px] font-medium text-ink-dim transition-colors duration-150 hover:bg-surface-raised hover:text-ink " +
                (collapsed ? "w-full justify-center" : "w-full gap-3 px-3")
              }
            >
              {collapsed ? (
                <IconChevronRight className="h-[18px] w-[18px]" />
              ) : (
                <>
                  <IconChevronLeft className="h-[18px] w-[18px]" />
                  Свернуть меню
                </>
              )}
            </button>

            {!collapsed && (
              <div className="px-2 pb-2 pt-1">
                <p className="truncate text-[13.5px] font-semibold">{title}</p>
                <p className="truncate text-[12px] text-ink-dim">{subtitle}</p>
              </div>
            )}

            <button
              onClick={() => void logout()}
              aria-label="Выйти"
              title={collapsed ? "Выйти" : undefined}
              className={
                "flex h-10 items-center rounded-field text-[14px] font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-raised hover:text-ink " +
                (collapsed ? "w-full justify-center" : "w-full gap-3 px-3")
              }
            >
              <IconLogout className="h-[18px] w-[18px]" />
              {!collapsed && "Выйти"}
            </button>
          </div>
        </aside>

        <div className="flex min-h-screen min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between border-b border-line bg-surface px-4 py-2.5 lg:hidden">
            <BrandRow />
            <div className="flex items-center gap-1">
              <NavLink
                to="/settings/notifications"
                className={({ isActive }) =>
                  "relative flex h-9 w-9 items-center justify-center rounded-field transition-colors duration-150 " +
                  (isActive ? "bg-brand-tint text-brand" : "text-ink-muted hover:bg-surface-raised")
                }
                aria-label="Оповещения"
              >
                <IconBell className="h-[18px] w-[18px]" />
                {!!unread && (
                  <span className="absolute -right-1 -top-1">
                    <Badge count={unread} />
                  </span>
                )}
              </NavLink>
              <button
              onClick={() => void logout()}
              className="flex h-9 items-center gap-2 rounded-field px-3 text-[13px] font-medium text-ink-muted transition-colors duration-150 hover:bg-surface-raised"
            >
                <IconLogout className="h-[17px] w-[17px]" />
                Выйти
              </button>
            </div>
          </header>

          <main className="flex-1 p-4 pb-28 sm:p-6 lg:p-8 lg:pb-8">
            <div className="mx-auto max-w-[1240px]">
              <Outlet />
            </div>
          </main>

          {moreOpen && (
            <button
              type="button"
              aria-label="Закрыть меню"
              onClick={() => setMoreOpen(false)}
              className="fixed inset-0 z-40 bg-black/55 lg:hidden"
            />
          )}

          {moreOpen && restItems.length > 0 && (
            <div className="fixed inset-x-0 bottom-[calc(74px+env(safe-area-inset-bottom))] z-50 mx-3 overflow-hidden rounded-panel border border-line bg-surface shadow-modal lg:hidden">
              {restItems.map((i) => (
                <NavLink
                  key={i.to}
                  to={i.to}
                  end={i.to === "/"}
                  className={({ isActive }) =>
                    "flex min-h-[52px] items-center gap-3 border-b border-line px-4 text-[15px] font-medium last:border-b-0 " +
                    (isActive ? "bg-brand-tint text-brand-ink" : "text-ink")
                  }
                >
                  <span className="[&>svg]:h-[20px] [&>svg]:w-[20px]">{i.icon}</span>
                  <span className="flex-1">{i.label}</span>
                  {!!i.badge && <Badge count={i.badge} />}
                </NavLink>
              ))}
            </div>
          )}

          <nav className="fixed inset-x-0 bottom-0 z-50 flex border-t border-line bg-surface px-1 pb-[max(10px,env(safe-area-inset-bottom))] pt-2 lg:hidden">
            {bottomItems.map((i) => (
              <NavLink
                key={i.to}
                to={i.to}
                end={i.to === "/"}
                className={({ isActive }) =>
                  "flex flex-1 flex-col items-center gap-1 rounded-field py-1.5 text-[10.5px] font-medium transition-colors duration-150 " +
                  (isActive && !moreOpen ? "text-brand" : "text-ink-dim")
                }
              >
                <span className="relative [&>svg]:h-[21px] [&>svg]:w-[21px]">
                  {i.icon}
                  {!!i.badge && (
                    <span className="absolute -right-2.5 -top-1.5">
                      <Badge count={i.badge} />
                    </span>
                  )}
                </span>
                {i.label}
              </NavLink>
            ))}

            {restItems.length > 0 && (
              <button
                type="button"
                onClick={() => setMoreOpen((v) => !v)}
                aria-expanded={moreOpen}
                className={
                  "flex flex-1 flex-col items-center gap-1 rounded-field py-1.5 text-[10.5px] font-medium transition-colors duration-150 " +
                  (moreOpen || restItems.some((i) => i.to === location.pathname) ? "text-brand" : "text-ink-dim")
                }
              >
                <span className="relative [&>svg]:h-[21px] [&>svg]:w-[21px]">
                  <IconMore />
                  {restItems.some((i) => !!i.badge) && (
                    <span className="absolute -right-2.5 -top-1.5">
                      <Badge count={restItems.reduce((n, i) => n + (i.badge ?? 0), 0)} />
                    </span>
                  )}
                </span>
                Ещё
              </button>
            )}
          </nav>
        </div>
      </div>
    </div>
  );
}
