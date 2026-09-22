/**
 * Распознавание шильдика прямо в окне программы — для локальной версии.
 *
 * В облаке снимок распознаёт отдельный сервис ocr. В локальной версии его
 * нет: Основа стоит на обычном компьютере мастерской, и тащить туда Python
 * с распознавателем незачем. Поэтому здесь те же модели PaddleOCR работают
 * в самом окне через onnxruntime-web, а штрихкоды читает zxing-wasm. Файлы
 * моделей раздаёт локальный сервер по адресу /ocr-models/ — больше их
 * нигде нет, и облачным пользователям этот модуль никогда не загружается.
 *
 * Разбор — что бренд, что серийный номер — остаётся на сервере, общий с
 * облаком: сюда уходят только строки текста, а не снимок.
 */

import type { InferenceSession, Tensor } from "onnxruntime-web";
import { charactersFrom, recognizeText, type OcrLine, type RunModel } from "./engine";
import { url } from "../basePath";

const BASE = url("ocr-models/");

const MODELS = {
  det: "ch_PP-OCRv4_det_infer.onnx",
  cls: "ch_ppocr_mobile_v2.0_cls_infer.onnx",
  rec: "ch_PP-OCRv4_rec_infer.onnx",
} as const;

interface Engine {
  run: RunModel;
  characters: string[];
}

let loading: Promise<Engine> | null = null;

/**
 * Загрузить распознаватель один раз на всё время работы окна: модели весят
 * 16 МБ, и второй шильдик не должен ждать их заново.
 */
function engine(): Promise<Engine> {
  if (!loading) {
    loading = (async () => {
      const ort = await import("onnxruntime-web/wasm");
      ort.env.wasm.wasmPaths = BASE;
      // Считать в отдельном потоке: иначе окно замирает на несколько секунд,
      // пока идёт распознавание, и кажется, что программа зависла.
      ort.env.wasm.proxy = true;
      // Потоки доступны, только когда страница изолирована (заголовки
      // COOP/COEP ставит локальный сервер). Иначе — один поток, медленнее,
      // но работает.
      ort.env.wasm.numThreads = globalThis.crossOriginIsolated
        ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1))
        : 1;

      const [det, cls, rec, keys] = await Promise.all([
        ort.InferenceSession.create(BASE + MODELS.det, { executionProviders: ["wasm"] }),
        ort.InferenceSession.create(BASE + MODELS.cls, { executionProviders: ["wasm"] }),
        ort.InferenceSession.create(BASE + MODELS.rec, { executionProviders: ["wasm"] }),
        fetch(BASE + "ppocr_keys.txt").then((r) => {
          if (!r.ok) throw new Error("Нет словаря распознавателя");
          return r.text();
        }),
      ]);
      const sessions: Record<keyof typeof MODELS, InferenceSession> = { det, cls, rec };

      const run: RunModel = async (model, data, dims) => {
        const s = sessions[model];
        const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", data, dims) });
        const t = out[s.outputNames[0]] as Tensor;
        return { data: t.data as Float32Array, dims: t.dims };
      };
      return { run, characters: charactersFrom(keys) };
    })();
    // Неудачную загрузку не запоминаем: следующая попытка начнёт заново.
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

/** Штрихкоды и QR. Ошибка чтения кодов не мешает распознаванию текста. */
async function barcodes(image: ImageData): Promise<Array<{ format: string; text: string }>> {
  try {
    const zx = await import("zxing-wasm/reader");
    zx.prepareZXingModule({ overrides: { locateFile: (path: string) => BASE + path } });
    const found = await zx.readBarcodes(image, { tryHarder: true, maxNumberOfSymbols: 8 });
    const seen = new Set<string>();
    return found
      .filter((b) => b.isValid && b.text.trim())
      .filter((b) => (seen.has(b.text) ? false : (seen.add(b.text), true)))
      .map((b) => ({ format: String(b.format), text: b.text.trim() }));
  } catch {
    return [];
  }
}

async function imageDataOf(blob: Blob): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Браузер не дал прочитать снимок");
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

/** Снимок → строки текста и штрихкоды, как их отдаёт облачный сервис ocr. */
export async function recognizeHere(image: Blob): Promise<{ lines: OcrLine[]; barcodes: Array<{ format: string; text: string }> }> {
  const [data, e] = await Promise.all([imageDataOf(image), engine()]);
  const [lines, codes] = await Promise.all([recognizeText(data, e.run, e.characters), barcodes(data)]);
  return { lines, barcodes: codes };
}

/** Прогреть заранее, пока приёмщик наводит камеру: модели грузятся секунду-две. */
export function warmUp(): void {
  void engine().catch(() => {});
}
