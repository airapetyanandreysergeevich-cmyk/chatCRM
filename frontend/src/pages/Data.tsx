import { useCallback, useEffect, useRef, useState } from "react";
import { IconDownload, IconUpload } from "../components/icons";
import { Banner, Button, Card, PageHeader, SectionLabel, Select, Spinner } from "../components/ui";
import { ApiError } from "../lib/api";
import {
  dataApi,
  type DataReference,
  type DatasetKey,
  type FormatKey,
  type ImportPreview,
  type ImportResult,
} from "../lib/dataApi";

/** Выгрузка: выбираем разделы галочками, формат — кнопкой. */
function ExportCard({ reference }: { reference: DataReference }) {
  const [picked, setPicked] = useState<DatasetKey[]>(["customers"]);
  const [busy, setBusy] = useState<FormatKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = (key: DatasetKey) =>
    setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));

  async function run(format: FormatKey) {
    setBusy(format);
    setError(null);
    try {
      await dataApi.exportFile(picked, format);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось выгрузить");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <SectionLabel>Выгрузить</SectionLabel>
      <p className="mt-2 text-[13.5px] text-ink-muted">
        Файл скачается на это устройство. Данные ваши, забрать их можно в любой момент.
      </p>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {reference.datasets.map((d) => {
          const on = picked.includes(d.key);
          return (
            <button
              key={d.key}
              type="button"
              onClick={() => toggle(d.key)}
              className={
                "rounded-pill px-3.5 py-1.5 text-[13px] font-semibold transition-colors duration-150 " +
                (on
                  ? "bg-brand text-white"
                  : "border border-line bg-surface-raised text-ink-muted hover:text-ink")
              }
            >
              {d.title}
            </button>
          );
        })}
      </div>

      {error && <div className="mt-3"><Banner tone="error">{error}</Banner></div>}

      <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
        {reference.formats.map((f) => (
          <Button
            key={f.key}
            variant={f.key === "xlsx" ? "primary" : "secondary"}
            icon={<IconDownload />}
            disabled={picked.length === 0 || busy !== null}
            onClick={() => void run(f.key)}
          >
            {busy === f.key ? "Готовим…" : f.title}
          </Button>
        ))}
      </div>

      {picked.length > 1 && (
        <p className="mt-3 text-[12.5px] text-ink-dim">
          CSV — это один лист, для нескольких разделов сразу берите Excel.
        </p>
      )}
    </Card>
  );
}

