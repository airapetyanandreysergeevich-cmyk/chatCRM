import { IconPurchases } from "../components/icons";
import { SectionShell } from "./Section";

export default function Purchases() {
  return (
    <SectionShell
      eyebrow="Мастерская"
      title="Закупки"
      subtitle="Заявки мастеров на запчасти и расходники, согласование и приход."
      actionLabel="Новая заявка"
      searchPlaceholder="Поиск по позиции или номеру заявки"
      icon={<IconPurchases />}
      emptyTitle="Заявок нет"
      emptyText="Мастер создаёт заявку прямо из заказа, управляющий согласовывает. После получения позиции встают на склад и резервируются под тот заказ, ради которого их покупали."
    />
  );
}
