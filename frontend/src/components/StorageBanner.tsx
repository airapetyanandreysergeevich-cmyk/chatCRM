import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { bytes } from "../lib/platformApi";

interface StorageInfo {
  usedBytes: number;
  limitMb: number;
  share: number;
  warn: boolean;
  full: boolean;
}

/**
 * Место для фотографий в облаке заканчивается — полоса владельцу.
 *
 * С 90% — предупреждение заранее, на 100% — что новые снимки не загрузятся.
 * Уже загруженное при этом цело. В локальной версии сервер отвечает null:
 * диск свой, и лимита нет.
 */
export function StorageBanner() {
  const { me } = useAuth();
  const isOwner = me?.kind === "tenant" && me.user.isOwner;
  const [info, setInfo] = useState<StorageInfo | null>(null);

  useEffect(() => {
    if (!isOwner) return;
    let alive = true;
    api
      .get<StorageInfo | null>("/settings/storage")
      .then((s) => alive && setInfo(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [isOwner]);

  if (!isOwner || !info?.warn) return null;
  const limit = bytes(info.limitMb * 1024 * 1024);

  return (
    <div
      role="status"
      className={
        "border-b px-4 py-2.5 text-[13.5px] sm:px-5 " +
        (info.full ? "border-state-off/30 bg-state-off/10" : "border-state-waiting/30 bg-state-waiting/10")
      }
    >
      <span className={"font-semibold " + (info.full ? "text-state-off" : "text-state-waiting")}>
        {info.full ? "Место для фотографий закончилось." : "Место для фотографий почти закончилось."}
      </span>{" "}
      <span className="text-ink-soft">
        Занято {bytes(info.usedBytes)} из {limit}.{" "}
        {info.full
          ? "Новые снимки не загрузятся, уже загруженные целы. Чтобы добавить место, напишите нам: «Настройки → Обратная связь»."
          : "Когда место кончится, новые снимки перестанут загружаться. Добавить место можно, написав нам: «Настройки → Обратная связь»."}
      </span>
    </div>
  );
}
