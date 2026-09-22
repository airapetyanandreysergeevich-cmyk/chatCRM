/**
 * Распознаватель локальной версии — на тех же шильдиках, что и разбор.
 *
 * src/lib/ocr/engine.ts повторяет конвейер RapidOCR без OpenCV. Модели те же,
 * и проверяем мы не «что-то распознало», а что нашлись строки, из которых
 * разбор достанет модель и серийный номер: номер — буква в букву.
 *
 * Модели — в desktop/ocr-models (их туда кладёт репозиторий), движок —
 * onnxruntime-web, тот же, что в окне программы.
 *
 *   npx tsx test/ocr-engine.ts
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";
import * as ort from "onnxruntime-web";
import { charactersFrom, recognizeText, type RunModel } from "../src/lib/ocr/engine";

// Интерфейс — ES-модули: __dirname здесь нет.
const here = dirname(fileURLToPath(import.meta.url));
const MODELS = process.env.OCR_MODELS ?? join(here, "..", "..", "desktop", "ocr-models");
const IMAGES = join(here, "fixtures", "plates");

let fails = 0;
const check = (ok: boolean, msg: string) => {
  console.log((ok ? "ok    " : "БЕДА  ") + msg);
  if (!ok) fails += 1;
};

// Что должно найтись на каждом шильдике: сжатая строка содержит эти куски.
const expected: Record<string, string[]> = {
  "asus-d509": ["SN:M1N0CV151457038", "D509DJ-BQ068", "ASUS"],
  "asus-m3407": ["SN:T6N0KD00W03025C", "M3407HA-SF088"],
  "lenovo-g580": ["S/N:WB06815442", "LenovoG580"],
  "lenovo-s20": ["S/N:UB03123504", "S20-30Touch"],
  "acer-5820": ["LXR3F01003036087732500", "Aspire5820T"],
  "samsung-rv520": ["S/N:HL1X93FB900378L", "NP-RV520"],
  "samsung-r710": ["S/N:EX9493BQA00011W", "NP-R710H"],
};

(async () => {
  ort.env.wasm.numThreads = 1;
  const files = { det: "ch_PP-OCRv4_det_infer.onnx", cls: "ch_ppocr_mobile_v2.0_cls_infer.onnx", rec: "ch_PP-OCRv4_rec_infer.onnx" };
  const sessions: Record<string, ort.InferenceSession> = {};
  for (const [k, f] of Object.entries(files)) {
    sessions[k] = await ort.InferenceSession.create(readFileSync(join(MODELS, f)), { executionProviders: ["wasm"] });
  }
  const characters = charactersFrom(readFileSync(join(MODELS, "ppocr_keys.txt"), "utf8"));
  check(characters.length === 6625, `словарь модели: ${characters.length} знаков вместе с пустым и пробелом`);

  const run: RunModel = async (model, data, dims) => {
    const s = sessions[model];
    const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("float32", data, dims) });
    const t = out[s.outputNames[0]];
    return { data: t.data as Float32Array, dims: t.dims };
  };

  for (const [name, want] of Object.entries(expected)) {
    const img = jpeg.decode(readFileSync(join(IMAGES, `${name}.jpg`)), { useTArray: true });
    const started = Date.now();
    const lines = await recognizeText({ data: img.data, width: img.width, height: img.height }, run, characters);
    const ms = Date.now() - started;
    const flat = lines.map((l) => l.text.replace(/\s+/g, ""));
    for (const piece of want) {
      check(flat.some((t) => t.includes(piece)), `${name.padEnd(14)} ${piece} (${ms} мс)`);
    }
    check(lines.every((l) => l.box.every((v) => v >= 0 && v <= 1)), `${name.padEnd(14)} рамки строк — в долях снимка`);
  }

  console.log(fails === 0 ? "\nвсе проверки прошли" : `\nпровалов: ${fails}`);
  process.exitCode = fails === 0 ? 0 : 1;
})().catch((err) => {
  console.error("сорвалось:", err);
  process.exitCode = 1;
});
