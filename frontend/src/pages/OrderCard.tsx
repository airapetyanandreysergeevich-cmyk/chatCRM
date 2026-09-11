import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { IconPlus } from "../components/icons";
import {
  Banner,
  Button,
  Card,
  Field,
  Input,
  SectionLabel,
  Select,
  Spinner,
  StatusChip,
  Textarea,
} from "../components/ui";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { formatDate, formatDateTime } from "../lib/format";
import {
  money,
  ORDER_KIND_LABEL,
  ordersApi,
  PART_SOURCE_LABEL,
  statusTone,
  type Order,
  type OrderPart,
  type OrderWork,
  type Reference,
} from "../lib/orders";

/** Ссылка на файл подписанная и живёт недолго, поэтому запрашиваем её при показе. */
function Photo({ orderId, attachmentId, name }: { orderId: string; attachmentId: string; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    ordersApi
      .attachmentUrl(orderId, attachmentId)
      .then((r) => alive && setUrl(r.url))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [orderId, attachmentId]);

  return (
    <a
      href={url ?? undefined}
      target="_blank"
      rel="noreferrer"
      title={name}
      className="block h-[92px] w-[92px] overflow-hidden rounded-card border border-line bg-surface-input transition-all duration-150 hover:border-line-strong"
    >
      {url ? (
        <img src={url} alt={name} className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full items-center justify-center text-[11px] text-ink-dim">…</span>
      )}
    </a>
  );
}

