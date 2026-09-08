import { IconClients } from "../components/icons";
import { SectionShell } from "./Section";

export default function Clients() {
  return (
    <SectionShell
      eyebrow="Мастерская"
      title="Клиенты"
      subtitle="Карточки клиентов, их техника и история обращений."
      actionLabel="Новый клиент"
      searchPlaceholder="Поиск по имени, телефону или технике"
      icon={<IconClients />}
      emptyTitle="Клиентов пока нет"
      emptyText="Клиент заводится сам при приёме техники — отдельно создавать его не нужно. Здесь будет вся история: какие аппараты приносил, что чинили, что на гарантии."
    />
  );
}
