# Собирается из корня репозитория (см. docker-compose.yml): кроме самого
# интерфейса, в образ кладутся модели распознавателя шильдиков.
FROM node:20-alpine AS build
WORKDIR /app
COPY frontend/package.json ./
# Таймауты держим короткими намеренно: при сломанной сети внутри контейнера
# длинные значения превращают падение сборки в час ожидания вместо понятной ошибки.
RUN npm config set fetch-retries 3 \
 && npm config set fetch-retry-mintimeout 5000 \
 && npm config set fetch-retry-maxtimeout 30000 \
 && npm config set fetch-timeout 120000 \
 && npm install --no-audit --no-fund
COPY frontend/ .
RUN npm run build

# Распознавание шильдиков на устройстве сотрудника: модели — из репозитория,
# движки — из node_modules этой же сборки, той же версии, что и код, который
# их вызывает (разные версии движка и обвязки вместе не работают).
COPY desktop/ocr-models/*.onnx desktop/ocr-models/ppocr_keys.txt ./dist/ocr-models/
RUN cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm \
       node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs \
       node_modules/zxing-wasm/dist/reader/zxing_reader.wasm \
       ./dist/ocr-models/

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