function Rows({ items }: { items: Array<{ label: string; value: React.ReactNode }> }) {
  return (
    <dl className="space-y-2 text-[14px]">
      {items.map((r) => (
        <div key={r.label} className="flex gap-3">
          <dt className="w-[150px] shrink-0 text-ink-muted">{r.label}</dt>
          <dd className="min-w-0 flex-1">{r.value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

function Checklist({ title, items }: { title: string; items: Array<{ key: string; label: string; checked: boolean }> }) {
  const picked = items.filter((i) => i.checked);
  return (
    <div>
      <p className="text-[13px] font-semibold text-ink-muted">{title}</p>
      {picked.length === 0 ? (
        <p className="mt-1 text-[13.5px] text-ink-dim">ничего не отмечено</p>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {picked.map((i) => (
            <span key={i.key} className="rounded-pill bg-surface-raised px-2.5 py-1 text-[12.5px] text-ink-soft">
              {i.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Редактор строк работ или запчастей: одна и та же таблица с разным набором колонок. */
function LineEditor<T extends OrderWork>({
  title,
  rows,
  setRows,
  empty,
  extraColumn,
  onSave,
  saving,
}: {
  title: string;
  rows: T[];
  setRows: (next: T[]) => void;
  empty: T;
  extraColumn?: (row: T, update: (patch: Partial<T>) => void) => React.ReactNode;
  onSave: () => void;
  saving: boolean;
}) {
  const update = (i: number, patch: Partial<T>) =>
    setRows(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const total = rows.reduce((acc, r) => acc + (Number(r.qty) || 0) * (Number(r.price) || 0), 0);

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <SectionLabel>{title}</SectionLabel>
        <span className="text-[13px] font-semibold text-ink-soft">{money(total)}</span>
      </div>

      <div className="mt-4 space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[1fr_78px_110px_auto] sm:items-center">
            <Input
              value={row.name}
              placeholder="Наименование"
              onChange={(e) => update(i, { name: e.target.value } as Partial<T>)}
            />
            <Input
              inputMode="decimal"
              value={String(row.qty)}
              onChange={(e) => update(i, { qty: Number(e.target.value.replace(",", ".")) || 0 } as Partial<T>)}
            />
            <Input
              inputMode="decimal"
              value={String(row.price)}
              onChange={(e) => update(i, { price: Number(e.target.value.replace(",", ".")) || 0 } as Partial<T>)}
            />
            <div className="flex items-center gap-2">
              {extraColumn?.(row, (patch) => update(i, patch))}
              <Button
                type="button"
                variant="ghost"
                className="min-h-[42px] px-3"
                onClick={() => setRows(rows.filter((_, idx) => idx !== i))}
              >
                Убрать
              </Button>
            </div>
          </div>
        ))}
        {rows.length === 0 && <p className="text-[13.5px] text-ink-dim">Пока ничего не добавлено.</p>}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" variant="secondary" icon={<IconPlus />} onClick={() => setRows([...rows, { ...empty }])}>
          Добавить строку
        </Button>
        <Button type="button" onClick={onSave} disabled={saving}>
          {saving ? "Сохраняем…" : "Сохранить"}
        </Button>
      </div>
    </Card>
  );
}

export default function OrderCard() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { can, me } = useAuth();
  const [order, setOrder] = useState<Order | null>(null);
  const [ref, setRef] = useState<Reference | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [works, setWorks] = useState<OrderWork[]>([]);
  const [parts, setParts] = useState<OrderPart[]>([]);
  const [finish, setFinish] = useState({ diagnosis: "", masterComment: "", recommendation: "", warrantyDays: "" });
  const [returnReason, setReturnReason] = useState<string | null>(null);
  /** null — блок удаления свёрнут, строка — набранная причина. */
  const [deleteReason, setDeleteReason] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const o = await ordersApi.get(id);
      setOrder(o);
      setWorks(o.works.map((w) => ({ name: w.name, qty: w.qty, price: w.price })));
      setParts(o.parts.map((p) => ({ name: p.name, qty: p.qty, price: p.price, source: p.source })));
      setFinish({
        diagnosis: o.diagnosis ?? "",
        masterComment: o.masterComment ?? "",
        recommendation: o.recommendation ?? "",
        warrantyDays: o.warrantyDays ? String(o.warrantyDays) : "",
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить заказ");
    }
  }, [id]);

  useEffect(() => {
    void load();
    ordersApi.reference().then(setRef).catch(() => undefined);
  }, [load]);

  async function run(action: () => Promise<unknown>, message: string) {
    setSaving(true);
    setError(null);
    try {
      await action();
      await load();
      setNotice(message);
      setTimeout(() => setNotice(null), 4000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не получилось");
    } finally {
      setSaving(false);
    }
  }

  if (error && !order) return <Banner tone="error">{error}</Banner>;
  if (!order) return <Spinner label="Открываем заказ" />;

  const myId = me?.kind === "tenant" ? me.user.id : null;
  const isMyOrder = !!myId && order.assignedMaster?.id === myId;
  const canEditWork = can("orders.edit") || isMyOrder;
  const canIssue = can("orders.issue") && !order.issuedAt;
  const canChangeStatus = can("orders.status") || (can("orders.status.own") && isMyOrder);
  const seesMoney = order.total !== undefined;
  const intake = order.attachments.filter((a) => a.kind === "INTAKE");
  const completion = order.attachments.filter((a) => a.kind === "COMPLETION");

  return (
    <div className="space-y-5">
      <button onClick={() => navigate("/orders")} className="text-[13.5px] font-semibold text-ink-muted hover:text-ink">
        ‹ К списку заказов
      </button>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="font-mono text-[26px] font-extrabold tracking-tight">{order.number}</h1>
            <StatusChip tone={statusTone(order.status.group)}>{order.status.name}</StatusChip>
            {order.isUrgent && (
              <span className="rounded-pill bg-[#2D1A1D] px-2.5 py-1 text-[12px] font-bold text-[#EE9494]">срочный</span>
            )}
            {order.kind !== "REPAIR" && (
              <span className="rounded-pill bg-surface-raised px-2.5 py-1 text-[12px] font-semibold text-ink-muted">
                {ORDER_KIND_LABEL[order.kind]}
              </span>
            )}
          </div>
          <p className="mt-2 text-[15px] text-ink-muted">
            {[order.device?.kind, order.device?.brand, order.device?.model].filter(Boolean).join(" ")}
            {order.device?.serial ? ` · s/n ${order.device.serial}` : ""}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {canChangeStatus && ref && (
            <Select
              className="min-w-[190px]"
              value={order.status.id}
              onChange={(e) => void run(() => ordersApi.setStatus(order.id, e.target.value), "Статус изменён")}
            >
              {ref.statuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          )}
          {canIssue &&
            (order.completedAt ? (
              <Button onClick={() => void run(() => ordersApi.issue(order.id), "Заказ выдан клиенту")} disabled={saving}>
                Выдать клиенту
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => setReturnReason(returnReason === null ? "" : null)}>
                Вернуть без ремонта
              </Button>
            ))}
        </div>
      </div>

      {/* Отдать технику до окончания ремонта можно, но причина обязательна —
          иначе заказ закроется молча и разбираться будет не по чему. */}
      {returnReason !== null && (
        <Card>
          <SectionLabel>Выдача без ремонта</SectionLabel>
          <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field label="Причина" hint="Например: клиент отказался от ремонта, неисправность не подтвердилась">
              <Input
                value={returnReason}
                autoFocus
                onChange={(e) => setReturnReason(e.target.value)}
                placeholder="Клиент забрал технику без ремонта"
              />
            </Field>
            <Button
              disabled={saving || returnReason.trim().length < 3}
              onClick={() =>
                void run(async () => {
                  await ordersApi.issue(order.id, 0, returnReason.trim());
                  setReturnReason(null);
                }, "Техника возвращена клиенту без ремонта")
              }
            >
              Подтвердить
            </Button>
          </div>
        </Card>
      )}

      {notice && <Banner>{notice}</Banner>}
      {error && <Banner tone="error">{error}</Banner>}

      {order.previousRepair && (
        <Card className="border-[#3A3320] bg-[#1C1913]">
          <SectionLabel>Гарантийный возврат — что делали в прошлый раз</SectionLabel>
          <div className="mt-3">
            <Rows
              items={[
                { label: "Прошлый заказ", value: <span className="font-mono">{order.previousRepair.number}</span> },
                { label: "Мастер", value: order.previousRepair.master },
                { label: "Закрыт", value: formatDate(order.previousRepair.issuedAt ?? order.previousRepair.completedAt) },
                { label: "Гарантия до", value: formatDate(order.previousRepair.warrantyUntil) },
                { label: "Диагноз", value: order.previousRepair.diagnosis },
                {
                  label: "Работы",
                  value: order.previousRepair.works.map((w) => w.name).join(", ") || "—",
                },
                {
                  label: "Запчасти",
                  value: order.previousRepair.parts.map((p) => p.name).join(", ") || "—",
                },
                { label: "Комментарий", value: order.previousRepair.masterComment },
              ]}
            />
          </div>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.55fr_1fr]">
        <div className="space-y-4">
          <Card>
            <SectionLabel>Со слов клиента</SectionLabel>
            <p className="mt-3 whitespace-pre-wrap text-[15px] leading-relaxed">{order.complaint}</p>
            {order.receptionNote && (
              <>
                <p className="mt-5 text-[13px] font-semibold text-ink-muted">Примечания приёмщика</p>
                <p className="mt-1.5 whitespace-pre-wrap text-[14px] leading-relaxed text-ink-soft">
                  {order.receptionNote}
                </p>
              </>
            )}

            <div className="mt-5 grid gap-5 border-t border-line pt-5 sm:grid-cols-2">
              <Checklist title="Комплектность" items={order.completeness ?? []} />
              <div className="space-y-3">
                <Checklist title="Внешнее состояние" items={order.appearance ?? []} />
                {(order.hasOpenTraces || order.hasWaterDamage || order.appearanceNote) && (
                  <p className="text-[13px] text-ink-muted">
                    {[
                      order.hasOpenTraces && "следы вскрытия",
                      order.hasWaterDamage && "следы влаги",
                      order.appearanceNote,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
              </div>
            </div>
          </Card>

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <SectionLabel>Фотографии</SectionLabel>
              {canEditWork && (
                <>
                  <input
                    ref={fileInput}
                    type="file"
                    accept="image/*"
                    multiple
                    hidden
                    onChange={(e) => {
                      const files = e.target.files;
                      if (files?.length) {
                        const kind = order.completedAt ? "COMPLETION" : "INTAKE";
                        void run(() => ordersApi.upload(order.id, files, kind), "Фотографии загружены");
                      }
                      e.target.value = "";
                    }}
                  />
                  <Button type="button" variant="secondary" className="px-4 text-[13px]" onClick={() => fileInput.current?.click()}>
                    Добавить фото
                  </Button>
                </>
              )}
            </div>

            <div className="mt-4 space-y-4">
              <div>
                <p className="mb-2 text-[13px] font-semibold text-ink-muted">При приёме</p>
                {intake.length === 0 ? (
                  <p className="text-[13.5px] text-ink-dim">Фотографий нет</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {intake.map((a) => (
                      <Photo key={a.id} orderId={order.id} attachmentId={a.id} name={a.fileName} />
                    ))}
                  </div>
                )}
              </div>
              {completion.length > 0 && (
                <div>
                  <p className="mb-2 text-[13px] font-semibold text-ink-muted">После ремонта</p>
                  <div className="flex flex-wrap gap-2">
                    {completion.map((a) => (
                      <Photo key={a.id} orderId={order.id} attachmentId={a.id} name={a.fileName} />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <SectionLabel>Заказ</SectionLabel>
            <div className="mt-3">
              <Rows
                items={[
                  { label: "Принят", value: formatDateTime(order.acceptedAt) },
                  { label: "Приёмщик", value: order.acceptedBy?.fullName },
                  { label: "Срок готовности", value: formatDate(order.dueAt) },
                  { label: "Мастер", value: order.assignedMaster?.fullName ?? "не назначен" },
                  { label: "Место хранения", value: order.storageLocation },
                  { label: "Пароль устройства", value: order.devicePasscode },
                  {
                    label: "Согласовано до",
                    value: order.approvedLimit ? money(order.approvedLimit) : "не ограничено",
                  },
                ]}
              />
            </div>
          </Card>

          {order.customer.name ? (
            <Card>
              <SectionLabel>Клиент</SectionLabel>
              <div className="mt-3">
                <Rows
                  items={[
                    { label: "Имя", value: order.customer.name },
                    {
                      label: "Телефон",
                      value: order.customer.phone ? (
                        <a href={`tel:${order.customer.phone}`} className="font-semibold text-brand">
                          {order.customer.phone}
                        </a>
                      ) : null,
                    },
                    { label: "Ещё телефон", value: order.customer.phone2 },
                    { label: "Email", value: order.customer.email },
                    { label: "Адрес", value: order.customer.address },
                  ]}
                />
              </div>
            </Card>
          ) : (
            <Card>
              <SectionLabel>Клиент</SectionLabel>
              <p className="mt-3 text-[13.5px] leading-relaxed text-ink-dim">
                Контакты клиента скрыты: для ремонта они не нужны. Если понадобится связаться —
                через приёмщика.
              </p>
            </Card>
          )}

          {seesMoney && (
            <Card>
              <SectionLabel>Деньги</SectionLabel>
              <div className="mt-3">
                <Rows
                  items={[
                    { label: "Предварительно", value: money(order.estimatedCost) },
                    { label: "Работы", value: money(order.totalWork) },
                    // Скидку показываем отдельной строкой, а не вычтенной из
                    // работ: клиент должен видеть, что она у него есть.
                    ...(order.workDiscount
                      ? [
                          {
                            label: `Скидка на работы, ${order.workDiscountPercent}%`,
                            value: (
                              <span className="text-state-done">−{money(order.workDiscount)}</span>
                            ),
                          },
                        ]
                      : []),
                    { label: "Запчасти", value: money(order.totalParts) },
                    ...(order.discount
                      ? [
                          {
                            label: "Скидка при выдаче",
                            value: <span className="text-state-done">−{money(order.discount)}</span>,
                          },
                        ]
                      : []),
                    { label: "Предоплата", value: money(order.prepayment) },
                    {
                      label: "Итого",
                      value: <span className="text-[17px] font-bold">{money(order.total)}</span>,
                    },
                  ]}
                />
              </div>
            </Card>
          )}
        </div>
      </div>

      {canEditWork && (
        <>
          <LineEditor
            title="Выполненные работы"
            rows={works}
            setRows={setWorks}
            empty={{ name: "", qty: 1, price: 0 }}
            saving={saving}
            onSave={() => void run(() => ordersApi.saveWorks(order.id, works), "Работы сохранены")}
          />

          <LineEditor
            title="Запчасти"
            rows={parts}
            setRows={setParts}
            empty={{ name: "", qty: 1, price: 0, source: "STOCK" }}
            saving={saving}
            onSave={() => void run(() => ordersApi.saveParts(order.id, parts), "Запчасти сохранены")}
            extraColumn={(row, update) => (
              <Select
                className="min-h-[42px] w-[142px]"
                value={row.source}
                onChange={(e) => update({ source: e.target.value as OrderPart["source"] })}
              >
                {Object.entries(PART_SOURCE_LABEL).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </Select>
            )}
          />

          <Card>
            <SectionLabel>Завершение ремонта</SectionLabel>
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <Field label="Что оказалось не так" hint="Диагноз, а не пересказ жалобы">
                <Textarea value={finish.diagnosis} onChange={(e) => setFinish({ ...finish, diagnosis: e.target.value })} />
              </Field>
              <Field label="Комментарий для приёмщика и клиента">
                <Textarea
                  value={finish.masterComment}
                  onChange={(e) => setFinish({ ...finish, masterComment: e.target.value })}
                />
              </Field>
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-[1fr_200px]">
              <Field label="Рекомендации клиенту">
                <Input
                  value={finish.recommendation}
                  onChange={(e) => setFinish({ ...finish, recommendation: e.target.value })}
                />
              </Field>
              <Field label="Гарантия, дней">
                <Input
                  inputMode="numeric"
                  value={finish.warrantyDays}
                  onChange={(e) => setFinish({ ...finish, warrantyDays: e.target.value })}
                />
              </Field>
            </div>
            <div className="mt-4">
              <Button
                disabled={saving || !finish.diagnosis.trim()}
                onClick={() =>
                  void run(
                    () =>
                      ordersApi.complete(order.id, {
                        diagnosis: finish.diagnosis,
                        masterComment: finish.masterComment || undefined,
                        recommendation: finish.recommendation || undefined,
                        warrantyDays: finish.warrantyDays ? Number(finish.warrantyDays) : undefined,
                      }),
                    "Ремонт отмечен как завершённый"
                  )
                }
              >
                Ремонт готов
              </Button>
            </div>
          </Card>
        </>
      )}

      {/* Удаление внизу и в два шага: это не то действие, которое должно
          случаться от промаха по соседней кнопке. */}
      {can("orders.delete") && (
        <Card className="border-[#40252B]">
          <SectionLabel>Удаление заказа</SectionLabel>
          {deleteReason === null ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-[13.5px] text-ink-muted">
                Заказ уйдёт из списков и с доски. Списанные запчасти и движения по кассе останутся
                на месте — их поправляют в своих разделах.
              </p>
              <Button variant="danger" onClick={() => setDeleteReason("")}>
                Удалить заказ
              </Button>
            </div>
          ) : (
            <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
              <Field
                label="Причина"
                hint="Останется в журнале — через полгода это будет единственное объяснение"
              >
                <Input
                  value={deleteReason}
                  autoFocus
                  onChange={(e) => setDeleteReason(e.target.value)}
                  placeholder="Завели по ошибке, дубль заказа Р-2026-00041"
                />
              </Field>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setDeleteReason(null)}>
                  Отмена
                </Button>
                <Button
                  variant="danger"
                  disabled={saving || deleteReason.trim().length < 3}
                  onClick={() =>
                    void (async () => {
                      setSaving(true);
                      setError(null);
                      try {
                        await ordersApi.remove(order.id, deleteReason.trim());
                        navigate("/orders");
                      } catch (err) {
                        setError(err instanceof ApiError ? err.message : "Не удалось удалить заказ");
                        setSaving(false);
                      }
                    })()
                  }
                >
                  Удалить
                </Button>
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
