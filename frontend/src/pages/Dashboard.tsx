import { Card, EmptyState, PageHeader, SectionLabel } from "../components/ui";
import { IconClients, IconOrders, IconPurchases, IconStock } from "../components/icons";
import { useAuth } from "../lib/auth";

/**
 * Сводка мастерской. Цифр пока нет по-честному: API отчётов ещё не собран,
 * и рисовать правдоподобные числа нельзя — по ним начнут принимать решения.
 */
const TILES = [
  { label: "В работе", hint: "заказы в ремонте", icon: <IconOrders /> },
  { label: "Ждут выдачи", hint: "готовы, но не забраны", icon: <IconClients /> },
  { label: "Ожидают запчасть", hint: "остановлены до поставки", icon: <IconStock /> },
  { label: "Заявки на закупку", hint: "ждут согласования", icon: <IconPurchases /> },
];

export default function Dashboard() {
  const { me } = useAuth();
  const name = me?.kind === "tenant" ? me.user.fullName.split(" ")[0] : "";

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Мастерская"
        title={name ? `Здравствуйте, ${name}` : "Сводка"}
        subtitle="Здесь будет вся картина дня: что в работе, что готово, что тормозит."
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {TILES.map((t) => (
          <Card key={t.label} interactive className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[34px] font-extrabold leading-none tracking-tight text-ink-dim">—</p>
                <p className="mt-2.5 text-[14px] font-semibold">{t.label}</p>
                <p className="mt-0.5 text-[12.5px] text-ink-dim">{t.hint}</p>
              </div>
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-card bg-surface-raised text-ink-muted [&>svg]:h-[18px] [&>svg]:w-[18px]">
                {t.icon}
              </span>
            </div>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <Card>
          <SectionLabel>Последние заказы</SectionLabel>
          <div className="mt-4 flex min-h-[180px] items-center justify-center rounded-card border border-dashed border-line text-sm text-ink-dim">
            Появятся, как только приёмщик заведёт первый заказ
          </div>
        </Card>
        <Card>
          <SectionLabel>События</SectionLabel>
          <div className="mt-4 flex min-h-[180px] items-center justify-center rounded-card border border-dashed border-line text-sm text-ink-dim">
            Смены статусов, согласования, закупки
          </div>
        </Card>
      </div>

      <EmptyState title="Раздел заполняется">
        Каркас сводки готов, но считать пока нечего: приём заказов и склад ещё собираются.
        Цифры здесь появятся вместе с ними — выдумывать их заранее я не стал.
      </EmptyState>
    </div>
  );
}
