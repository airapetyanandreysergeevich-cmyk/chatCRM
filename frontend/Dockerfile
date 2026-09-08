FROM node:20-alpine AS build
WORKDIR /app
COPY package.json ./
# Таймауты держим короткими намеренно: при сломанной сети внутри контейнера
# длинные значения превращают падение сборки в час ожидания вместо понятной ошибки.
RUN npm config set fetch-retries 3 \
 && npm config set fetch-retry-mintimeout 5000 \
 && npm config set fetch-retry-maxtimeout 30000 \
 && npm config set fetch-timeout 120000 \
 && npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
