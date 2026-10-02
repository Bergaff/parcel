-- Статистика аудитории для медиакита (/mediakit) и настройки сайта.

-- Каждый просмотр контентной страницы (включая попадания edge-кэша).
-- vid — обезличенный суточный идентификатор посетителя (хеш, IP не хранится).
CREATE TABLE IF NOT EXISTS stat_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  day TEXT NOT NULL,
  vid TEXT NOT NULL,
  kind TEXT NOT NULL,
  bot INTEGER NOT NULL DEFAULT 0,
  country TEXT,
  device TEXT,
  os TEXT,
  dc INTEGER NOT NULL DEFAULT 0,
  ref_group TEXT,
  ref_host TEXT
);
CREATE INDEX IF NOT EXISTS idx_stat_views_day ON stat_views(day);

-- «Подтверждены браузером»: посетитель дня, чей браузер выполнил JS-маячок.
CREATE TABLE IF NOT EXISTS stat_js (
  day TEXT NOT NULL,
  vid TEXT NOT NULL,
  PRIMARY KEY (day, vid)
);

-- Чаты, с которыми бот Telegram работал (для блока статистики бота).
CREATE TABLE IF NOT EXISTS stat_bot_chats (
  chat_id TEXT PRIMARY KEY,
  last_seen TEXT NOT NULL
);

-- Настройки сайта (key-value): доступ к медиакиту задаётся из админки.
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
