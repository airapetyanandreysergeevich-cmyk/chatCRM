import { useEffect, useState } from "react";
import { ApiError } from "../lib/api";
import { folderBridge, folderPreview, orderFolderApi, TEMPLATES, type FolderSettings } from "../lib/orderFolder";
import { IconFolder } from "./icons";
import { Panel } from "./Panel";
import { Banner, Button, Checkbox, Field, Select } from "./ui";

/**
 * «Папка заказа» в «Базах».
 *
 * Как называть папки и заводить ли их при приёме — общее на мастерскую.
 * Где лежит общая папка — у каждого компьютера своё, и выбрать её можно
 * только в программе FineCRM на этом компьютере (здесь же или по кнопке
 * «Папка заказа» в заказе — там спросит сама).
 */

const SAMPLE = { number: "Р-3934", device: { kind: "Ноутбук", brand: "Asus", model: "X550" }, customer: { name: "Иванов Иван" } };

export function OrderFolderCard() {
  const bridge = folderBridge();
  const [state, setState] = useState<FolderSettings | null>(null);
  const [form, setForm] = useState<FolderSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [root, setRoot] = useState<string | null | undefined>(undefined);
  const [rootError, setRootError] = useState<string | null>(null);

  useEffect(() => {
    orderFolderApi
      .get(true)
      .then((s) => {
        setState(s);
        setForm(s);
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Не удалось прочитать настройку папок"));
    bridge
      ?.info()
      .then((i) => setRoot(i.root ?? null))
      .catch(() => setRoot(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changed = !!state && !!form && JSON.stringify(state) !== JSON.stringify(form);
  const set = (patch: Partial<FolderSettings>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setSaved(false);
  };

  async function save() {
    if (!form) return;
    setBusy(true);
    setError(null);
    try {
      const s = await orderFolderApi.save(form);
      setState(s);
      setForm(s);
      setSaved(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Не сохранилось — нет связи с сервером");
    } finally {
      setBusy(false);
    }
  }

  async function pick() {
    if (!bridge) return;
    setRootError(null);
    const r = await bridge.pickRoot();
    if (r.ok) setRoot(r.root ?? null);
    else if (r.error) setRootError(r.error);
  }

  const example = form ? folderPreview(SAMPLE, form.template) : "";

  return (
    <Panel
      id="data:Папка заказа"
      title="Папка заказа"
      summary={
        state
          ? `${TEMPLATES.find((t) => t.value === state.template)?.label ?? ""}${state.byYear ? ", по годам" : ""}${
              bridge ? ` · здесь: ${root ? root : "папка не выбрана"}` : ""
            }`
          : undefined
      }
    >
      <div className="mt-3 space-y-3" data-order-folder-card>
        <p className="text-[13.5px] leading-relaxed text-ink-muted">
          У каждого заказа — своя папка на компьютере: фото, прошивки, дампы, документы. Кнопка «Папка заказа» в
          заказе и в меню правой кнопки открывает её в Проводнике, а если папки ещё нет — заводит.
        </p>

        {form && (
          <>
            <Field label="Как называть папки" hint={`Например: ${example}`}>
              <Select
                value={form.template}
                onChange={(e) => set({ template: e.target.value as FolderSettings["template"] })}
                className="sm:max-w-[360px]"
                aria-label="Как называть папки"
              >
                {TEMPLATES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid gap-2 sm:max-w-[560px]">
              <Checkbox checked={form.createOnIntake} onChange={(v) => set({ createOnIntake: v })} label="Заводить папку сразу при приёме заказа" />
              <Checkbox
                checked={form.byYear}
                onChange={(v) => set({ byYear: v })}
                label={<span>Раскладывать по годам — Заказы\{new Date().getFullYear()}\{example}</span>}
              />
            </div>
            <p className="text-[12.5px] leading-relaxed text-ink-dim">
              Поменяли технику в заказе — откроется прежняя папка: программа ищет её по номеру в начале имени.
            </p>
            {error && <Banner tone="error">{error}</Banner>}
            {saved && !changed && <Banner>Сохранено. Так будут называться новые папки на всех компьютерах.</Banner>}
            <Button type="button" disabled={busy || !changed} onClick={() => void save()}>
              {busy ? "Сохраняем…" : "Сохранить"}
            </Button>
          </>
        )}
        {!form && error && <Banner tone="error">{error}</Banner>}

        <div className="rounded-field border border-line bg-surface-raised p-3.5" data-order-folder-root>
          <p className="text-[13px] font-bold text-ink">На этом компьютере</p>
          {bridge ? (
            <>
              <p className="mt-1 flex items-center gap-2 break-all text-[14px]">
                <IconFolder className="h-[18px] w-[18px] shrink-0 text-ink-dim" />
                {root === undefined ? "…" : root ? <span className="font-mono">{root}</span> : <span className="text-ink-muted">общая папка не выбрана</span>}
              </p>
              {rootError && (
                <div className="mt-2">
                  <Banner tone="error">{rootError}</Banner>
                </div>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button type="button" variant="secondary" onClick={() => void pick()}>
                  {root ? "Сменить папку…" : "Выбрать папку…"}
                </Button>
              </div>
              <p className="mt-2 text-[12.5px] leading-relaxed text-ink-dim">
                На Основе — папка на диске, например D:\Заказы. На других компьютерах — та же папка по сети
                (\\ОСНОВА\Заказы); сотрудник выберет её сам при первом нажатии «Папка заказа».
              </p>
            </>
          ) : (
            <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
              Общая папка выбирается в программе FineCRM для Windows и Mac — на каждом компьютере своя. В браузере и на
              телефоне папок на компьютере нет, и кнопки «Папка заказа» там не будет.
            </p>
          )}
        </div>
      </div>
    </Panel>
  );
}
