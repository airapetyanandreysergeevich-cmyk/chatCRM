/**
 * Коллекция значков для ярлыков заказов («Индивидуальные оповещения»).
 *
 * На сервере хранится только ключ (`phone`, `clock`…): нарисовать значок —
 * дело интерфейса, а новый значок в коллекции не требует ни миграции, ни
 * правки сервера. Незнакомый ключ (старая программа, удалённый значок)
 * рисуется флажком — ярлык не пропадает с экрана.
 *
 * Значки — простые линии 24×24, одной толщины, чтобы в кружке 22 пикселя
 * читались одинаково.
 */

export const LABEL_ICONS: Record<string, { title: string; d: string }> = {
  phone: { title: "Телефон", d: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>' },
  clock: { title: "Часы", d: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>' },
  alert: { title: "Внимание", d: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/>' },
  truck: { title: "Доставка", d: '<path d="M1 4h14v12H1zM15 8h4l3 3v5h-7"/><circle cx="5.5" cy="18" r="2"/><circle cx="18.5" cy="18" r="2"/>' },
  coin: { title: "Деньги", d: '<circle cx="12" cy="12" r="9"/><path d="M10 7h3a2.5 2.5 0 0 1 0 5h-3V7zm0 5v5m-2-2.5h5"/>' },
  chat: { title: "Сообщение", d: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' },
  star: { title: "Звезда", d: '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/>' },
  wrench: { title: "Ремонт", d: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z"/>' },
  box: { title: "Коробка", d: '<path d="m21 8-9-5-9 5 9 5 9-5zM3 8v8l9 5 9-5V8M12 13v8"/>' },
  question: { title: "Вопрос", d: '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>' },
  flag: { title: "Флажок", d: '<path d="M4 22V4s1-1 4-1 5 2 8 2 4-1 4-1v11s-1 1-4 1-5-2-8-2-4 1-4 1"/>' },
  bell: { title: "Колокольчик", d: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>' },
  user: { title: "Человек", d: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>' },
  camera: { title: "Фото", d: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>' },
  lock: { title: "Замок", d: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>' },
  cart: { title: "Покупка", d: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M1 2h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/>' },
  fire: { title: "Срочно", d: '<path d="M12 22c4 0 7-3 7-7 0-5-5-8-5-12-3 2-6 6-6 9-1-1-2-2-2-4-2 2-3 4-3 7 0 4 3 7 9 7z"/>' },
  eye: { title: "Присмотреть", d: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>' },
  mail: { title: "Письмо", d: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/>' },
  hourglass: { title: "Ожидание", d: '<path d="M6 2h12M6 22h12M7 2v4l5 6-5 6v4M17 2v4l-5 6 5 6v4"/>' },
  battery: { title: "Батарея", d: '<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 11v2M6 10v4M10 10v4"/>' },
  cpu: { title: "Чип", d: '<rect x="6" y="6" width="12" height="12" rx="1"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>' },
  drop: { title: "Вода", d: '<path d="M12 2.7 6.3 8.4a8 8 0 1 0 11.4 0z"/>' },
  zap: { title: "Питание", d: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>' },
  pause: { title: "Пауза", d: '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>' },
  cross: { title: "Отказ", d: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>' },
  check: { title: "Готово", d: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>' },
  calendar: { title: "Дата", d: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>' },
  pin: { title: "Место", d: '<path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>' },
  tag: { title: "Ценник", d: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"/><circle cx="7" cy="7" r="1.5"/>' },
  shield: { title: "Гарантия", d: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>' },
  thumb: { title: "Одобрено", d: '<path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.3a2 2 0 0 0 2-1.7l1.4-9A2 2 0 0 0 19.7 9z"/>' },
  monitor: { title: "Монитор", d: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>' },
  hdd: { title: "Диск", d: '<rect x="2" y="12" width="20" height="8" rx="2"/><path d="M5.5 5 2 12h20l-3.5-7zM6 16h.01M10 16h.01"/>' },
  hand: { title: "Стоп", d: '<path d="M18 11V6a2 2 0 0 0-4 0M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.4l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>' },
  key: { title: "Ключ", d: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3M16 7l3 3M14 9l2 2"/>' },
};

/** Цвета ярлыков — те же, что у стадий и меток, плюс нейтральный. */
export const LABEL_COLORS = ["#2F8FE0", "#20A39E", "#45C08A", "#9BC53D", "#E8A94B", "#F08A5D", "#E0475E", "#E85AA8", "#B48CF0", "#6B7A99"];

export function LabelGlyph({ icon, className = "" }: { icon: string; className?: string }) {
  const d = (LABEL_ICONS[icon] ?? LABEL_ICONS.flag).d;
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.1}
      strokeLinecap="round"
      strokeLinejoin="round"
      dangerouslySetInnerHTML={{ __html: d }}
    />
  );
}

const SIZE = {
  sm: "h-[22px] w-[22px] [&>svg]:h-3 [&>svg]:w-3",
  md: "h-[26px] w-[26px] [&>svg]:h-[14px] [&>svg]:w-[14px]",
  lg: "h-10 w-10 [&>svg]:h-5 [&>svg]:w-5",
} as const;

/** Ярлык: значок в цветном кружке. title — подсказка при наведении. */
export function LabelDot({
  icon,
  color,
  size = "sm",
  title,
  className = "",
}: {
  icon: string;
  color: string;
  size?: keyof typeof SIZE;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      role={title ? "img" : undefined}
      aria-label={title}
      className={"inline-flex shrink-0 items-center justify-center rounded-full text-white " + SIZE[size] + " " + className}
      style={{ background: color, boxShadow: `inset 0 0 0 1px rgb(255 255 255 / .18), 0 0 10px -3px ${color}` }}
    >
      <LabelGlyph icon={icon} />
    </span>
  );
}
