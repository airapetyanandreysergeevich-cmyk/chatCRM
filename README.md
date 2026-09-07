# RepairShop

Облачная CRM для мастерских по ремонту техники. Множество независимых мастерских на одном сервере: собственник платформы заводит владельцев мастерских, владелец заводит своих сотрудников, данные мастерских друг для друга не существуют.

Архитектура, роли, состав бланка приёма и жизненный цикл заказа описаны в проекте Claude «RepairShop», документ `architecture.md`.

## Стек

| Слой | Что используется |
| --- | --- |
| Бэкенд | Node.js 20, TypeScript, Express, Prisma, PostgreSQL 16 |
| Аутентификация | JWT: access 15 мин + refresh 30 дней, пароли — scrypt из стандартной библиотеки Node |
| Файлы | MinIO (S3-совместимое), приватный бакет, подписанные ссылки |
| Фронтенд | React 18, TypeScript, Vite, Tailwind CSS, react-router |
| Инфраструктура | Docker Compose, nginx, Let's Encrypt |

## Структура

```
backend/          API
  prisma/
    schema.prisma   модель данных
    rls.sql         политики Row-Level Security
    seed.ts         создание собственника платформы
  src/
    lib/db.ts       клиент Prisma, withTenant() и tenantClient()
    lib/permissions.ts  коды прав и пять ролей-пресетов
    middleware/auth.ts  разбор JWT, проверка прав
    services/tenant.ts  создание мастерской «под ключ»
frontend/         SPA
deploy/           .env.example, install.sh, update.sh, nginx, HTTPS
docs/             заметки по ходу разработки
```

## Изоляция данных мастерских

Одна база, `tenantId` в каждой таблице арендатора, два независимых рубежа:

1. **PostgreSQL RLS.** Каждый запрос идёт в транзакции, где выполнен `set_config('app.tenant_id', ...)`. Политики из `prisma/rls.sql` отсекают чужие строки на уровне СУБД — даже если в коде забыли фильтр.
2. **Расширение Prisma Client.** `tenantClient(tenantId)` подставляет `tenantId` в `where` и `data` автоматически.

`tenantId` берётся **только из JWT** — никогда из тела запроса, заголовка или параметра URL.

Таблицы платформы (`Tenant`, `PlatformUser`, `PlatformAuditLog`, `Impersonation`, `Session`) под RLS не попадают: к ним ходит отдельный слой приложения.

Вход собственника платформы в базу мастерской возможен только через режим «войти как» и всегда пишется в `Impersonation` — эта история видна владельцу мастерской.

## Локальная разработка

```bash
# 1. база и хранилище
docker compose --env-file deploy/.env up -d postgres minio

# 2. бэкенд
cd backend
npm install
npx prisma migrate dev
npm run seed          # создаст собственника платформы из PLATFORM_OWNER_*
npm run dev           # http://localhost:4000

# 3. фронтенд
cd ../frontend
npm install
npm run dev           # http://localhost:5173, /api проксируется на 4000
```

## Первая установка на сервер

```bash
git clone <репозиторий> /root/repairshop
cd /root/repairshop
bash deploy/install.sh                    # создаст .env, сгенерирует секреты, поднимет контейнеры
bash deploy/setup-https.sh crm.example.ru # сертификат и переключение на HTTPS
```

## Обновление

```bash
cd /root/repairshop
bash deploy/update.sh    # git pull + пересборка + prisma migrate deploy
```

## Миграции

Только версионные. `prisma db push` и `--accept-data-loss` в этом проекте не используются: на сервере лежат данные чужих мастерских, и молчаливое удаление колонки означает потерю данных клиента.

```bash
npx prisma migrate dev --name add_something   # разработка
npx prisma migrate deploy                     # сервер (делает update.sh)
```

Политики RLS применяются миграцией: создайте пустую миграцию `npx prisma migrate dev --create-only` и вставьте в её `migration.sql` содержимое `prisma/rls.sql`.

## Безопасность

- `.env`, ключи и сертификаты в репозиторий не попадают — см. `.gitignore`. Если секрет всё же попал в историю, его надо считать скомпрометированным и перевыпустить.
- Токен доступа к репозиторию на сервере — fine-grained PAT, ограниченный **одним этим репозиторием** и правом только на чтение содержимого. Хранить в `~/.git-credentials` с правами `600`, в коде и в `.env` приложения ему не место.
- Пароли — scrypt. Refresh-токены хранятся хешем, ротируются при каждом обновлении и отзываются при увольнении сотрудника.
- Файлы клиентов раздаются только по подписанным ссылкам с проверкой прав и `tenantId`. Прямой раздачи каталога загрузок через nginx быть не должно.
