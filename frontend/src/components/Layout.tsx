import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button } from "./ui";

interface NavItem {
  to: string;
  label: string;
  badge?: number;
}

/** Красный счётчик непросмотренного — тот самый «уведомление внутри системы». */
function Badge({ count }: { count: number }) {
  return (
    <span className="inline-flex h-[22px] min-w-[22px] items-center justify-center rounded-full bg-[#E35555] px-1.5 text-[12px] font-extrabold text-white">
      {count > 99 ? "99+" : count}
    </span>
  );
}

export default function Layout() {
  const { me, logout, applyToken } = useAuth();
  const [pending, setPending] = useState(0);

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
    // Уведомление пока живёт внутри системы, поэтому счётчик подтягиваем сам.
    const timer = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [isPlatformPanel]);

  if (!me) return null;

  const impersonating = me.kind === "platform" ? me.impersonating : null;
  const inTenant = me.kind === "tenant" || !!impersonating;

  const items: NavItem[] = inTenant
    ? [
        { to: "/", label: "Сводка" },
        { to: "/orders", label: "Заказы" },
        { to: "/staff", label: "Сотрудники" },
      ]
    : [
        { to: "/platform/tenants", label: "Мастерские" },
        { to: "/platform/applications", label: "Заявки", badge: pending },
        { to: "/platform/admins", label: "Администраторы" },
        { to: "/platform/audit", label: "Журнал" },
      ];

  const title = me.kind === "tenant" ? (me.tenant?.name ?? "Мастерская") : (impersonating?.name ?? "Платформа");
  const subtitle =
    me.kind === "tenant" ? (me.user.role?.name ?? (me.user.isOwner ? "владелец" : "сотрудник")) : me.platformUser.fullName;

  async function stopImpersonation() {
    const data = await api.post<{ accessToken: string }>("/platform/impersonate/stop");
    await applyToken(data.accessToken);
  }

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    "flex h-11 items-center rounded-[10px] px-3 text-[15px] font-semibold transition " +
    (isActive ? "bg-primary-tint text-primary-ink font-bold" : "text-ink-soft hover:bg-surface-muted");

  return (
    <div className="min-h-full bg-canvas">
      {impersonating && (
        <div className="flex flex-wrap items-center justify-between gap-3 bg-sun px-5 py-2.5 text-sm font-bold text-sun-ink">
          <span>Вы работаете в мастерской «{impersonating.name}» от лица платформы. Действия записываются в журнал.</span>
          <button onClick={() => void stopImpersonation()} className="underline underline-offset-2">
            Вернуться в панель платформы
          </button>
        </div>
      )}

      <div className="lg:flex">
        <aside className="hidden w-[220px] shrink-0 border-r border-line bg-surface p-4 lg:flex lg:min-h-screen lg:flex-col">
          <div className="mb-6 flex items-center gap-2.5 px-1">
            <div className="h-9 w-9 rounded-[10px] bg-primary" />
            <span className="font-extrabold tracking-tight">RepairShop</span>
          </div>
          <nav className="space-y-1">
            {items.map((i) => (
              <NavLink key={i.to} to={i.to} end={i.to === "/"} className={linkClass}>
                <span className="flex-1">{i.label}</span>
                {!!i.badge && <Badge count={i.badge} />}
              </NavLink>
            ))}
          </nav>
          <div className="mt-auto border-t border-line pt-4">
            <p className="truncate px-1 text-sm font-bold">{title}</p>
            <p className="truncate px-1 text-xs text-ink-muted">{subtitle}</p>
            <Button variant="ghost" className="mt-2 w-full px-3 text-sm" onClick={() => void logout()}>
              Выйти
            </Button>
          </div>
        </aside>

        <div className="flex min-h-screen flex-1 flex-col">
          <header className="flex items-center justify-between border-b border-line bg-surface px-5 py-3 lg:hidden">
            <div className="min-w-0">
              <p className="truncate font-bold">{title}</p>
              <p className="truncate text-xs text-ink-muted">{subtitle}</p>
            </div>
            <Button variant="ghost" className="px-3 text-sm" onClick={() => void logout()}>
              Выйти
            </Button>
          </header>

          <main className="flex-1 p-5 pb-24 sm:p-7 lg:pb-7">
            <Outlet />
          </main>

          <nav
            className="fixed inset-x-0 bottom-0 grid border-t border-line bg-surface px-2 pb-4 pt-2 lg:hidden"
            style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
          >
            {items.map((i) => (
              <NavLink
                key={i.to}
                to={i.to}
                end={i.to === "/"}
                className={({ isActive }) =>
                  "flex flex-col items-center gap-1 rounded-xl py-1.5 text-[11px] font-semibold " +
                  (isActive ? "text-primary" : "text-ink-muted")
                }
              >
                {({ isActive }) => (
                  <>
                    <span className="relative">
                      <span className={"block h-6 w-6 rounded-lg " + (isActive ? "bg-primary" : "bg-[#DCD3C5]")} />
                      {!!i.badge && (
                        <span className="absolute -right-2.5 -top-1.5">
                          <Badge count={i.badge} />
                        </span>
                      )}
                    </span>
                    {i.label}
                  </>
                )}
              </NavLink>
            ))}
          </nav>
        </div>
      </div>
    </div>
  );
}
