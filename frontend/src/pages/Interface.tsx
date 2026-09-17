import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Modal } from "../components/Modal";
import { IconMoon, IconSun } from "../components/icons";
import { Banner, Button, Card, Field, Input, SectionLabel, PageHeader } from "../components/ui";
import { appearanceApi, LOGO_TYPES, prepareLogo, type Branding } from "../lib/branding";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import {
  contrast,
  isHex,
  PALETTE_FIELDS,
  type Mode,
  type Palette,
  type Theme,
} from "../lib/theme";
import { useTheme } from "../lib/useTheme";

/**
 * Настройка цветов.
 *
 * Предпросмотра в отдельном окошке здесь нет намеренно: цвет применяется ко
 * всему интерфейсу сразу, и видно его на настоящих кнопках и панелях, а не
 * на выдуманном примере. Пока не нажата «Сохранить», это видит только тот,
 * кто настраивает; уход со страницы возвращает прежние цвета.
 */

/** Готовые цвета в окне выбора. Свой всё равно можно набрать руками. */
const PRESETS = [
  "#0F1117", "#171A22", "#1F2430", "#2B3243", "#3C445A", "#6B7488",
  "#FFFFFF", "#F1F4F9", "#E4E9F2", "#CBD3E1", "#98A2B3", "#4A5264",
  "#2F8FE0", "#2478C6", "#1E6BB8", "#5B7CFA", "#7C5CFF", "#9B51E0",
  "#FFF993", "#F5D90A", "#B38A00", "#FFB020", "#E8A94B", "#D9822B",
  "#FC7E68", "#E0522F", "#D9542F", "#F2545B", "#D4145A", "#FE3E7D",
  "#A5F88B", "#6FCF52", "#2C8C4A", "#2E9E4F", "#27AE9B", "#46B9CE",
];

