# Модели распознавателя шильдиков

Модели PaddleOCR PP-OCRv4 (поиск строк, чтение) и ppocr mobile v2.0 (поворот) в формате ONNX — те же, что использует RapidOCR 1.4.4 в облачном сервисе `ocr/`. Лицензия Apache 2.0 (PaddleOCR, RapidOCR).

`ppocr_keys.txt` — словарь модели чтения, извлечён из её метаданных (6623 знака).

Файлы движков (`*.wasm`, `*.mjs`) в репозитории не хранятся: их копирует `node scripts/ocr-assets.js` из `frontend/node_modules` перед сборкой установщика (это делает `npm run dist` сам).
