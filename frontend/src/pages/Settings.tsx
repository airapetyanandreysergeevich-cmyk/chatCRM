import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { IconBell, IconDatabase, IconFeedback, IconPalette, IconServices, IconGlobe } from "../components/icons";
import { Card, PageHeader } from "../components/ui";
import { useAuth } from "../lib/auth";
import { ordersApi } from "../lib/orders";

interface Section {
  to: string;
  title: string;
  text: string;
  icon: React.ReactNode;
  /** Пусто — доступно всем. */
  need?: string;
  /**
   * Только владельцу мастерской. Это не право, которое можно выдать: адресат
   * обращения один, и разбирать он должен то, за чем кто-то стоит. Сотрудник
   * со своим замечанием идёт к владельцу.
   */
  ownerOnly?: boolean;
  /** Только в коробочной версии — в облаке такого раздела нет. */
  boxOnly?: boolean;
}

const SECTIONS: Section[] = [
  {
    to: "/settings/notifications",
    title: "Оповещения",
    text: "Что приходит на телефон, кому и о чём. Здесь же включается приложение на этом устройстве.",
    icon: <IconBell />,
  },
  {
    to: "/settings/interface",
    title: "Интерфейс",
    text: "Светлая или тёмная тема и цвета мастерской: стадии заказа, фон, панели, кнопки.",
    icon: <IconPalette />,
  },
  {
    to: "/settings/services",
    title: "Услуги",
    text: "Прайс мастерской: что делаем и почём. Отсюда подставляются названия и цены в выполненные работы.",
    icon: <IconServices />,
    need: "settings.manage",
  },
  {
    to: "/settings/data",
    title: "Базы",
    text: "Выгрузить клиентов, заказы, склад и прайс в Excel или CSV. Загрузить свои данные из файла.",
    icon: <IconDatabase />,
    need: "settings.manage",
  },
  {
    to: "/settings/remote-access",
    title: "Доступ из интернета",
    text: "Чтобы заходить в свою Основу не только из мастерской: с телефона, из дома, из второй точки.",
    icon: <IconGlobe />,
    need: "settings.manage",
    // Только в коробочной версии: облачная мастерская и так открыта по своему адресу.
    boxOnly: true,
  },
  {
    to: "/settings/feedback",
    title: "Обратная связь",
    text: "Написать разработчику: что мешает, чего не хватает, что сломалось. Ответа в программе не будет.",
    icon: <IconFeedback />,
    ownerOnly: true,
  },
];

export default function Settings() {
  const { can, me } = useAuth();
  const isOwner = me?.kind === "tenant" && me.user.isOwner;
  // Раздел виден всем, но внутри у каждого своё: мастеру — только
  // оповещения, владельцу ещё и базы. Показывать недоступное с замочком
  // бессмысленно: сотрудник всё равно ничего с этим не сделает.
  // Коробочная это версия или облачная, знает сервер — по нему и решаем.
  const [isBox, setIsBox] = useState(false);
  useEffect(() => {
    ordersApi
      .reference()
      .then((r) => setIsBox(Boolean(r.features.remoteAccess)))
      .catch(() => setIsBox(false));
  }, []);

  const visible = SECTIONS.filter(
    (s) => (!s.need || can(s.need)) && (!s.ownerOnly || isOwner) && (!s.boxOnly || isBox)
  );

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