function Swatch({ color, onClick, label }: { color: string; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${label}: ${color}`}
      aria-label={`${label}, текущий цвет ${color}`}
      className="flex items-center gap-3 rounded-field border border-line bg-surface-input px-3 py-2 transition-colors duration-150 hover:border-line-strong"
    >
      {/* Клетчатая подложка не нужна — цвета непрозрачные, но тонкая обводка
          обязательна: белый образец на белой панели иначе исчезает. */}
      <span
        className="h-7 w-10 shrink-0 rounded-[7px] border border-line-strong"
        style={{ background: color }}
      />
      <span className="font-mono text-[13px] uppercase text-ink-soft">{color}</span>
    </button>
  );
}

function ColorModal({
  title,
  value,
  onPick,
  onClose,
}: {
  title: string;
  value: string;
  onPick: (color: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const valid = isHex(draft);

  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-6 gap-2">
          {PRESETS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setDraft(c)}
              title={c}
              aria-label={c}
              className={
                "h-10 rounded-field border-2 transition-transform duration-150 hover:scale-105 " +
                (draft.toUpperCase() === c.toUpperCase() ? "border-brand" : "border-line")
              }
              style={{ background: c }}
            />
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-[auto_1fr]">
          <label className="flex items-center gap-2 rounded-field border border-line bg-surface-input px-3 py-2">
            {/* Нативная пипетка: в ней есть выбор из всего спектра и,
                в большинстве браузеров, взятие цвета с экрана. */}
            <input
              type="color"
              value={valid ? draft : value}
              onChange={(e) => setDraft(e.target.value.toUpperCase())}
              className="h-8 w-12 cursor-pointer rounded border-0 bg-transparent p-0"
              aria-label="Выбрать цвет"
            />
            <span className="text-[13px] text-ink-muted">Свой</span>
          </label>

          <Field label="" error={draft && !valid ? "Нужен код вида #1A2B3C" : undefined}>
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              invalid={!!draft && !valid}
              className="font-mono uppercase"
              placeholder="#1A2B3C"
            />
          </Field>
        </div>

        <div className="flex flex-col gap-2 pt-1 sm:flex-row-reverse">
          <Button
            type="button"
            disabled={!valid}
            onClick={() => onPick(draft.toUpperCase())}
            className="sm:flex-1"
          >
            Применить
          </Button>
          <Button type="button" variant="secondary" onClick={onClose} className="sm:flex-1">
            Отмена
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Как мастерская называется сейчас — из того же источника, что и в меню. */
function currentWorkshopName(me: ReturnType<typeof useAuth>["me"]): string {
  if (me?.kind === "tenant") return me.tenant?.name ?? "";
  if (me?.kind === "platform") return me.impersonating?.name ?? "";
  return "";
}

export default function Interface() {
  const { can, me, reload } = useAuth();
  const { mode, saved, setMode, preview, revert, save, reset, branding, saveBranding } = useTheme();
  const [draft, setDraft] = useState<Theme>(saved);
  const [picking, setPicking] = useState<keyof Palette | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [printNote, setPrintNote] = useState(branding.printNote ?? "");
  const savedName = currentWorkshopName(me);
  const [name, setName] = useState(savedName);

  useEffect(() => setPrintNote(branding.printNote ?? ""), [branding.printNote]);
  useEffect(() => setName(savedName), [savedName]);

  const mayEdit = can("settings.manage");

  // Пока страница открыта, показываем черновик. Уход со страницы без
  // сохранения возвращает прежние цвета — иначе неудачный выбор остался бы
  // висеть на всём интерфейсе.
  useEffect(() => {
    preview(draft);
  }, [draft, preview]);

  // Через ref, а не напрямую: эффект должен сработать ровно один раз, при
  // уходе со страницы, и не зависеть от того, как часто меняется функция.
  const revertRef = useRef(revert);
  revertRef.current = revert;
  useEffect(() => () => revertRef.current(), []);

  // Палитра приезжает с сервера уже после первой отрисовки; сюда же попадаем
  // после сохранения и сброса.
  useEffect(() => {
    setDraft(saved);
  }, [saved]);

  const current = draft[mode];
  // Сравниваем с сохранённым, а не с показанным: показанное — это и есть
  // черновик, они совпадают всегда, и кнопка никогда бы не включилась.
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);

  const setColor = (key: keyof Palette, color: string) =>
    setDraft((d) => ({ ...d, [mode]: { ...d[mode], [key]: color } }));

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      await save(draft);
      setNotice("Цвета сохранены — их увидят все сотрудники мастерской");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  async function onReset() {
    setBusy(true);
    setError(null);
    try {
      await reset();
      setNotice("Вернули стандартные цвета");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сбросить");
    } finally {
      setBusy(false);
    }
  }

  async function putBranding(next: Branding, message: string) {
    setBusy(true);
    setError(null);
    try {
      await saveBranding(next);
      setNotice(message);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  async function onRename() {
    setBusy(true);
    setError(null);
    try {
      await appearanceApi.rename(name.trim());
      // Название стоит в меню, в шапке бланков и в письмах — перечитываем
      // данные о себе, чтобы новое появилось везде сразу, без перезахода.
      await reload();
      setNotice("Название сохранено");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось сохранить название");
    } finally {
      setBusy(false);
    }
  }

  async function onLogoPicked(file: File) {
    setError(null);
    try {
      const logo = await prepareLogo(file);
      await putBranding({ logo, printNote: branding.printNote }, "Логотип загружен");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось прочитать картинку");
    }
  }

  const stageFields = PALETTE_FIELDS.filter((f) => f.key.startsWith("stage"));
  const baseFields = PALETTE_FIELDS.filter((f) => !f.key.startsWith("stage"));

  /** Цвет, который не отличается от своей подложки, выглядит поломкой. */
  const weak = (key: keyof Palette) =>
    key.startsWith("stage") && contrast(current[key], current.surface) < 2.5;

  const row = (f: (typeof PALETTE_FIELDS)[number]) => (
    <div key={f.key} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <p className="text-[14px] font-semibold">{f.label}</p>
        <p className="text-[12.5px] text-ink-dim">{f.hint}</p>
        {weak(f.key) && (
          <p className="mt-1 text-[12.5px] font-semibold text-state-waiting">
            На этом фоне почти не виден
          </p>
        )}
      </div>
      <Swatch color={current[f.key]} label={f.label} onClick={() => setPicking(f.key)} />
    </div>
  );

  return (
    <div className="space-y-5">
      <Link to="/settings" className="text-[13.5px] font-semibold text-ink-muted hover:text-ink">
        ‹ Настройки
      </Link>

      <PageHeader
        eyebrow="Настройки"
        title="Интерфейс"
        subtitle="Светлая или тёмная тема запоминается в этом браузере. Цвета — общие для всей мастерской."
      />

      {notice && <Banner>{notice}</Banner>}
      {error && <Banner tone="error">{error}</Banner>}

      {mayEdit && (
        <Card>
          <SectionLabel>Мастерская</SectionLabel>

          <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field
              label="Название компании"
              hint="Стоит внизу бокового меню, в шапке печатных бланков и в письмах клиентам"
              error={name.trim().length > 0 && name.trim().length < 2 ? "Слишком короткое" : undefined}
            >
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                placeholder="Сервис на Ленина"
              />
            </Field>
            <Button
              variant="secondary"
              disabled={busy || name.trim().length < 2 || name.trim() === savedName}
              onClick={() => void onRename()}
            >
              Сохранить
            </Button>
          </div>

          {/* Отчерчиваем: выше — как мастерская называется, ниже — как она
              выглядит. Без линии подпись к названию и текст про логотип
              сливаются в один абзац. */}
          <p className="mt-7 border-t border-line pt-5 text-[13px] font-semibold text-ink-soft">
            Логотип
          </p>
          <p className="mt-1.5 text-[13px] text-ink-dim">
            Встанет в левый верхний угол вместо знака FineCRM и в шапку печатных бланков.
            Картинку уменьшим сами, прозрачность сохраним.
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-4">
            {/* Клетчатая подложка показывает прозрачность: иначе белый логотип
                на белой панели выглядит как пустое место. */}
            <div
              className="flex h-[76px] w-[160px] shrink-0 items-center justify-center rounded-field border border-line p-2"
              style={{
                backgroundImage:
                  "linear-gradient(45deg, rgb(var(--surface-hover)) 25%, transparent 25%, transparent 75%, rgb(var(--surface-hover)) 75%), linear-gradient(45deg, rgb(var(--surface-hover)) 25%, transparent 25%, transparent 75%, rgb(var(--surface-hover)) 75%)",
                backgroundSize: "14px 14px",
                backgroundPosition: "0 0, 7px 7px",
              }}
            >
              {branding.logo ? (
                <img src={branding.logo} alt="Логотип мастерской" className="max-h-full max-w-full object-contain" />
              ) : (
                <span className="text-[12.5px] text-ink-dim">Пока не загружен</span>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              <input
                ref={fileInput}
                type="file"
                accept={LOGO_TYPES}
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  // Сбрасываем значение: иначе повторный выбор того же файла
                  // не вызовет событие, и человек решит, что кнопка сломалась.
                  e.target.value = "";
                  if (file) void onLogoPicked(file);
                }}
              />
              <Button variant="secondary" disabled={busy} onClick={() => fileInput.current?.click()}>
                {branding.logo ? "Заменить" : "Загрузить"}
              </Button>
              {branding.logo && (
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => void putBranding({ logo: null, printNote: branding.printNote }, "Логотип убран")}
                >
                  Убрать
                </Button>
              )}
            </div>
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <Field
              label="Строка в бланках"
              hint="Адрес, телефон, часы работы — печатается под названием мастерской"
            >
              <Input
                value={printNote}
                onChange={(e) => setPrintNote(e.target.value)}
                placeholder="г. Москва, ул. Ленина 5 · +7 495 000-00-00"
              />
            </Field>
            <Button
              variant="secondary"
              disabled={busy || printNote.trim() === (branding.printNote ?? "")}
              onClick={() =>
                void putBranding(
                  { logo: branding.logo, printNote: printNote.trim() || null },
                  "Реквизиты сохранены"
                )
              }
            >
              Сохранить
            </Button>
          </div>
        </Card>
      )}

      <Card>
        <SectionLabel>Тема</SectionLabel>
        <div className="mt-3 inline-flex rounded-field border border-line bg-surface-input p-1">
          {(
            [
              ["dark", "Тёмная", <IconMoon key="m" />],
              ["light", "Светлая", <IconSun key="s" />],
            ] as Array<[Mode, string, React.ReactNode]>
          ).map(([value, label, icon]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMode(value)}
              className={
                "inline-flex min-h-[40px] items-center gap-2 rounded-[9px] px-4 text-[14px] font-semibold transition-colors duration-150 [&>svg]:h-[17px] [&>svg]:w-[17px] " +
                (mode === value ? "bg-brand text-white" : "text-ink-muted hover:text-ink")
              }
            >
              {icon}
              {label}
            </button>
          ))}
        </div>
        <p className="mt-3 text-[12.5px] text-ink-dim">
          Выбор действует только на этом устройстве. У каждого сотрудника он свой.
        </p>
      </Card>

      {!mayEdit ? (
        <Banner>
          Цвета мастерской настраивает владелец. Вам доступна смена светлой и тёмной темы.
        </Banner>
      ) : (
        <>
          <Card>
            <SectionLabel>Цвета стадий</SectionLabel>
            <p className="mt-2 text-[13px] text-ink-dim">
              Этими цветами покрашены колонки на главной, плашки статусов и значки в списках.
              Настраиваются отдельно для {mode === "dark" ? "тёмной" : "светлой"} темы — переключите
              её выше, чтобы задать вторую.
            </p>
            <div className="mt-2 divide-y divide-line">{stageFields.map(row)}</div>
          </Card>

          <Card>
            <SectionLabel>Основные цвета</SectionLabel>
            <p className="mt-2 text-[13px] text-ink-dim">
              Остальное — линии, оттенки текста, подложки плашек — система считает от них сама,
              чтобы интерфейс оставался читаемым при любом выборе.
            </p>
            <div className="mt-2 divide-y divide-line">{baseFields.map(row)}</div>
          </Card>

          <div className="flex flex-col gap-2 sm:flex-row-reverse">
            <Button disabled={busy || !dirty} onClick={() => void onSave()} className="sm:min-w-[200px]">
              {busy ? "Сохраняем…" : dirty ? "Сохранить" : "Всё сохранено"}
            </Button>
            {dirty && (
              <Button variant="secondary" onClick={() => setDraft(saved)}>
                Отменить правки
              </Button>
            )}
            <Button variant="ghost" disabled={busy} onClick={() => void onReset()}>
              Вернуть стандартные
            </Button>
          </div>
        </>
      )}

      {picking && (
        <ColorModal
          title={PALETTE_FIELDS.find((f) => f.key === picking)?.label ?? "Цвет"}
          value={current[picking]}
          onPick={(color) => {
            setColor(picking, color);
            setPicking(null);
          }}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}
