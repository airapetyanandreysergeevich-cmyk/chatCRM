import { useCallback, useEffect, useState } from "react";
import { IconClients, IconCompany, IconPerson } from "../components/icons";
import {
  Badge,
  Banner,
  Card,
  EmptyState,
  List,
  ListRow,
  PageHeader,
  SearchInput,
  Spinner,
  StatusGlyph,
} from "../components/ui";
import { ApiError, api } from "../lib/api";
import { formatDateShort, plural } from "../lib/format";

interface Client {
  id: string;
  type: "INDIVIDUAL" | "COMPANY";
  name: string;
  phone: string;
  phone2: string | null;
  email: string | null;
  address: string | null;
  source: string | null;
  createdAt: string;
  orderCount: number;
  deviceCount: number;
}

export default function Clients() {
  const [rows, setRows] = useState<Client[] | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRows(null);
    try {
      const q = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : "";
      setRows(await api.get<Client[]>(`/customers${q}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить клиентов");
    }
  }, [search]);

  useEffect(() => {
    const t = setTimeout(() => void load(), search ? 350 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  if (error) return <Banner tone="error">{error}</Banner>;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Мастерская"
        title="Клиенты"
        subtitle="Карточка заводится сама при приёме техники — отдельно создавать не нужно."
      />

      <Card className="p-3.5">
        <SearchInput
          placeholder="Имя, телефон или email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="sm:max-w-[380px]"
        />
      </Card>

      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <EmptyState icon={<IconClients />} title={search ? "Никого не нашлось" : "Клиентов пока нет"}>
          {search
            ? "Попробуйте другой номер или часть имени."
            : "Первый клиент появится здесь сразу после того, как приёмщик заведёт заказ."}
        </EmptyState>
      ) : (
        <List>
          {rows.map((c) => (
            <ListRow
              key={c.id}
              glyph={
                <StatusGlyph
                  tone={c.type === "COMPANY" ? "new" : "neutral"}
                  title={c.type === "COMPANY" ? "Организация" : "Частное лицо"}
                  icon={c.type === "COMPANY" ? <IconCompany /> : <IconPerson />}
                />
              }
              title={
                <>
                  <span className="truncate">{c.name}</span>
                  {c.type === "COMPANY" && <Badge>организация</Badge>}
                </>
              }
              subtitle={
                <>
                  {/* Позвонить прямо из списка — самое частое действие приёмщика,
                      поэтому телефон здесь ссылка, а не просто текст. */}
                  <a
                    href={`tel:${c.phone}`}
                    onClick={(e) => e.stopPropagation()}
                    className="font-semibold text-brand-ink hover:underline"
                  >
                    {c.phone}
                  </a>
                  {c.email && <span className="text-ink-dim"> · {c.email}</span>}
                </>
              }
              meta={
                <>
                  <span className="whitespace-nowrap lg:w-[100px] lg:text-right">
                    {plural(c.orderCount, "заказ", "заказа", "заказов")}
                  </span>
                  <span className="whitespace-nowrap lg:w-[112px] lg:text-right">
                    {plural(c.deviceCount, "аппарат", "аппарата", "аппаратов")}
                  </span>
                  <span className="whitespace-nowrap lg:w-[104px] lg:text-right">
                    с {formatDateShort(c.createdAt)}
                  </span>
                </>
              }
            />
          ))}
        </List>
      )}

      {rows && rows.length > 0 && (
        <p className="text-[12.5px] text-ink-dim">{plural(rows.length, "клиент", "клиента", "клиентов")} в списке.</p>
      )}
    </div>
  );
}
