import { useCallback, useEffect, useState } from "react";
import { IconClients } from "../components/icons";
import { Banner, Card, EmptyState, PageHeader, SearchInput, Spinner } from "../components/ui";
import { ApiError, api } from "../lib/api";
import { formatDate, plural } from "../lib/format";

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
        <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {rows.map((c) => (
            <Card key={c.id} interactive className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="truncate text-[16px] font-bold">{c.name}</h2>
                  <a href={`tel:${c.phone}`} className="mt-1 block text-[14px] font-semibold text-brand">
                    {c.phone}
                  </a>
                </div>
                {c.type === "COMPANY" && (
                  <span className="rounded-pill bg-surface-raised px-2.5 py-1 text-[11.5px] font-semibold text-ink-muted">
                    организация
                  </span>
                )}
              </div>

              <div className="mt-3.5 flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3 text-[12.5px] text-ink-dim">
                <span>{plural(c.orderCount, "заказ", "заказа", "заказов")}</span>
                <span>{plural(c.deviceCount, "аппарат", "аппарата", "аппаратов")}</span>
                <span className="ml-auto">с {formatDate(c.createdAt)}</span>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
