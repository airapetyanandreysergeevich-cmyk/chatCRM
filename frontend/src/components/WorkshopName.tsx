import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal } from "./Modal";
import { Badge, Banner, Button, Input } from "./ui";
import { ApiError, api } from "../lib/api";
import { useAuth } from "../lib/auth";

/**
 * Имя мастерской и логины сотрудников — в «Доступе из интернета».
 *
 * Владелец выбирает имя (lenina), и логины всех сотрудников становятся
 * nikita@lenina — одинаково в мастерской и на www.finecrm.ru. Свободно ли
 * имя, проверяет облако: только оно видит все мастерские.
 *
 * Переименование никогда не бывает молчаливым: сначала таблица «было →
 * станет», где часть до @ можно поправить каждому, и только потом кнопка.
 * У двух Никит с разными почтами логины совпали бы — таблица это покажет
 * раньше, чем кто-то из них не сможет войти.
 */

interface PlanRow {
  id: string;
  fullName: string;
  isOwner: boolean;
  isActive: boolean;
  login: string;
  local: string;
  contactEmail: string;
}

interface Check {
  name: string;
  ok: boolean;
  reason?: string;
}

/** Что можно набрать в имени: латиница, цифры, дефис. Остальное выбрасываем сразу. */
const cleanName = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 30);
const cleanLocal = (s: string) => s.toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 40);

