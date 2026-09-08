import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Modal } from "../../components/Modal";
import { Banner, Button, Card, Field, Input, SectionLabel, Spinner, StatusChip } from "../../components/ui";
import { ApiError, api } from "../../lib/api";
import { formatDateTime, plural } from "../../lib/format";

type Status = "PENDING" | "APPROVED" | "REJECTED";

interface Application {
  id: string;
  workshopName: string;
  ownerFullName: string;
  ownerEmail: string;
  ownerPhone: string;
  city: string | null;
  comment: string | null;
  status: Status;
  rejectionReason: string | null;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: { fullName: string; email: string } | null;
  tenant: { id: string; name: string; slug: string } | null;
}

const STATUS: Record<Status, { text: string; tone: "waiting" | "done" | "cancelled" }> = {
  PENDING: { text: "На рассмотрении", tone: "waiting" },
  APPROVED: { text: "Одобрена", tone: "done" },
  REJECTED: { text: "Отклонена", tone: "cancelled" },
};

export default function Applications() {
  const [filter, setFilter] = useState<Status | "ALL">("PENDING");
  const [rows, setRows] = useState<Application[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState<Application | null>(null);
  const [rejecting, setRejecting] = useState<Application | null>(null);

  const load = useCallback(async () => {
    setRows(null);
    try {
      setRows(await api.get<Application[]>(`/platform/applications?status=${filter}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить заявки");
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Banner tone="error">{error}</Banner>;

  return (
    <div className="space-y-5">
      <div>
        <SectionLabel>Платформа</SectionLabel>
        <h1 className="mt-1 text-2xl font-extrabold tracking-tight">Заявки на подключение</h1>
      </div>

      <div className="flex flex-wrap gap-2">
        {(
          [
            ["PENDING", "На рассмотрении"],
            ["APPROVED", "Одобренные"],
            ["REJECTED", "Отклонённые"],
            ["ALL", "Все"],
          ] as Array<[Status | "ALL", string]>
        ).map(([value, label]) => (
          <button
            key={value}
            onClick={() => setFilter(value)}
            className={
              "rounded-pill px-4 py-2 text-sm font-bold transition " +
              (filter === value ? "bg-brand text-white" : "bg-surface-raised border border-line text-ink-soft")
            }
          >
            {label}
          </button>
        ))}
      </div>

      {!rows ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <Card>
          <p className="text-ink-muted">
            {filter === "PENDING" ? "Новых заявок нет." : "В этой категории пусто."}
          </p>
        </Card>
      ) : (
        <>
          <p className="text-sm text-ink-muted">{plural(rows.length, "заявка", "заявки", "заявок")}</p>
          <div className="grid gap-3 lg:grid-cols-2">
            {rows.map((a) => (
              <Card key={a.id}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-[17px] font-bold leading-tight">{a.workshopName}</h2>
                    <p className="mt-1 text-sm text-ink-muted">
                      {a.ownerFullName}
                      {a.city ? ` · ${a.city}` : ""}
                    </p>
                  </div>
                  <StatusChip tone={STATUS[a.status].tone}>{STATUS[a.status].text}</StatusChip>
                </div>

                <dl className="mt-4 space-y-1.5 border-t border-line pt-4 text-sm">
                  <div className="flex gap-2">
                    <dt className="w-24 shrink-0 text-ink-muted">Телефон</dt>
                    <dd className="font-bold">
                      <a href={`tel:${a.ownerPhone}`} className="text-brand">
                        {a.ownerPhone}
                      </a>
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-24 shrink-0 text-ink-muted">Email</dt>
                    <dd className="break-all font-bold">{a.ownerEmail}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-24 shrink-0 text-ink-muted">Отправлена</dt>
                    <dd>{formatDateTime(a.createdAt)}</dd>
                  </div>
                  {a.tenant && (
                    <div className="flex gap-2">
                      <dt className="w-24 shrink-0 text-ink-muted">Мастерская</dt>
                      <dd className="font-mono">{a.tenant.slug}</dd>
                    </div>
                  )}
                  {a.rejectionReason && (
                    <div className="flex gap-2">
                      <dt className="w-24 shrink-0 text-ink-muted">Причина</dt>
                      <dd>{a.rejectionReason}</dd>
                    </div>
                  )}
                </dl>

                {a.comment && <p className="mt-3 text-sm text-ink-soft">{a.comment}</p>}

                {a.status === "PENDING" && (
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button className="px-4 text-sm" onClick={() => setApproving(a)}>
                      Одобрить
                    </Button>
                    <Button variant="danger" className="px-4 text-sm" onClick={() => setRejecting(a)}>
                      Отклонить
                    </Button>
                  </div>
                )}
              </Card>
            ))}
          </div>
        </>
      )}

      {approving && (
        <ApproveModal
          application={approving}
          onClose={() => setApproving(null)}
          onDone={() => {
            setApproving(null);
            void load();
          }}
        />
      )}
      {rejecting && (
        <RejectModal
          application={rejecting}
          onClose={() => setRejecting(null)}
          onDone={() => {
            setRejecting(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function ApproveModal({
  application,
  onClose,
  onDone,
}: {
  application: Application;
  onClose: () => void;
  onDone: () => void;
}) {
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/platform/applications/${application.id}/approve`, slug.trim() ? { slug: slug.trim() } : {});
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Подключить «${application.workshopName}»?`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Banner>
          Будет создана мастерская со всей начинкой: филиал, роли, статусы заказов, склад и касса.
          Владелец войдёт по адресу {application.ownerEmail} и паролю, который задал при регистрации.
        </Banner>
        {error && <Banner tone="error">{error.message}</Banner>}
        <Field
          label="Код мастерской"
          error={error?.field("slug")}
          hint="Можно не заполнять — подберётся из названия автоматически"
        >
          <Input value={slug} onChange={(e) => setSlug(e.target.value)} autoCapitalize="none" placeholder="servis-na-lenina" />
        </Field>
        <div className="flex flex-col gap-2 pt-2 sm:flex-row-reverse">
          <Button type="submit" disabled={busy} className="sm:flex-1">
            {busy ? "Подключаем…" : "Одобрить"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} className="sm:flex-1">
            Отмена
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RejectModal({
  application,
  onClose,
  onDone,
}: {
  application: Application;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/platform/applications/${application.id}/reject`, { reason });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "Сервер недоступен"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`Отклонить «${application.workshopName}»?`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {error && <Banner tone="error">{error.message}</Banner>}
        <Field
          label="Причина"
          error={error?.field("reason")}
          hint="Заявитель увидит её, когда попробует войти"
        >
          <Input value={reason} onChange={(e) => setReason(e.target.value)} invalid={!!error?.field("reason")} />
        </Field>
        <div className="flex flex-col gap-2 pt-2 sm:flex-row-reverse">
          <Button type="submit" variant="danger" disabled={busy} className="sm:flex-1">
            {busy ? "Отклоняем…" : "Отклонить"}
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} className="sm:flex-1">
            Отмена
          </Button>
        </div>
      </form>
    </Modal>
  );
}
