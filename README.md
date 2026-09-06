# 🚚 Попутная — доска попутных посылок

Сайт для поиска передачи посылок между городами и странами. Водители международных и межгородских рейсов публикуют, что готовы взять посылку; либо человек ищет, кто поможет передать. Плюс Telegram-бот, который собирает объявления из чатов водителей и релокантов и кладёт их на доску.

**Стек:**
- Cloudflare Workers + [Hono](https://hono.dev/) — один воркер: сайт, API и Telegram-бот
- Cloudflare **D1** (SQLite) — объявления, жалобы, учёт обработанных сообщений
- Cloudflare **KV** — сессии бота, rate limit
- Cloudflare Workers **Assets** — статический фронтенд (vanilla JS, без сборки)
- Telegram Bot API — вебхук без сторонних SDK

## Что умеет

- **Доска объявлений**: фильтр по типу («водитель везёт» / «нужно передать»), маршруту, дате, поиск.
- **Публикация с сайта**: форма → модерация → публикация. Контакты (Telegram/телефон) видны сразу после публикации.
- **Telegram-бот**:
  - добавляется в любой чат; распознаёт сообщения вида «Варшава — Львов, завтра, возьму 5 кг, 100 zł, @driver»;
  - сам определяет, водитель это или ищущий, извлекает маршрут, дату, вес, цену, контакты;
  - кладёт распознанное в очередь на модерацию (или публикует сразу при `AUTO_APPROVE=1`);
  - `одобрить/отклонить` — кнопками у администраторов;
  - в личке: `/post` — мастер размещения объявления, `/pending` — очередь модерации (для админов).
- **Жалобы**: 3 жалобы — объявление автоматически скрывается.
- **Rate limit** на публикацию и жалобы (KV), защита вебхука секретом в URL.

## Быстрый старт (локально)

```bash
npm install
npm run db:local                 # применить миграции D1 в локальную БД
cp .dev.vars.example .dev.vars   # впишите BOT_TOKEN и т.д.
npm run dev                      # http://localhost:8787
```

Проверить тесты и типы:

```bash
npm run typecheck
npm test
```

## Деплой на Cloudflare (пошагово)

### 1. Создать ресурсы

```bash
npm run deploy
```

Если в `wrangler.toml` ещё стоят `REPLACE_WITH_...`, сначала создайте базу и KV:

```bash
wrangler d1 create poputchka-db
wrangler kv namespace create KV
```

Подставьте полученные `database_id` и `id` в `wrangler.toml`.

### 2. Миграции

```bash
npm run db:remote
```

### 3. Секреты

```bash
wrangler secret put BOT_TOKEN      # токен от @BotFather
wrangler secret put BOT_SECRET     # длинная случайная строка
wrangler secret put SITE_URL       # https://poputchka.workers.dev
wrangler secret put BOT_USERNAME   # юзернейм бота без @
wrangler secret put ADMIN_IDS      # Telegram ID админов через запятую
wrangler secret put AUTO_APPROVE   # "1" — публиковать без модерации (для старта)
wrangler secret put ADMIN_API_TOKEN# токен админ-API, см. ниже
```

### 4. Деплой и вебхук

```bash
npm run deploy
npm run telegram:webhook
```

### 5. Включить бота в чатах

В **@BotFather**: `/setprivacy` → **Disable** (иначе бот в группах видит только команды) и `/setjoingroups` → Enable. Затем добавьте бота в чаты водителей/релокантов. Он сам поймёт, какие сообщения — объявления.

## Переменные окружения

| Переменная | Описание |
|---|---|
| `BOT_TOKEN` | токен бота (секрет) |
| `BOT_SECRET` | секрет в URL вебхука `/api/telegram/:secret` |
| `SITE_URL` | публичный сайт |
| `BOT_USERNAME` | для ссылок «Открыть бота» |
| `ADMIN_IDS` | ID админов-модераторов, через запятую |
| `AUTO_APPROVE` | `1` — публиковать без модерации |
| `ADMIN_API_TOKEN` | токен для `/api/admin/*` |
| `REPLY_IN_GROUPS` | `1` — бот будет отвечать в группах после распознавания объявления (по умолчанию молчит) |

## API

| Метод | Путь | Описание |
|---|---|---|
| GET | `/api/listings` | список (query: `type`, `from`, `to`, `date`, `q`, `page`) |
| GET | `/api/listings/:id` | карточка (считает просмотр) |
| POST | `/api/listings` | создать (лимит 10/час с IP → модерация) |
| POST | `/api/listings/:id/report` | жалоба (3 жалобы → скрытие) |
| GET | `/api/admin/pending` | очередь модерации (`Authorization: Bearer <ADMIN_API_TOKEN>`) |
| POST | `/api/admin/listings/:id/status` | `{ "status": "published" \| "rejected" }` |
| POST | `/api/telegram/:secret` | вебхук Telegram |
| GET | `/api/health` | проверка |

## Как улучшить парсер

Парсер лежит в `src/parser.ts` и работает эвристически (словарь городов, маршруты «A → B», даты, вес, цена, контакты). Чтобы меньше пропускать сообщений:
- расширяйте `CITY_FORMS` под ваши чаты (Латвия, Чехия, Германия и т.д.);
- добавьте фразы в `OFFER_HINTS` / `REQUEST_HINTS`;
- для строгого качества поднимайте порог `confidence` в `telegram.ts` (сейчас 0.7).

## Структура

```
src/
  index.ts      — Hono-приложение (API + вебхук)
  telegram.ts   — Telegram-бот: группы, личка, модерация
  parser.ts     — парсер сообщений из чатов
  store.ts      — D1: объявления, жалобы, dedupe
  types.ts      — типы
  util.ts       — валидация, rate limit, утилиты
public/         — статика (index.html, styles.css, app.js)
migrations/     — схема D1
scripts/        — установка/удаление вебхука
```
