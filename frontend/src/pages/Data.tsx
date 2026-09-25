import { useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "../components/CopyMenu";
import { RemoveDemoModal } from "../components/DemoBanner";
import { MigrateCard } from "../components/MigrateCard";
import { Modal } from "../components/Modal";
import { OrderNumberCard } from "../components/OrderNumberCard";
import { IconDelete, IconDownload, IconUpload } from "../components/icons";
import { Banner, Button, Card, Checkbox, Field, Input, PageHeader, SectionLabel, Select, Spinner } from "../components/ui";
import { ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import {
  dataApi,
  WIPE_WORD,
  type DataReference,
  type DatasetInfo,
  type DatasetKey,
  type FormatKey,
  type ImportPreview,
  type ImportResult,
  type WipeResult,
  type CashImpact,
  type CashRegisterInfo,
} from "../lib/dataApi";
import { demoApi, reloadAfterDemo, type DemoState } from "../lib/demoApi";

/**
 * Окно стирания.
 *
 * Два рубежа, и оба нужны. Первый — счёт: «сотрём Заказы» это обещание
 * неизвестно чего, а «сотрём 4039 заказов» — то, на что человек отвечает
 * осознанно. Второй — слово: галочку и кнопку «Да» нажимают мимоходом, а
 * мимоходом и случаются беды такого размера. Семь букв набрать мимоходом
 * нельзя.
 */
function WipeModal({
  datasets,
  skipped,
  registers,
  onClose,
  onDone,
}: {
  datasets: DatasetInfo[];
  /** Выбранные, но не стираемые разделы — чтобы человек не решил, что стёр и их. */
  skipped: DatasetInfo[];
  /** Кассы мастерской — если в стирании есть «Касса». */
  registers: CashRegisterInfo[];
  onClose: () => void;
  onDone: (result: WipeResult) => void;
}) {
  const [word, setWord] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Касса: какие кассы стереть (по умолчанию все, где есть движения) и что
  // станет с долгами. Считает сервер — по тем же правилам, что и сам долг.
  const withCash = datasets.some((d) => d.key === "cash");
  const withOrders = datasets.some((d) => d.key === "orders");
  const [picked, setPicked] = useState<string[]>(() => registers.filter((r) => r.count > 0).map((r) => r.id));
  const [impact, setImpact] = useState<CashImpact | null>(null);
  const allPicked = picked.length === registers.filter((r) => r.count > 0).length;

  useEffect(() => {
    if (!withCash || picked.length === 0) {
      setImpact(null);
      return;
    }
    let alive = true;
    dataApi
      .cashImpact(allPicked ? [] : picked)
      .then((r) => alive && setImpact(r))
      .catch(() => alive && setImpact(null));
    return () => {
      alive = false;
    };
  }, [withCash, picked, allPicked]);

  const ready = word.trim().toUpperCase() === WIPE_WORD && (!withCash || picked.length > 0);
  const rowsOf = (d: DatasetInfo) => (d.key === "cash" && impact ? impact.transactions : d.count);
  const totalRows = datasets.reduce((n, d) => n + rowsOf(d), 0);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      onDone(await dataApi.wipe(datasets.map((d) => d.key), word, withCash && !allPicked ? picked : undefined));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось стереть");
      setBusy(false);
    }
  }

  return (
    <Modal title="Стереть базу насовсем" onClose={onClose}>
      <div className="space-y-4">
        <Banner tone="error">
          Это нельзя отменить. Выгрузите файл, если не уверены, — он скачивается за секунду.
        </Banner>

        <div>
          <p className="text-[13.5px] text-ink-muted">Будет стёрто:</p>
          <ul className="mt-2 space-y-1.5">
            {datasets.map((d) => (
              <li
                key={d.key}
                className="flex items-baseline justify-between gap-3 rounded-field bg-surface-raised px-3 py-2"
              >
                <span className="text-[14px] font-semibold">{d.title}</span>
                <span className="text-[14px] font-bold text-state-off">
                  {rowsOf(d) === 0 ? "пусто" : `${rowsOf(d).toLocaleString("ru-RU")} записей`}
                </span>
              </li>
            ))}
          </ul>
          {skipped.length > 0 && (
            <p className="mt-2 text-[12.5px] text-ink-dim">
              {skipped.map((d) => `«${d.title}»`).join(", ")} так не стираются — сотрудников убирают по
              одному в разделе «Сотрудники».
            </p>
          )}
        </div>

        {withCash && registers.length > 0 && (
          <div>
            <p className="text-[13.5px] text-ink-muted">Из каких касс стереть движения денег:</p>
            <div className="mt-2 space-y-1.5">
              {registers.map((r) => (
                <Checkbox
                  key={r.id}
                  checked={picked.includes(r.id)}
                  disabled={r.count === 0}
                  onChange={(on) => setPicked((p) => (on ? [...p, r.id] : p.filter((x) => x !== r.id)))}
                  label={`${r.name}${r.isActive ? "" : " (выключена)"} — ${r.count.toLocaleString("ru-RU")} движений`}
                />
              ))}
            </div>
            <p className="mt-2 text-[12.5px] text-ink-dim">Сами кассы и статьи останутся — это настройки.</p>
          </div>
        )}

        {/* Долги — главное, что ломает стирание кассы. Говорим числом и до
            нажатия: «станут долгами» без числа читается как формальность. */}
        {withCash && !withOrders && impact && impact.orders > 0 && (
          <Banner tone="warning">
            {impact.orders.toLocaleString("ru-RU")} выданных заказов станут долгами на{" "}
            {impact.sum.toLocaleString("ru-RU")} ₽: долг — это итог заказа минус платежи, а платежи
            уйдут. Если заказы тоже больше не нужны — отметьте и «Заказы».
          </Banner>
        )}

        {/* Про деньги говорим здесь, а не в журнале: владелец должен узнать
            об этом до нажатия, а не после. */}
        {withOrders && !withCash && (
          <p className="text-[12.5px] text-ink-dim">
            Кассовые операции останутся в кассе и потеряют ссылку на заказ: стереть их вместе с
            заказами значило бы изменить остаток кассы, который вы сверяете с ящиком. Чтобы стереть и
            деньги, отметьте «Касса». Фотографии заказов удалятся из хранилища вместе с заказами.
          </p>
        )}
        {withCash && (
          <p className="text-[12.5px] text-ink-dim">
            Остаток выбранных касс станет нулевым. Выгрузите кассу в Excel перед стиранием, если
            история денег может понадобиться.
          </p>
        )}

        {error && <Banner tone="error">{error}</Banner>}

        <Field label={`Наберите ${WIPE_WORD}, чтобы подтвердить`}>
          <Input
            value={word}
            onChange={(e) => setWord(e.target.value)}
            placeholder={WIPE_WORD}
            autoComplete="off"
            autoFocus
          />
        </Field>

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button variant="danger" icon={<IconDelete />} disabled={!ready || busy} onClick={() => void run()}>
            {busy ? "Стираем…" : totalRows > 0 ? `Стереть ${totalRows.toLocaleString("ru-RU")} записей` : "Стереть"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Выгрузка: выбираем разделы галочками, формат — кнопкой. */
function ExportCard({ reference, onWiped }: { reference: DataReference; onWiped: () => void }) {
  const { me } = useAuth();
  const [picked, setPicked] = useState<DatasetKey[]>(["customers"]);
  const [busy, setBusy] = useState<FormatKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wiping, setWiping] = useState(false);
  const [wiped, setWiped] = useState<WipeResult | null>(null);

  // Стирание — только владельцу. Право «Настройки мастерской» бывает и у
  // старшего приёмщика: выгрузка и загрузка поправимы, стирание — нет.
  const canWipe = me?.kind === "tenant" && me.user.isOwner;
  const pickedInfo = reference.datasets.filter((d) => picked.includes(d.key));
  const wipeable = pickedInfo.filter((d) => d.canWipe !== false);

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

      {wiped && (
        <div className="mt-3">
          <Banner>
            {wiped.titles.join(", ")}: стёрто{" "}
            {Object.values(wiped.rows).reduce((n, v) => n + v, 0).toLocaleString("ru-RU")} записей
            {wiped.files > 0 && `, удалено фотографий: ${wiped.files}`}. {wiped.finishedAt}
          </Banner>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
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

        {/* Стирание стоит в стороне от выгрузки — у другого края и другим
            цветом. Рядом с «Excel» его однажды нажали бы вместо него. */}
        {canWipe && (
          <div className="ml-auto">
            <Button
              variant="danger"
              icon={<IconDelete />}
              disabled={wipeable.length === 0}
              onClick={() => setWiping(true)}
            >
              Удалить
            </Button>
          </div>
        )}
      </div>

      {picked.length > 1 && (
        <p className="mt-3 text-[12.5px] text-ink-dim">
          CSV — это один лист, для нескольких разделов сразу берите Excel.
        </p>
      )}

      {wiping && (
        <WipeModal
          datasets={wipeable}
          skipped={pickedInfo.filter((d) => d.canWipe === false)}
          registers={reference.cashRegisters ?? []}
          onClose={() => setWiping(false)}
          onDone={(result) => {
            setWiping(false);
            setWiped(result);
            onWiped();
          }}
        />
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
  const willDo = preview.toCreate + preview.toUpdate + preview.toRestore;
  const nothing = !blocked && willDo === 0;

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
          {preview.toRestore > 0 && (
            <span>
              Вернётся из удалённых <span className="font-bold text-brand">{preview.toRestore}</span>
            </span>
          )}
          {preview.issuesTotal > 0 && (
            <span className="text-state-off">
              Строк с замечаниями <span className="font-bold">{preview.issuesTotal}</span>
            </span>
          )}
        </div>
      )}

      {/* Беда всего файла важнее списка отдельных строк: пока человек не
          поймёт, что у него съехала шапка, двести строчек «не число» он будет
          читать как придирки программы. */}
      {preview.hints.length > 0 && (
        <div className="mt-3 space-y-2">
          {preview.hints.map((h) => (
            <Banner key={h} tone="warning">
              {h}
            </Banner>
          ))}
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
            {preview.issuesTotal > preview.issues.length &&
              `. Показаны первые ${preview.issues.length} из ${preview.issuesTotal}`}
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
            {busy ? "Загружаем…" : `Загрузить ${willDo} строк`}
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

/**
 * Временные пароли новых сотрудников.
 *
 * Показываются один раз: сервер их не хранит, и второй раз взять их неоткуда.
 * Поэтому здесь же — «скопировать» и «скачать», и прямо сказано, что после
 * ухода со страницы пароли не вернуть (только задать новые в «Сотрудниках»).
 */
function PasswordsBlock({ list, onHide }: { list: NonNullable<ImportResult["passwords"]>; onHide: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = list.map((p) => `${p.name}\t${p.login}\t${p.password}`).join("\n");

  function download() {
    const body = "Имя\tЛогин\tВременный пароль\r\n" + text.replace(/\n/g, "\r\n") + "\r\n";
    const url = URL.createObjectURL(new Blob(["\ufeff" + body], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "paroli-sotrudnikov.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mt-3 rounded-card border border-state-waiting/40 bg-state-waiting/5 p-4">
      <p className="text-[14px] font-semibold">Временные пароли новых сотрудников</p>
      <p className="mt-1 text-[13px] text-ink-muted">
        Показываем один раз — система их не хранит. Раздайте сотрудникам и попросите сменить при первом
        входе. Потеряли — задайте новый пароль в разделе «Сотрудники».
      </p>
      <div className="mt-3 overflow-auto rounded-field border border-line">
        <table className="w-full text-[13px]">
          <thead className="bg-surface-raised text-left text-ink-dim">
            <tr>
              <th className="px-3 py-1.5 font-medium">Имя</th>
              <th className="px-3 py-1.5 font-medium">Логин</th>
              <th className="px-3 py-1.5 font-medium">Пароль</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {list.map((p) => (
              <tr key={p.login}>
                <td className="px-3 py-1.5">{p.name}</td>
                <td className="px-3 py-1.5 font-mono">{p.login}</td>
                <td className="px-3 py-1.5 font-mono font-semibold">{p.password}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onClick={() => void copyText(text).then((ok) => ok && setCopied(true))}
        >
          {copied ? "Скопировано" : "Скопировать всё"}
        </Button>
        <Button variant="secondary" icon={<IconDownload />} onClick={download}>
          Скачать .txt
        </Button>
        <div className="ml-auto">
          <Button variant="secondary" onClick={onHide}>
            Записал — скрыть
          </Button>
        </div>
      </div>
    </div>
  );
}

function ImportCard({ reference }: { reference: DataReference }) {
  const [dataset, setDataset] = useState<DatasetKey>(
    reference.datasets.some((d) => d.key === "customers") ? "customers" : reference.datasets[0]?.key ?? "customers"
  );
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
          {reference.datasets.filter((d) => d.canImport !== false).map((d) => (
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
            {result.restored > 0 && `, вернулось из удалённых ${result.restored}`}
            {result.failed.length > 0 && `, не удалось ${result.failed.length}`}
          </Banner>
          {result.passwords && result.passwords.length > 0 && (
            <PasswordsBlock
              list={result.passwords}
              onHide={() => setResult({ ...result, passwords: [] })}
            />
          )}
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

/**
 * Тестовые данные — владельцу.
 *
 * Завести можно только в пустую базу: смешать двадцать выдуманных заказов с
 * настоящими — значит потом разбирать, где чьи. Убрать — всегда, одной
 * кнопкой (она же в полосе вверху экрана).
 */
function DemoCard() {
  const { me } = useAuth();
  const isOwner = me?.kind === "tenant" && me.user.isOwner;
  const [state, setState] = useState<DemoState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    if (isOwner) demoApi.state().then(setState).catch(() => {});
  }, [isOwner]);

  if (!isOwner || !state) return null;
  if (!state.active && !state.canSeed) return null;

  async function seed() {
    setBusy(true);
    setError(null);
    try {
      await demoApi.seed();
      reloadAfterDemo();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Не удалось заполнить");
      setBusy(false);
    }
  }

  return (
    <Card>
      <SectionLabel>Тестовые данные</SectionLabel>
      {state.active ? (
        <>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-muted">
            В базе тестовые заказы ({state.orders}) и клиенты ({state.customers}). Тестовые сотрудники
            входят с паролем <b className="font-mono text-ink">{state.password}</b>:{" "}
            <span className="font-mono">{state.logins.join(", ")}</span>.
          </p>
          <div className="mt-4">
            <Button variant="danger" icon={<IconDelete />} onClick={() => setRemoving(true)}>
              Убрать тестовые данные
            </Button>
          </div>
          {removing && <RemoveDemoModal state={state} onClose={() => setRemoving(false)} />}
        </>
      ) : (
        <>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-muted">
            База пока пустая. Заполните её примером живой мастерской — 20 заказов на разных стадиях,
            клиенты, склад, прайс и 5 сотрудников, — чтобы увидеть, как всё работает. Уберёте одной
            кнопкой, когда начнёте работать.
          </p>
          {error && <div className="mt-3"><Banner tone="error">{error}</Banner></div>}
          <div className="mt-4">
            <Button variant="secondary" onClick={() => void seed()} disabled={busy}>
              {busy ? "Заполняем…" : "Заполнить тестовыми данными"}
            </Button>
          </div>
        </>
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
        {reference.datasets.filter((d) => d.canImport !== false).map((d) => (
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
        subtitle="Нумерация заказов, тестовые данные, перенос из другой программы, выгрузка и загрузка из файла."
      />
      <OrderNumberCard />
      <DemoCard />
      <MigrateCard />
      <ExportCard reference={reference} onWiped={() => void load()} />
      <ImportCard reference={reference} />
      <ColumnsCard reference={reference} />
    </div>
  );
}