export function WorkshopName({ name, onChanged }: { name: string; onChanged: () => void }) {
  const { me, can, reload } = useAuth();
  const canRename = can("staff.manage");
  /** Окно открыто: с выбора имени или сразу с таблицы логинов. */
  const [editing, setEditing] = useState<"name" | "table" | null>(null);
  const [plan, setPlan] = useState<PlanRow[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  // У кого логины ещё не этой мастерской — например, человека завели до
  // регистрации имени другим способом или переименование сорвалось.
  const loadPlan = useCallback(async () => {
    if (!canRename || !name) return setPlan(null);
    try {
      setPlan((await api.get<{ rows: PlanRow[] }>("/settings/workshop-name/plan")).rows);
    } catch {
      setPlan(null);
    }
  }, [canRename, name]);

  useEffect(() => {
    void loadPlan();
  }, [loadPlan]);

  const stale = plan?.filter((r) => !r.login.endsWith(`@${name}`)) ?? [];
  const myLogin = me?.kind === "tenant" ? me.user.email : "";
  const sample = name ? `${myLogin.split("@")[0] || "nikita"}@${name}` : "";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`@${name}`);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="mt-4 rounded-field border border-line bg-surface-input px-3.5 py-3">
      <p className="text-[13px] font-semibold text-ink-soft">Имя мастерской и логины сотрудников</p>

      {done && (
        <div className="mt-2">
          <Banner>{done}</Banner>
        </div>
      )}

      {name ? (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="text-[13.5px] text-ink-muted">Имя вашей мастерской:</span>
            <span className="rounded-md bg-surface px-2 py-1 font-mono text-[15px] font-bold text-brand-ink">{name}</span>
            <Button type="button" variant="secondary" className="min-h-[30px] px-2.5 text-[12.5px]" onClick={() => void copy()}>
              {copied ? "Скопировано" : `Скопировать @${name}`}
            </Button>
          </div>
          <p className="mt-3 text-[13.5px] leading-relaxed text-ink-muted">
            Сотрудники входят логином вида <span className="font-mono font-semibold text-ink">имя@{name}</span> — и здесь, в
            мастерской, и на <span className="font-semibold text-ink">www.finecrm.ru</span>. Например, ваш:
          </p>
          <p className="mt-2 break-all rounded-field border border-line bg-surface px-3 py-2.5 font-mono text-[13.5px]">
            {sample.split("@")[0]}
            <span className="font-bold text-brand-ink">@{name}</span>
          </p>
          <ul className="mt-3 space-y-1.5 text-[12.5px] leading-relaxed text-ink-dim">
            <li>Пароли прежние. Проверяет их ваш компьютер — облако их не видит.</li>
            <li>В локальной сети можно войти и без окончания — просто {sample.split("@")[0]}.</li>
            <li>Новым сотрудникам в разделе «Сотрудники» окончание @{name} подставится само.</li>
          </ul>

          {stale.length > 0 && (
            <div className="mt-3">
              <Banner tone="warning">
                {stale.length === 1
                  ? `У сотрудника ${stale[0].fullName} логин ещё прежний: ${stale[0].login}.`
                  : `У ${stale.length} сотрудников логины ещё прежние.`}{" "}
                Из интернета по ним не войти.
              </Banner>
            </div>
          )}

          {canRename && (
            <div className="mt-3 flex flex-wrap gap-2">
              {stale.length > 0 && (
                <Button type="button" onClick={() => setEditing("table")}>
                  Перевести логины
                </Button>
              )}
              <Button type="button" variant="secondary" onClick={() => setEditing("name")}>
                Сменить имя
              </Button>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-muted">
            Выберите короткое имя мастерской латиницей — например, <span className="font-mono">lenina</span>. Логины
            сотрудников станут вида <span className="font-mono font-semibold text-ink">nikita@lenina</span>: одинаковыми в
            мастерской и на www.finecrm.ru. Пока имени нет, из интернета войти нельзя.
          </p>
          {canRename ? (
            <div className="mt-3">
              <Button type="button" onClick={() => setEditing("name")}>
                Выбрать имя
              </Button>
            </div>
          ) : (
            <p className="mt-2 text-[12.5px] text-ink-dim">Выбрать имя может тот, кто управляет сотрудниками.</p>
          )}
        </>
      )}

      {editing && (
        <NameWizard
          current={name}
          start={editing}
          onClose={() => setEditing(null)}
          onDone={async (result) => {
            setEditing(null);
            setDone(
              `Готово: имя мастерской — ${result.name}` +
                (result.changed
                  ? `, логины изменены у ${result.changed} ${result.changed === 1 ? "сотрудника" : "сотрудников"}. Сообщите людям новые логины — пароли прежние.`
                  : ".")
            );
            await reload();
            await loadPlan();
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function NameWizard({
  current,
  start,
  onClose,
  onDone,
}: {
  current: string;
  start: "name" | "table";
  onClose: () => void;
  onDone: (result: { name: string; changed: number }) => void;
}) {
  const [step, setStep] = useState<"name" | "table">(current ? start : "name");
  const [name, setName] = useState(current);
  const [check, setCheck] = useState<Check | null>(current ? { name: current, ok: true } : null);
  const [checking, setChecking] = useState(false);
  const [rows, setRows] = useState<PlanRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Проверка имени — пока человек печатает, но не на каждую букву.
  useEffect(() => {
    if (step !== "name") return;
    if (!name) return setCheck(null);
    if (name === current) return setCheck({ name, ok: true });
    setChecking(true);
    const t = setTimeout(async () => {
      try {
        setCheck(await api.get<Check>(`/settings/workshop-name/check?name=${encodeURIComponent(name)}`));
      } catch (err) {
        setCheck({ name, ok: false, reason: err instanceof ApiError ? err.message : "Не удалось проверить имя" });
      } finally {
        setChecking(false);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [name, current, step]);

  const openTable = useCallback(async () => {
    setError(null);
    try {
      const plan = await api.get<{ rows: PlanRow[] }>("/settings/workshop-name/plan");
      setRows(plan.rows);
      setStep("table");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось получить список сотрудников");
    }
  }, []);

  useEffect(() => {
    if (step === "table" && !rows) void openTable();
  }, [step, rows, openTable]);

  // Одинаковые логины подсвечиваются сразу, а не после нажатия кнопки.
  const twice = useMemo(() => {
    const count = new Map<string, number>();
    for (const r of rows ?? []) count.set(r.local, (count.get(r.local) ?? 0) + 1);
    return new Set([...count].filter(([local, n]) => n > 1 || !local).map(([local]) => local));
  }, [rows]);

  const changing = (rows ?? []).filter((r) => r.login !== `${r.local}@${name}`).length;

  async function apply() {
    if (!rows) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ name: string; changed: number }>("/settings/workshop-name", {
        name,
        logins: rows.map((r) => ({ id: r.id, local: r.local, contactEmail: r.contactEmail })),
      });
      onDone(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  const setRow = (id: string, patch: Partial<PlanRow>) =>
    setRows((list) => list?.map((r) => (r.id === id ? { ...r, ...patch } : r)) ?? null);

  return (
    <Modal title={step === "name" ? "Имя мастерской" : `Логины сотрудников · @${name}`} onClose={onClose} wide={step === "table"}>
      <div className="space-y-4">
        {error && <Banner tone="error">{error}</Banner>}

        {step === "name" ? (
          <>
            <div>
              <div
                className={
                  "flex min-h-[46px] items-center rounded-field border bg-surface-input pl-3.5 focus-within:border-brand " +
                  (check && !check.ok ? "border-state-off" : "border-line")
                }
              >
                <span className="shrink-0 font-semibold text-ink-dim">nikita@</span>
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(cleanName(e.target.value))}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="lenina"
                  aria-label="Имя мастерской"
                  className="min-w-0 flex-1 bg-transparent pr-3.5 text-[16px] font-semibold text-ink outline-none placeholder:font-normal placeholder:text-ink-dim"
                />
              </div>
              <p className="mt-1.5 min-h-[20px] text-[13px]">
                {checking ? (
                  <span className="text-ink-dim">Проверяем…</span>
                ) : check ? (
                  check.ok ? (
                    <span className="font-semibold text-state-done">
                      {name === current ? "Это нынешнее имя" : "Свободно"}
                    </span>
                  ) : (
                    <span className="font-semibold text-state-off">{check.reason}</span>
                  )
                ) : (
                  <span className="text-ink-dim">Латинские буквы, цифры и дефис, от 3 до 30 знаков.</span>
                )}
              </p>
            </div>
            <p className="text-[13px] leading-relaxed text-ink-muted">
              Имя будет в логине у каждого сотрудника, его придётся диктовать — короткое и понятное лучше длинного:
              название улицы, района, самой мастерской.
              {current && ` Прежнее имя «${current}» ещё месяц останется за вами: кто войдёт по нему, получит подсказку.`}
            </p>
            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              <Button
                type="button"
                disabled={!check?.ok || checking || check.name !== name}
                onClick={() => {
                  setRows(null);
                  setStep("table");
                }}
                className="sm:flex-1"
              >
                Продолжить
              </Button>
              <Button type="button" variant="secondary" onClick={onClose} className="sm:flex-1">
                Отмена
              </Button>
            </div>
          </>
        ) : !rows ? (
          <p className="text-ink-dim">Загружаем сотрудников…</p>
        ) : (
          <>
            <p className="text-[13.5px] leading-relaxed text-ink-muted">
              Проверьте логины. Часть до @ можно поправить — у каждого она должна быть своя. Пароли не меняются, работающие
              сейчас сотрудники не вылетят.
            </p>

            <div className="overflow-hidden rounded-field border border-line">
              {rows.map((r) => (
                <div key={r.id} className="grid gap-2 border-b border-line px-3.5 py-3 last:border-b-0 md:grid-cols-[1.2fr_1.4fr_1.2fr] md:items-center">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5 text-[14.5px] font-semibold">
                      <span className="truncate">{r.fullName}</span>
                      {r.isOwner && <Badge tone="brand">это вы</Badge>}
                      {!r.isActive && <Badge>отключён</Badge>}
                    </p>
                    <p className="truncate text-[12.5px] text-ink-dim" title={r.login}>
                      сейчас: {r.login}
                    </p>
                  </div>
                  <div>
                    <div
                      className={
                        "flex min-h-[42px] items-center rounded-field border bg-surface-input pr-3 focus-within:border-brand " +
                        (twice.has(r.local) ? "border-state-off" : "border-line")
                      }
                    >
                      <input
                        value={r.local}
                        onChange={(e) => setRow(r.id, { local: cleanLocal(e.target.value) })}
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        aria-label={`Новый логин: ${r.fullName}`}
                        className="min-w-0 flex-1 bg-transparent px-3 text-[14.5px] font-semibold text-ink outline-none"
                      />
                      <span className="shrink-0 text-[14px] text-ink-muted">@{name}</span>
                    </div>
                    {twice.has(r.local) && (
                      <p className="mt-1 text-[12px] text-state-off">{r.local ? "Такой логин уже есть в списке" : "Укажите логин"}</p>
                    )}
                  </div>
                  <Input
                    type="email"
                    value={r.contactEmail}
                    onChange={(e) => setRow(r.id, { contactEmail: e.target.value.trim() })}
                    placeholder="почта для связи"
                    aria-label={`Почта для связи: ${r.fullName}`}
                    className="min-h-[42px] text-[13.5px]"
                  />
                </div>
              ))}
            </div>

            <p className="text-[12.5px] leading-relaxed text-ink-dim">
              «Почта для связи» — настоящая почта человека, если была в прежнем логине: она не пропадёт. Кто по привычке
              войдёт прежним логином с верным паролем, увидит подсказку с новым.
            </p>

            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              <Button type="button" disabled={busy || twice.size > 0} onClick={() => void apply()} className="sm:flex-1">
                {busy
                  ? "Сохраняем…"
                  : name === current
                    ? changing
                      ? `Перевести логины (${changing})`
                      : "Сохранить"
                    : `Зарегистрировать @${name}`}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setStep("name")} className="sm:flex-1">
                {current && name === current ? "Другое имя" : "Назад"}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
