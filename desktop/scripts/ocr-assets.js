"use strict";

/**
 * Файлы движка распознавателя шильдиков — в desktop/ocr-models.
 *
 * Модели (.onnx) и словарь лежат в репозитории. Движки — onnxruntime-web и
 * zxing-wasm — приходят из node_modules интерфейса, той же версии, что и код,
 * который их вызывает: разные версии движка и обвязки не работают вместе.
 * Поэтому они не хранятся в репозитории, а копируются перед сборкой.
 *
 *   node scripts/ocr-assets.js
 */

const fs = require("fs");
const path = require("path");

const here = path.join(__dirname, "..");
const front = path.join(here, "..", "frontend", "node_modules");
const target = path.join(here, "ocr-models");

const files = [
  [path.join(front, "onnxruntime-web", "dist", "ort-wasm-simd-threaded.wasm"), "ort-wasm-simd-threaded.wasm"],
  [path.join(front, "onnxruntime-web", "dist", "ort-wasm-simd-threaded.mjs"), "ort-wasm-simd-threaded.mjs"],
  [path.join(front, "zxing-wasm", "dist", "reader", "zxing_reader.wasm"), "zxing_reader.wasm"],
];

let missing = 0;
fs.mkdirSync(target, { recursive: true });
for (const [from, name] of files) {
  if (!fs.existsSync(from)) {
    console.error(`Нет ${from}. Выполните: cd frontend && npm install`);
    missing += 1;
    continue;
  }
  fs.copyFileSync(from, path.join(target, name));
  console.log(`ocr-models/${name} — ${(fs.statSync(from).size / 1048576).toFixed(1)} МБ`);
}
process.exitCode = missing ? 1 : 0;
