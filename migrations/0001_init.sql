-- Таблица объявлений
CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('offer', 'request')),      -- offer: водитель везёт; request: нужно передать
  from_city TEXT NOT NULL,
  to_city TEXT NOT NULL,
  departure_date TEXT,                                          -- YYYY-MM-DD или NULL
  weight_kg REAL,                                               -- вес посылки, кг
  price TEXT,                                                   -- строка как в объявлении, напр. "50 zł"
  description TEXT NOT NULL,
  phone TEXT,
  telegram TEXT,                                                -- @username или t.me/username
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'rejected', 'expired')),
  source TEXT NOT NULL DEFAULT 'site' CHECK (source IN ('site', 'telegram', 'parser')),
  source_chat TEXT,                                             -- название чата, откуда пришло объявление
  source_chat_id TEXT,
  source_message_id INTEGER,
  created_at TEXT NOT NULL,
  published_at TEXT,
  views INTEGER NOT NULL DEFAULT 0,
  stats_offers INTEGER NOT NULL DEFAULT 0,                       -- резерв под статистику
  stats_requests INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_listings_status ON listings (status);
CREATE INDEX IF NOT EXISTS idx_listings_type ON listings (type);
CREATE INDEX IF NOT EXISTS idx_listings_route ON listings (from_city, to_city);
CREATE INDEX IF NOT EXISTS idx_listings_created ON listings (created_at DESC);

-- Жалобы на объявления
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  reason TEXT,
  reporter_ip TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reports_listing ON reports (listing_id);

-- Учёт обработанных сообщений Telegram (защита от повторной вставки по одному сообщению)
CREATE TABLE IF NOT EXISTS tg_seen (
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  listing_id TEXT,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