/** Разбор файла: что именно произойдёт, до того как оно произошло. */
function PreviewBlock({
  preview,
  onApply,
  onCancel,
  busy,
}: {
  preview: ImportPreview;
  onApply: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const blocked = preview.missingColumns.length > 0;
  const nothing = !blocked && preview.toCreate + preview.toUpdate === 0;

  return (
    <div className="mt-5 border-t border-line pt-4">
      <p className="text-[14px] font-semibold">{preview.fileName}</p>
      <p className="mt-1 text-[13px] text-ink-dim">строк в файле: {preview.totalRows}</p>

      {blocked ? (
        <div className="mt-3">
          <Banner tone="error">
            В файле нет обязательных колонок: {preview.missingColumns.join(", ")}. Проверьте, что
            шапка на первой строке и названия колонок совпадают с образцом.
          </Banner>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-[14px]">
          <span>
            Добавится <span className="font-bold text-brand">{preview.toCreate}</span>
          </span>
          <span>
            Обновится <span className="font-bold">{preview.toUpdate}</span>
          </span>
          {preview.issues.length > 0 && (
            <span className="text-state-off">
              Строк с замечаниями <span className="font-bold">{preview.issues.length}</span>
            </span>
          )}
        </div>
      )}

      {preview.ignoredColumns.length > 0 && (
        <p className="mt-3 text-[13px] text-ink-muted">
          Колонки, которых нет в системе, пропущены: {preview.ignoredColumns.join(", ")}
        </p>
      )}

      {preview.issues.length > 0 && (
        <div className="mt-4">
          <p className="text-[13px] font-semibold text-ink-muted">
            Эти строки загружены не будут — номера как в вашем файле
          </p>
          <div className="mt-2 max-h-[260px] overflow-auto rounded-card border border-line">
            <table className="w-full text-[13px]">
              <tbody className="divide-y divide-line">
                {preview.issues.map((i, n) => (
                  <tr key={n}>
                    <td className="w-[70px] px-3 py-1.5 font-mono text-ink-dim">стр. {i.row}</td>
                    <td className="px-3 py-1.5 text-ink-soft">{i.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {preview.sample.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-[13px] font-semibold text-ink-muted">
            Как система поняла первые строки
          </summary>
          <div className="mt-2 overflow-x-auto rounded-card border border-line">
            <table className="w-full text-[12.5px]">
              <thead className="bg-surface-raised">
                <tr>
                  {Object.keys(preview.sample[0]).map((k) => (
                    <th key={k} className="whitespace-nowrap px-3 py-1.5 text-left font-semibold">
                      {k}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {preview.sample.map((row, n) => (
                  <tr key={n}>
                    {Object.keys(preview.sample[0]).map((k) => (
                      <td key={k} className="whitespace-nowrap px-3 py-1.5 text-ink-soft">
                        {row[k] || "—"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {!blocked && !nothing && (
          <Button disabled={busy} onClick={onApply}>
            {busy ? "Загружаем…" : `Загрузить ${preview.toCreate + preview.toUpdate} строк`}
          </Button>
        )}
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          {blocked || nothing ? "Выбрать другой файл" : "Отменить"}
        </Button>
      </div>

      {nothing && (
        <p className="mt-3 text-[13px] text-ink-muted">
          Загружать нечего: подходящих строк не нашлось.
        </p>
      )}
    </div>
  );
}

function ImportCard({ reference }: { reference: DataReference }) {
  const [dataset, setDataset] = useState<DatasetKey>("customers");
  const [token, setToken] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const info = reference.datasets.find((d) => d.key === dataset);

  const reset = () => {
    setToken(null);
    setPreview(null);
    setError(null);
  };

  async function pick(file: File) {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await dataApi.parse(dataset, file);
      setToken(r.token);
      setPreview(r.preview);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось прочитать файл");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await dataApi.apply(token));
      reset();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <SectionLabel>Загрузить</SectionLabel>
      <p className="mt-2 text-[13.5px] leading-relaxed text-ink-muted">
        Сначала система разберёт файл и покажет, что произойдёт. Записи только добавляются и
        обновляются — ничего не удаляется, пустая ячейка не затирает то, что уже есть.
      </p>

      <div className="mt-4 max-w-[420px]">
        <Select value={dataset} onChange={(e) => { setDataset(e.target.value as DatasetKey); reset(); }}>
          {reference.datasets.map((d) => (
            <option key={d.key} value={d.key}>
              {d.title}
            </option>
          ))}
        </Select>
      </div>

      {info && (
        <p className="mt-2 text-[13px] text-ink-dim">
          {info.hint} Совпадения ищутся по колонке «{info.matchBy}».
        </p>
      )}

      {!preview && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files?.[0];
            if (file) void pick(file);
          }}
          className={
            "mt-4 rounded-card border border-dashed p-6 text-center transition-colors duration-150 " +
            (dragOver ? "border-brand bg-brand-tint" : "border-line bg-surface-input")
          }
        >
          <input
            ref={fileInput}
            type="file"
            accept=".xlsx,.xlsm,.csv,.txt,.tsv"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void pick(file);
              e.target.value = "";
            }}
          />
          <p className="text-[14px] text-ink-muted">Перетащите файл сюда</p>
          <div className="mt-3">
            <Button
              variant="secondary"
              icon={<IconUpload />}
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              {busy ? "Читаем файл…" : "Выбрать файл"}
            </Button>
          </div>
          <p className="mt-3 text-[12.5px] text-ink-dim">
            Excel или CSV, до {reference.maxImportRows} строк. HTML можно только выгрузить: он для
            чтения и печати, обратно не разбирается.
          </p>
        </div>
      )}

      {error && <div className="mt-4"><Banner tone="error">{error}</Banner></div>}

      {preview && (
        <PreviewBlock preview={preview} busy={busy} onApply={() => void apply()} onCancel={reset} />
      )}

      {result && (
        <div className="mt-4">
          <Banner>
            {result.fileName}: добавлено {result.created}, обновлено {result.updated}
            {result.failed.length > 0 && `, не удалось ${result.failed.length}`}
          </Banner>
          {result.failed.length > 0 && (
            <div className="mt-2 max-h-[200px] overflow-auto rounded-card border border-line">
              <table className="w-full text-[13px]">
                <tbody className="divide-y divide-line">
                  {result.failed.map((f, n) => (
                    <tr key={n}>
                      <td className="w-[70px] px-3 py-1.5 font-mono text-ink-dim">стр. {f.row}</td>
                      <td className="px-3 py-1.5 text-ink-soft">{f.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/** Какие колонки система понимает — чтобы файл готовили сразу правильно. */
function ColumnsCard({ reference }: { reference: DataReference }) {
  const [open, setOpen] = useState<DatasetKey | null>(null);

  return (
    <Card>
      <SectionLabel>Какие колонки понимает система</SectionLabel>
      <p className="mt-2 text-[13.5px] text-ink-muted">
        Порядок колонок неважен, лишние пропускаются. Проще всего выгрузить раздел в Excel и
        заполнить по образцу.
      </p>

      <div className="mt-4 space-y-2">
        {reference.datasets.map((d) => (
          <div key={d.key} className="rounded-card border border-line">
            <button
              type="button"
              onClick={() => setOpen(open === d.key ? null : d.key)}
              className="flex w-full items-center justify-between gap-3 px-3.5 py-2.5 text-left text-[14px] font-semibold"
            >
              {d.title}
              <span className="text-[12.5px] font-medium text-ink-dim">
                {open === d.key ? "свернуть" : `${d.columns.length} колонок`}
              </span>
            </button>
            {open === d.key && (
              <div className="flex flex-wrap gap-1.5 border-t border-line p-3.5">
                {d.columns.map((c) => (
                  <span
                    key={c.title}
                    className={
                      "rounded-pill px-2.5 py-1 text-[12.5px] " +
                      (c.required
                        ? "bg-brand-tint font-semibold text-brand-ink"
                        : c.readOnly
                          ? "bg-surface-input text-ink-dim line-through"
                          : "bg-surface-raised text-ink-muted")
                    }
                    title={
                      c.required
                        ? "обязательная"
                        : c.readOnly
                          ? "только в выгрузке, обратно не загружается"
                          : undefined
                    }
                  >
                    {c.title}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

export default function Data() {
  const [reference, setReference] = useState<DataReference | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReference(await dataApi.reference());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось загрузить раздел");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <Banner tone="error">{error}</Banner>;
  if (!reference) return <Spinner label="Открываем раздел" />;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Настройки"
        title="Базы"
        subtitle="Выгрузка данных мастерской и загрузка из файла."
      />
      <ExportCard reference={reference} />
      <ImportCard reference={reference} />
      <ColumnsCard reference={reference} />
    </div>
  );
}
