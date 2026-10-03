import { useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import qrcode from "qrcode-generator";
import { code128Bars, moduleWidth, type LabelSettings } from "../lib/labels";

/**
 * Одна наклейка — в миллиметрах, чёрным по белому.
 *
 * Термопринтер печатает только чёрное: никаких серых подписей и тонких
 * линий, иерархия — размером и жирностью. Размеры шрифта считаются от
 * этикетки: на 30×20 мм и на 100×50 мм наклейка остаётся читаемой.
 *
 * «Повернуть» поворачивает содержимое на 90°, а лист остаётся размером с
 * этикетку: так печатают, когда рулон идёт в принтер узкой стороной вперёд.
 */

export interface LabelData {
  workshop: string;
  /** Логотип мастерской, уже чёрно-белый (lib/labels → monoLogo). */
  logo?: string | null;
  number: string;
  /** Цифры номера — содержимое штрихкода. */
  code: string;
  item: { title: string; index: number; total: number; accessory: boolean } | null;
  client: string;
  phone: string | null;
  device: string;
  serial: string | null;
  complaint: string;
  date: string;
  due: string | null;
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const mm = (v: number) => `${Math.round(v * 100) / 100}mm`;

function Code128({ code, width, height }: { code: string; width: number; height: number }) {
  const { bars, modules } = useMemo(() => code128Bars(code), [code]);
  const m = moduleWidth(modules, width);
  return (
    <svg
      width={mm(modules * m.mm)}
      height={mm(height)}
      viewBox={`0 0 ${modules} 10`}
      preserveAspectRatio="none"
      shapeRendering="crispEdges"
      style={{ display: "block", margin: "0 auto" }}
      aria-label={`Штрихкод ${code}`}
    >
      {bars.map(([x, w]) => (
        <rect key={x} x={x} y={0} width={w} height={10} fill="#000" />
      ))}
    </svg>
  );
}

function QrCode({ code, size }: { code: string; size: number }) {
  const cells = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(code);
    q.make();
    const n = q.getModuleCount();
    const out: Array<[number, number]> = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) out.push([c, r]);
    return { n, out };
  }, [code]);
  const pad = 1;
  return (
    <svg
      width={mm(size)}
      height={mm(size)}
      viewBox={`${-pad} ${-pad} ${cells.n + pad * 2} ${cells.n + pad * 2}`}
      shapeRendering="crispEdges"
      style={{ display: "block", flexShrink: 0 }}
      aria-label={`QR-код ${code}`}
    >
      {cells.out.map(([x, y]) => (
        <rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} fill="#000" />
      ))}
    </svg>
  );
}

/** Ширина модуля штрихкода в точках принтера: меньше двух — сканер может не прочитать. */
export function barcodeDots(settings: LabelSettings, code: string): number {
  const iw = settings.rotate ? settings.height : settings.width;
  const pad = clamp(Math.min(settings.width, settings.height) * 0.045, 1.2, 2.4);
  return moduleWidth(code128Bars(code).modules, iw - pad * 2).dots;
}

