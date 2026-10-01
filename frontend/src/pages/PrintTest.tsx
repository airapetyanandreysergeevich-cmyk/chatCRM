import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { isStationPage, STATION_READY } from "../lib/printing";

/**
 * Тестовая страница принтера: «Назначить» → «Тестовая страница» в
 * «Настройки → Периферия». Печатает её программа FineCRM на компьютере с
 * принтером, без окна печати. На листе — что, куда и когда, чтобы по
 * бумажке было видно, тот ли принтер выбран.
 */
export default function PrintTest() {
  const [params] = useSearchParams();
  const { me } = useAuth();
  const printer = params.get("printer") ?? "";
  const pc = params.get("pc") ?? "";
  const workshop = me?.kind === "tenant" ? (me.tenant?.name ?? "") : "";

  useEffect(() => {
    if (!isStationPage()) return;
    requestAnimationFrame(() => requestAnimationFrame(() => (document.title = STATION_READY)));
  }, []);

  const now = new Date().toLocaleString("ru-RU", { dateStyle: "long", timeStyle: "short" });

  return (
    <div className="min-h-screen bg-white p-[14mm] text-black">
      <div className="mx-auto max-w-[180mm]">
        <p className="text-[12px] uppercase tracking-[0.2em] text-black/60">FineCRM</p>
        <h1 className="mt-2 text-[28px] font-extrabold">Тестовая страница</h1>
        <p className="mt-3 text-[15px]">Если вы читаете этот лист, принтер настроен и CRM печатает на него.</p>
        <table className="mt-8 w-full border-collapse text-[14px]">
          <tbody>
            {[
              ["Мастерская", workshop || "—"],
              ["Принтер", printer || "—"],
              ["Компьютер", pc || "—"],
              ["Напечатано", now],
            ].map(([k, v]) => (
              <tr key={k} className="border-b border-black/20">
                <td className="w-[45mm] py-2 pr-4 text-black/60">{k}</td>
                <td className="py-2 font-semibold">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {/* Шкала и плашки: по ним видно, не обрезает ли принтер края и не бледнит ли. */}
        <div className="mt-10 grid grid-cols-4 gap-3">
          {["#000000", "#555555", "#999999", "#DDDDDD"].map((c) => (
            <div key={c} className="h-[18mm] rounded-[3px] border border-black/30" style={{ background: c }} />
          ))}
        </div>
        <p className="mt-10 text-[12px] text-black/60">
          Отключить или сменить принтер — «Настройки → Периферия» в FineCRM.
        </p>
      </div>
    </div>
  );
}
