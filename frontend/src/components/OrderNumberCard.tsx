import { useEffect, useState } from "react";
import { Banner, Button, Card, Checkbox, Field, Input, SectionLabel } from "./ui";
import { ApiError, api } from "../lib/api";

/**
 * Нумерация заказов — в «Базах».
 *
 * Владелец вписывает первый номер так, как хочет его видеть (SC01, З-001,
 * 1000), и сразу видит следующие три. Пусто — стандартные Р-2026-00001.
 * Галочка «год» даёт SC-2026-01, и тогда счёт каждый январь начинается заново.
 *
 * Менять можно только в пустой мастерской: как только появился первый заказ,
 * поле закрывается и объясняет почему, — номера на выданных квитанциях не
 * должны расходиться с базой.
 */

interface State {
  template: string;
  withYear: boolean;
  locked: boolean;
  orders: number;
  year: number;
  next: string[];
}

export function OrderNumberCard() {
  const [state, setState] = useState<State | null>(null);
  const [template, setTemplate] = useState("");
  const [withYear, setWithYear] = useState(false);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<State>("/settings/order-number")
      .then((s) => {
        setState(s);
        setTemplate(s.template);
        setWithYear(s.withYear);
        setPreview(s.next);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Не удалось прочитать нумерацию"));
  }, []);

  const changed = !!state && (template.trim() !== state.template || (template.trim() !== "" && withYear !== state.withYear));

  // Подсказка «следующие номера» — пока человек печатает, но не на каждую букву.
  useEffect(() => {
    if (!state || state.locked) return;
    if (!changed) {
      setPreview(state.next);
      setProblem(null);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const p = new URLSearchParams({ template: template.trim(), withYear: withYear ? "1" : "0" });
        const r = await api.get<{ next: string[] }>(`/settings/order-number/preview?${p.toString()}`);
        setPreview(r.next);
        setProblem(null);
      } catch (err) {
        setPreview(null);
        setProblem(err instanceof ApiError ? err.field("template") ?? err.message : "Не удалось проверить номер");
      }
    }, 300);
    return () => clearTimeout(t);
  }, [template, withYear, state, changed]);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const s = await api.put<State>("/settings/order-number", { template: template.trim(), withYear });
      setState(s);
      setTemplate(s.template);
      setWithYear(s.withYear);
      setPreview(s.next);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.field("template") ?? err.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  if (!state) {
    return error ? <Banner tone="error">{error}</Banner> : null;
  }

  const custom = template.trim() !== "";

  return (
    <Card>
      <SectionLabel>Нумерация заказов</SectionLabel>

      {state.locked ? (
        <div className="mt-3 space-y-2">
          <p className="text-[14px] text-ink-muted">
            Номера сейчас:{" "}
            <span className="font-mono font-semibold text-ink">{state.next.join(", ")}…</span>
          </p>
          <p className="text-[12.5px] leading-relaxed text-ink-dim">
            Нумерация уже идёт — в мастерской {state.orders} {state.orders === 1 ? "заказ" : "заказов"}. Менять её
            нельзя: номера на выданных квитанциях разошлись бы с базой. Задать свой формат можно только в пустой
            мастерской.
          </p>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <Field
            label="Первый номер заказа"
            error={problem ?? undefined}
            hint="Впишите номер, с которого начать, так, как он должен выглядеть: SC01, З-001, 1000. Пусто — стандартные номера."
          >
            <Input
              value={template}
              onChange={(e) => {
                setTemplate(e.target.value);
                setSaved(false);
              }}
              placeholder={`Р-${state.year}-00001`}
              spellCheck={false}
              autoCapitalize="characters"
              invalid={!!problem}
              className="font-mono sm:max-w-[320px]"
            />
          </Field>

          <div className="sm:max-w-[460px]">
            <Checkbox
              checked={custom && withYear}
              disabled={!custom}
              onChange={(v) => {
                setWithYear(v);
                setSaved(false);
              }}
              label="Добавлять год — и начинать счёт заново каждый январь"
            />
          </div>

          {preview && !problem && (
            <p className="text-[13.5px] text-ink-muted">
              Следующие заказы:{" "}
              <span className="font-mono font-semibold text-ink">{preview.join(", ")}…</span>
            </p>
          )}

          {error && <Banner tone="error">{error}</Banner>}
          {saved && !changed && <Banner>Сохранено. Первый заказ получит номер {state.next[0]}.</Banner>}

          <Button type="button" disabled={busy || !changed || !!problem} onClick={() => void save()}>
            {busy ? "Сохраняем…" : "Сохранить"}
          </Button>
        </div>
      )}
    </Card>
  );
}
