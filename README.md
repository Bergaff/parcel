# 🚚 Попутная — доска попутных посылок

Сайт для поиска передачи посылок между городами и странами. Водители международных и межгородских рейсов публикуют, что готовы взять посылку; либо человек ищет, кто поможет передать. Плюс Telegram-бот, который собирает объявления из чатов водителей и релокантов и кладёт их на доску.

**Стек:**
- **Cloudflare Pages** — статическая страница объявлений (`public/`), или **Workers Assets**, если всё в одном воркере
- **Cloudflare Workers** + [Hono](https://hono.dev/) — парсер Telegram, API и бот
- Cloudflare **D1** (SQLite) — объявления, жалобы, учёт обработанных сообщений
- Cloudflare **KV** — сессии бота, rate limit
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
- **Жалобы**: 3 жалобы, объявление автоматически скрывается.
- **Правовые страницы**: «Условия использования» (`#/terms`) и «Политика приватности» (`#/privacy`).
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

## Архитектура: две схемы деплоя

Проект поддерживает оба варианта, код один и тот же.

**Вариант 1. Один воркер с Assets (по умолчанию, проще всего).**
Один воркер раздаёт и страницу, и API, и бота. Один деплой, один домен, без CORS. Подходит для старта.

**Вариант 2. Pages = страница, Worker = парсер/API/бот (то, что вы просили).**
- **Cloudflare Pages** хостит статику из `public/`: страница объявлений, карточки, форма.
- **Cloudflare Worker** содержит `src/`: парсер Telegram, вебхук бота, API `/api/*`, D1, KV.
- Фронтенд обращается к воркеру по адресу из одной строчки в `public/index.html` → `window.POPUTKA_API_BASE`. Пустая строка = API на том же домене (локальная разработка и вариант 1). Для варианта 2 впишите адрес воркера: `https://api.poputchka.workers.dev`.
- Воркер отвечает CORS-заголовками (`src/index.ts`), поэтому кросс-доменные запросы с Pages работают без настройки.

## Деплой: Вариант 1 (один воркер, быстро)

```bash
# 1. Создать D1 и KV, вписать ID в wrangler.toml
wrangler d1 create poputchka-db
wrangler kv namespace create KV

# 2. Миграции
npm run db:remote

# 3. Секреты (см. таблицу ниже)
wrangler secret put BOT_TOKEN
# ... и так далее

# 4. Деплой + вебхук
npm run deploy
npm run telegram:webhook
```

## Деплой: Вариант 2 (Pages + Worker)

### Шаг 1. Воркер (парсер, API, бот)

```bash
# D1 + KV, потом ID в wrangler.toml (если ещё не сделано)
wrangler d1 create poputchka-db
wrangler kv namespace create KV

# миграции и секреты
npm run db:remote
wrangler secret put BOT_TOKEN
wrangler secret put BOT_SECRET
wrangler secret put SITE_URL       # адрес страницы Pages: https://poputchka.pages.dev
wrangler secret put BOT_USERNAME
wrangler secret put ADMIN_IDS
wrangler secret put AUTO_APPROVE
wrangler secret put ADMIN_API_TOKEN
wrangler secret put REPLY_IN_GROUPS

# деплой воркера
npx wrangler deploy
# получите адрес вида https://poputchka-api-<хэш>.<поддомен>.workers.dev
```

### Шаг 2. Pages (страница объявлений)

```bash
# создать проект Pages (один раз)
npx wrangler pages project create poputchka

# деплой статики
npx wrangler pages deploy public --project-name poputchka
# получите адрес вида https://poputchka.pages.dev
```

### Шаг 3. Связать их

1. В `public/index.html` впишите адрес воркера:
   ```html
   <script>
     window.POPUTKA_API_BASE = "https://poputchka-api-ХЭШ.ПОДДОМЕН.workers.dev";
   </script>
   ```
2. Перелейте Pages снова:
   ```bash
   npx wrangler pages deploy public --project-name poputchka
   ```
3. Установите вебхук бота на адрес воркера:
   ```bash
   npm run telegram:webhook   # читает SITE_URL из .dev.vars или env
   ```
   Либо вручную: `setWebhook` → `https://ВАШ-ВОРКЕР/api/telegram/ВАШ-СЕКРЕТ`.

4. (Необязательно, красивее) свой домен: в Cloudflare Pages добавьте кастомный домен `poputchka.ru`, а воркеру решите поддомен `api.poputchka.ru` в Workers → Routes и укажите его в `POPUTKA_API_BASE`.

### Важно

- **Бот в группах**: в @BotFather `/setprivacy` → Disable и `/setjoingroups` → Enable.
- **Секреты и .dev.vars различны**: при локальном запуске берутся из `.dev.vars`, на проде — `wrangler secret put`.
- После изменения `public/` Pages перелейте, после изменения `src/` воркер: `npx wrangler deploy`.

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