export function Label({
  settings,
  data,
  onOverflow,
  className = "",
}: {
  settings: LabelSettings;
  data: LabelData;
  /** Не всё влезло — для подсказки в конструкторе. */
  onOverflow?: (overflow: boolean) => void;
  className?: string;
}) {
  const { width: W, height: H, rotate, fields: f } = settings;
  const iw = rotate ? H : W;
  const ih = rotate ? W : H;
  const pad = clamp(Math.min(W, H) * 0.045, 1.2, 2.4);
  const cw = iw - pad * 2;
  const ch = ih - pad * 2;
  // Рядом с QR-кодом строкам остаётся меньше ширины — «Иванов И. П. · …4567» должен влезть целиком.
  const qrText = settings.code === "qr" ? cw - Math.min(ch, cw * 0.45) - pad : cw;
  const base = clamp(Math.min(ch * 0.08, cw * 0.06, qrText / 11), 1.9, 3.6);
  // Номер крупно, но целиком: на узкой этикетке и рядом с QR-кодом шрифт уменьшается под ширину.
  const qrSide = Math.min(ch, cw * 0.45);
  const textW = settings.code === "qr" ? cw - qrSide - pad : cw;
  const counterW = f.item && data.item && data.item.total > 1 ? base * 1.35 * 2.6 + base : 0;
  const big = Math.max(1.9, Math.min(base * 1.75, (textW - counterW) / (Math.max(6, data.number.length) * 0.62)));
  const small = base * 0.82;
  const lh = 1.18;

  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = body.current;
    if (!el || !onOverflow) return;
    onOverflow(el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
  });

  // Строки не сжимаются: не влезло — значит не влезло (это видно в конструкторе), а не сплющилось.
  const one: CSSProperties = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flexShrink: 0 };
  const many = data.item && data.item.total > 1;
  const counter = f.item && many ? `${data.item!.index}/${data.item!.total}` : null;
  const accessory = f.item && data.item?.accessory ? data.item.title : null;
  const who = [f.client ? data.client : null, f.phone && data.phone ? `…${data.phone}` : null].filter(Boolean).join(" · ");
  const when = [f.date ? `Принят ${data.date}` : null, f.due && data.due ? `Срок ${data.due}` : null].filter(Boolean).join(" · ");

  // Шапка: логотип и название мастерской в одну строку.
  const logoH = clamp(small * 1.5, 2.6, ch * 0.2);
  const showLogo = f.logo && !!data.logo;
  const showName = f.workshop && !!data.workshop;
  const header =
    showLogo || showName ? (
      <div style={{ display: "flex", alignItems: "center", gap: mm(base * 0.6), flexShrink: 0, minWidth: 0 }}>
        {showLogo && (
          <img
            src={data.logo!}
            alt=""
            style={{ height: mm(logoH), maxWidth: showName ? "45%" : "100%", objectFit: "contain", objectPosition: "left center", display: "block", flexShrink: 0 }}
          />
        )}
        {showName && (
          <div style={{ ...one, flexShrink: 1, minWidth: 0, fontSize: mm(small), fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>
            {data.workshop}
          </div>
        )}
      </div>
    ) : null;

  const lines = (
    <>
      {header}
      {(f.number || counter) && (
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: mm(base), flexShrink: 0 }}>
          {f.number ? <div style={{ ...one, flexShrink: 1, minWidth: 0, fontSize: mm(big), fontWeight: 800, letterSpacing: "-0.01em" }}>{data.number}</div> : <span />}
          {counter && <div style={{ fontSize: mm(base * 1.35), fontWeight: 800, whiteSpace: "nowrap" }}>{counter}</div>}
        </div>
      )}
      {accessory && <div style={{ ...one, fontSize: mm(base * 1.15), fontWeight: 800 }}>{accessory}</div>}
      {who && <div style={{ ...one, fontSize: mm(base), fontWeight: 600 }}>{who}</div>}
      {f.device && data.device && <div style={{ ...one, fontSize: mm(base) }}>{data.device}</div>}
      {f.serial && data.serial && <div style={{ ...one, fontSize: mm(small) }}>S/N {data.serial}</div>}
      {f.complaint && data.complaint && (
        <div
          style={{
            fontSize: mm(small),
            overflow: "hidden",
            flexShrink: 0,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
          }}
        >
          {data.complaint}
        </div>
      )}
      {when && <div style={{ ...one, fontSize: mm(small), fontWeight: 600 }}>{when}</div>}
    </>
  );

  const inner: CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    width: mm(iw),
    height: mm(ih),
    padding: mm(pad),
    boxSizing: "border-box",
    transformOrigin: "top left",
    transform: rotate ? "rotate(90deg) translateY(-100%)" : undefined,
  };

  return (
    <div
      className={className}
      style={{ position: "relative", width: mm(W), height: mm(H), overflow: "hidden", background: "#fff", color: "#000", fontFamily: "Inter, Arial, sans-serif", lineHeight: lh }}
    >
      <div style={inner}>
        {settings.code === "qr" ? (
          <div ref={body} style={{ display: "flex", gap: mm(pad), height: "100%", overflow: "hidden" }}>
            <QrCode code={data.code} size={qrSide} />
            <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: mm(base * 0.12) }}>{lines}</div>
          </div>
        ) : (
          <div ref={body} style={{ display: "flex", flexDirection: "column", gap: mm(base * 0.12), height: "100%", overflow: "hidden" }}>
            {header}
            {(f.number || counter) && (
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: mm(base), flexShrink: 0 }}>
                {f.number ? <div style={{ ...one, flexShrink: 1, minWidth: 0, fontSize: mm(big), fontWeight: 800 }}>{data.number}</div> : <span />}
                {counter && <div style={{ fontSize: mm(base * 1.35), fontWeight: 800, whiteSpace: "nowrap" }}>{counter}</div>}
              </div>
            )}
            <div style={{ flexShrink: 0 }}>
              <Code128 code={data.code} width={cw} height={clamp(ch * 0.27, 5, 14)} />
              {!f.number && <div style={{ textAlign: "center", fontSize: mm(small), fontWeight: 600, letterSpacing: "0.08em" }}>{data.code}</div>}
            </div>
            {accessory && <div style={{ ...one, fontSize: mm(base * 1.15), fontWeight: 800 }}>{accessory}</div>}
            {who && <div style={{ ...one, fontSize: mm(base), fontWeight: 600 }}>{who}</div>}
            {f.device && data.device && <div style={{ ...one, fontSize: mm(base) }}>{data.device}</div>}
            {f.serial && data.serial && <div style={{ ...one, fontSize: mm(small) }}>S/N {data.serial}</div>}
            {f.complaint && data.complaint && (
              <div style={{ fontSize: mm(small), overflow: "hidden", flexShrink: 0, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                {data.complaint}
              </div>
            )}
            {when && <div style={{ ...one, fontSize: mm(small), fontWeight: 600 }}>{when}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
