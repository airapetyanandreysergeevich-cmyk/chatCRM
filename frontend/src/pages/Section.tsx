import type { ReactNode } from "react";
import { Button, Card, EmptyState, PageHeader, SearchInput } from "../components/ui";
import { IconPlus } from "../components/icons";

/**
 * Каркас раздела, который ещё не подключён к API.
 * Показываем настоящую структуру экрана и честно говорим, что данных пока нет —
 * так видно, куда всё встанет, и никто не принимает выдуманные цифры за настоящие.
 */
export function SectionShell({
  eyebrow,
  title,
  subtitle,
  actionLabel,
  searchPlaceholder,
  icon,
  emptyTitle,
  emptyText,
}: {
  eyebrow: string;
  title: string;
  subtitle: string;
  actionLabel: string;
  searchPlaceholder: string;
  icon: ReactNode;
  emptyTitle: string;
  emptyText: string;
}) {
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        subtitle={subtitle}
        actions={
          <Button icon={<IconPlus />} disabled title="Раздел ещё не подключён">
            {actionLabel}
          </Button>
        }
      />

      <Card className="p-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <SearchInput placeholder={searchPlaceholder} disabled className="sm:max-w-[340px]" />
        </div>
      </Card>

      <EmptyState icon={icon} title={emptyTitle}>
        {emptyText}
      </EmptyState>
    </div>
  );
}
