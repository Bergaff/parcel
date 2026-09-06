# попутка. — доска попутных передач

Сайт для поиска передачи посылок между городами и странами. Водители международных и межгородских рейсов публикуют, что готовы взять посылку; либо человек ищет, кто поможет передать. Плюс Telegram-бот, который собирает объявления из чатов водителей и релокантов и кладёт их на доску.

**Стек:**
- **Cloudflare Pages** — статическая страница объявлений (`public/`)
- **Cloudflare Workers** + [Hono](https://hono.dev/) — парсер Telegram, API и бот
- Cloudflare **D1** (SQLite) — объявления, жалобы, учёт обработанных сообщений
- Cloudflare **KV** — сессии бота, rate limit
- Telegram Bot API — вебхук без сторонних SDK

## Что умеет

- **Доска объявлений**: фильтр по типу («водитель везёт» / «нужно передать»), маршруту, дате, поиск.
- **Публикация с сайта**: форма → модерация → публикация.
- **Telegram-бот**:
  - добавляется в чат и распознаёт объявления: маршрут, дата, вес, цена, контакты;
  - присылает вам в личку каждое распознанное объявление с кнопками «Одобрить / Отклонить»;
  - в личке: `/post` — мастер размещения, `/pending` — очередь модерации (для админов).
- **Жалобы**: 3 жалобы — объявление автоматически скрывается.
- **Правовые страницы**: «Условия использования» (`#/terms`) и «Политика приватности» (`#/privacy`).

---

## 1. Сначала: создать бота (отдельный аккаунт не нужен!)

Завести **новый Telegram-аккаунт-человека для парсинга НЕ нужно** — это называется «юзербот», он нарушает правила Telegram и его банят. Вам нужен **бот** — это отдельная «учётка», которую создаёт сам Telegram, без телефона и без вашего входа в неё:

1. Откройте **@BotFather** в своём Telegram.
2. `/newbot` → имя (например, `Попутка доска`) → юзернейм (например, `poputchka_ua_pl_bot`).
3. BotFather выдаст **токен** вида `123456789:AAAA...`. Это `BOT_TOKEN`.
4. Там же: `/setprivacy` → **Disable** (обязательно! иначе бот в группах не видит сообщения).
5. `/setjoingroups` → **Enable**.
6. Быстро проверьте: нажмите Start у своего бота (это нужно и для того, чтобы бот мог писать вам личные сообщения).

Ваш Telegram ID для модерации: напишите **@userinfobot** — он пришлёт `Id: 123456789`. Это `ADMIN_IDS`.

---

## 2. Создать ресурсы Cloudflare (D1 + KV)

В `wrangler.toml` сейчас стоят заглушки `REPLACE_WITH_YOUR_...`. Выполните локально, в папке проекта:

```bash
npm install

# создать базу D1 — в ответе будет database_id
npx wrangler d1 create poputchka-db

# создать KV namespace — в ответе будет id
npx wrangler kv namespace create KV
```

Впишите оба идентификатора в `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "poputchka-db"
database_id = "ВАШ_D1_ID"

[[kv_namespaces]]
binding = "KV"
id = "ВАШ_KV_ID"
```

⚠️ Пока стоят заглушки `REPLACE_WITH_...`, деплой воркера будет падать уже на биндингах. Сначала создайте ресурсы и подставьте ID, затем деплойте.

## 3. Секреты воркера

```bash
npx wrangler secret put BOT_TOKEN        # токен от @BotFather
npx wrangler secret put BOT_SECRET       # любая длинная случайная строка
npx wrangler secret put SITE_URL         # адрес Pages, напр. https://parcel.pages.dev
npx wrangler secret put BOT_USERNAME     # юзернейм бота без @
npx wrangler secret put ADMIN_IDS        # ваш Telegram ID, напр. 123456789
npx wrangler secret put AUTO_APPROVE     # "0" (все объявления через вашу модерацию)
npx wrangler secret put ADMIN_API_TOKEN  # случайный токен для админ-API
```

Секреты задаются один раз и в Git не попадают.

---

## 4. Задеплоить Воркер (это не Pages!)

Сначала, почему упал ваш билд. Причин было две:

1. **Билд собирал ветку `main`, а в ней нет кода.** Сейчас в `main` репозитория лежит только `README.md`. Весь код (включая `public/` и `wrangler.toml`) — на ветке `arena/01a07723-parcel`. Отсюда «Could not detect a directory containing static files».
2. **Cloudflare просил `wrangler.toml` с `name = 'parcel'`** (сообщение «Update wrangler.toml … keep settings consistent»). Исправлено: `name = "parcel"` теперь совпадает с именем вашего проекта.

Что сделать: **смержите открытый PR** из `arena/01a07723-parcel` в `main` (тогда и Pages, и воркер соберутся), либо в настройках проекта переключите **Production branch** на `arena/01a07723-parcel` без мержа.

Воркер деплоится **из вашего компьютера** или **через GitHub Actions**, но НЕ через страницу «Builds» в Pages-проекте. Поэтому в Pages-проекте уберите «Deploy command: npx wrangler deploy» (см. раздел 5).

### Вариант А. Авто-деплой через GitHub Actions (рекомендую)

Файл `.github/workflows/deploy-worker.yml` уже лежит в репозитории — копировать ничего не нужно. Workflow запускается при push в `main` (и вручную через Actions → Deploy Worker → Run workflow).

Теперь в GitHub → репозиторий → Settings → Secrets and variables → Actions → New repository secret:
- `CLOUDFLARE_API_TOKEN` — токен из Cloudflare (My Profile → API Tokens → Create Token → шаблон **Edit Cloudflare Workers**)
- `CLOUDFLARE_ACCOUNT_ID` — ваш account id (справа на главной странице дашборда)

После этого каждый push в `main` применяет миграции и деплоит воркер.

### Вариант Б. Локально, одной командой

```bash
npm run db:remote          # применить миграции D1 на проде
npm run deploy             # задеплоить воркер
```

Адрес воркера: Workers & Pages → воркер `parcel` → Settings → Domains, вида `https://parcel.ваш-поддомен.workers.dev`.

---

## 5. Исправить Pages (страница объявлений)

Сейчас ваш продукт в Pages называется `parcel`, и там стоит сломанный «Deploy command: npx wrangler deploy». Настройки Pages должны быть:

- **Build command**: пусто
- **Output directory**: `public`
- **Deploy command**: пусто (уберите `npx wrangler deploy`)
- **Root directory**: `/`
- **Production branch**: `main` после мержа PR (или `arena/01a07723-parcel`, пока не смержили)

Сохраните и перезапустите деплой. Страница будет собираться из папки `public/` при каждом push.

(Cloudflare просил обновить `wrangler.toml` для консистентности — сделано: `name = "parcel"` совпадает с именем проекта. `pages_build_output_dir` нужен не здесь: статика Pages задаётся полем **Output directory**, а не в `wrangler.toml`.)

---

## 6. Связать сайт и бота

Страница (Pages) не знает, где воркер. Пропишите адрес воркера в `public/index.html`:

```html
<script>
  window.POPUTKA_API_BASE = "https://parcel.ваш-поддомен.workers.dev";
</script>
```

Запушьте и перелейте Pages. Всё: сайт будет ходить в API воркера (CORS уже настроен).

Затем установите вебхук **на адрес воркера** (не Pages!). Локально:

```bash
cp .dev.vars.example .dev.vars   # впишите WORKER_URL = адрес воркера
npm run telegram:webhook
```

Либо вручную (без скрипта), откройте в браузере:

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<адрес-воркера>/api/telegram/<BOT_SECRET>&allowed_updates=message,channel_post,callback_query
```

Проверка: `https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo` → `url` должен указывать на воркер, `pending_update_count: 0` после первого сообщения.

---

## 7. Подключить бота к чатам и получать одобрения

1. **Добавьте бота в чаты.** Бот не может «подписаться» сам: его добавляет администратор чата (или вы, если вы админ). Напишите в чате `@имя_бота` или настройте бота как участника. Для супергрупп роль участника достаточно — главное, чтобы `/setprivacy` был **Disable**.
2. **Бот парсит только сообщения, пришедшие после добавления** — историю он не читает. Это нормально: объявления копятся вперёд.
3. **Вы в Telegram видите каждое объявление с кнопками.** Когда бот находит что-то похожее на объявление или кто-то размещает через сайт/личку, он пишет вам в личный чат (адрес `ADMIN_IDS`) с кнопками:
   - **Одобрить** — объявление появляется на сайте;
   - **Отклонить** — не появляется.
4. Очередь на модерацию: напишите боту `/pending` — покажет последние заявки с теми же кнопками.
5. Если хотите публиковать без модерации (например, на время старта): `AUTO_APPROVE=1` → `wrangler secret put AUTO_APPROVE`, введите `1`.

---

## Переменные окружения

| Переменная | Описание |
|---|---|
| `BOT_TOKEN` | токен бота от @BotFather |
| `BOT_SECRET` | секрет в URL вебхука `/api/telegram/:secret` |
| `SITE_URL` | публичный адрес сайта (Pages) для ссылок |
| `BOT_USERNAME` | юзернейм бота без @, для ссылки «Открыть бота» |
| `ADMIN_IDS` | Telegram ID модераторов через запятую |
| `AUTO_APPROVE` | `1` — публиковать без модерации |
| `ADMIN_API_TOKEN` | токен для `/api/admin/*` |
| `REPLY_IN_GROUPS` | `1` — бот отвечает в группах после распознавания (по умолчанию молчит) |

`WORKER_URL` используется только скриптом `set-webhook.mjs` (и `.dev.vars`), в воркер не передаётся.

---

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
| GET | `/api/health` | проверка воркера |

---

## Локальная разработка

```bash
npm install
npm run db:local
cp .dev.vars.example .dev.vars
npm run dev                # http://localhost:8787
npm run typecheck && npm test
```

## Как улучшить парсер

Парсер в `src/parser.ts` работает эвристически (словарь городов, маршруты, даты, вес, цена). Чтобы меньше пропускать:
- расширяйте `CITY_FORMS` под свои чаты;
- добавляйте фразы в `OFFER_HINTS` / `REQUEST_HINTS`;
- поднимайте порог `confidence` в `telegram.ts` (сейчас 0.7).

## Структура

```
src/
  index.ts      — Hono: API, CORS, вебхук Telegram
  telegram.ts   — бот: группы, личка, модерация
  parser.ts     — парсер сообщений из чатов
  store.ts      — D1: объявления, жалобы, dedupe
  types.ts      — типы
  util.ts       — валидация, rate limit, утилиты
public/         — статика Pages (index.html, styles.css, app.js)
migrations/     — схема D1
scripts/        — установка/удаление вебхука
deploy-workflows/ — шаблон авто-деплоя воркера
```
