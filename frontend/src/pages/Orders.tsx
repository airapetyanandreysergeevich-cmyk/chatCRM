import { IconOrders } from "../components/icons";
import { SectionShell } from "./Section";

export default function Orders() {
  return (
    <SectionShell
      eyebrow="Мастерская"
      title="Заказы"
      subtitle="Приём техники, работа мастера, выдача клиенту."
      actionLabel="Принять технику"
      searchPlaceholder="Поиск по номеру, клиенту или технике"
      icon={<IconOrders />}
      emptyTitle="Заказов пока нет"
      emptyText="Здесь появятся ремонты: бланк приёма с комплектностью и фотографиями, работа мастера, статусы от диагностики до выдачи."
    />
  );
}
