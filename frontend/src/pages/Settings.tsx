import { Link } from "react-router-dom";
import { IconBell, IconDatabase } from "../components/icons";
import { Card, PageHeader } from "../components/ui";
import { useAuth } from "../lib/auth";

interface Section {
  to: string;
  title: string;
  text: string;
  icon: React.ReactNode;
  /** Пусто — доступно всем. */
  need?: string;
}

const SECTIONS: Section[] = [
  {
    to: "/settings/notifications",
    title: "Оповещения",
    text: "Что приходит на телефон, кому и о чём. Здесь же включается приложение на этом устройстве.",
    icon: <IconBell />,
  },
  {
    to: "/settings/data",
    title: "Базы",
    text: "Выгрузить клиентов, заказы и склад в Excel или CSV. Загрузить свои данные из файла.",
    icon: <IconDatabase />,
    need: "settings.manage",
  },
];

export default function Settings() {
  const { can } = useAuth();
  // Раздел виден всем, но внутри у каждого своё: мастеру — только
  // оповещения, владельцу ещё и базы. Показывать недоступное с замочком
  // бессмысленно: сотрудник всё равно ничего с этим не сделает.
  const visible = SECTIONS.filter((s) => !s.need || can(s.need));

  return (
    <div className="space-y-5">
      <PageHeader eyebrow="Мастерская" title="Настройки" />

      <div className="grid gap-3 sm:grid-cols-2">
        {visible.map((s) => (
          <Link key={s.to} to={s.to} className="block">
            <Card interactive className="h-full p-4">
              <div className="flex items-start gap-3.5">
                <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-field bg-surface-raised text-ink-muted [&>svg]:h-[19px] [&>svg]:w-[19px]">
                  {s.icon}
                </span>
                <span className="min-w-0">
                  <span className="block text-[16px] font-bold">{s.title}</span>
                  <span className="mt-1 block text-[13.5px] leading-relaxed text-ink-muted">
                    {s.text}
                  </span>
                </span>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
