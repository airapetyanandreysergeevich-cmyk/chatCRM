import { useState } from "react";
import { url } from "../lib/basePath";

/**
 * Значок магазина: картинку отдаёт наш сервер (/api/parts/logo/<код>), сам
 * браузер на сайт магазина не ходит. Значка нет или он не загрузился —
 * первая буква названия на цветной плашке; цвет постоянный для магазина.
 */
export function ShopLogo({ id, name, size = 28 }: { id: string; name: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const box = { width: size, height: size };
  if (failed) {
    let h = 0;
    for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return (
      <span
        aria-hidden="true"
        data-shop-logo="letter"
        className="inline-flex shrink-0 items-center justify-center rounded-[7px] font-extrabold text-white"
        style={{ ...box, background: `hsl(${h} 55% 42%)`, fontSize: Math.round(size * 0.5) }}
      >
        {name.replace(/^[^0-9A-Za-zА-Яа-яЁё]+/, "").charAt(0).toUpperCase() || "?"}
      </span>
    );
  }
  return (
    <img
      src={url(`api/parts/logo/${encodeURIComponent(id)}`)}
      alt=""
      aria-hidden="true"
      data-shop-logo="img"
      loading="lazy"
      width={size}
      height={size}
      onError={() => setFailed(true)}
      onLoad={() => setLoaded(true)}
      // Белая подложка — только под загруженный значок: пустой белый квадрат выглядит поломкой.
      className={"shrink-0 rounded-[7px] object-contain p-[3px] " + (loaded ? "bg-white" : "bg-surface-raised")}
      style={box}
    />
  );
}
