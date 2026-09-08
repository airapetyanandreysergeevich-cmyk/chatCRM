import { IconStock } from "../components/icons";
import { SectionShell } from "./Section";

export default function Stock() {
  return (
    <SectionShell
      eyebrow="Мастерская"
      title="Склад"
      subtitle="Остатки запчастей и расходников, приход и списание в заказы."
      actionLabel="Приход"
      searchPlaceholder="Поиск по названию или артикулу"
      icon={<IconStock />}
      emptyTitle="На складе пусто"
      emptyText="Запчасти появятся здесь после первого прихода. Списание в заказ будет уменьшать остаток автоматически, а при падении ниже минимума позиция подсветится."
    />
  );
}
