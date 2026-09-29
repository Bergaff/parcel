-- SEO-видимость: присутствие сайта в открытых корпусах (Common Crawl, Wayback)
-- и позиции в поиске (SerpApi). Всё — бесплатные источники.

-- Один замер присутствия: коллекция Common Crawl (CC-MAIN-…) или Wayback.
CREATE TABLE IF NOT EXISTS ai_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,             -- 'commoncrawl' | 'wayback'
  label TEXT NOT NULL,            -- id коллекции CC или 'wayback'
  pages INTEGER NOT NULL DEFAULT 0,
  urls TEXT,                      -- JSON-массив URL (для CC — что именно краулер видел)
  checked_at TEXT NOT NULL
);

-- Отслеживаемые поисковые запросы. engine: 'google' (hl=ru, gl=by) или
-- 'yandex' (lr=157 — Минск). 20 запросов в неделю = ~85/мес — влезает
-- в бесплатный лимит SerpApi (100 поисков/мес).
CREATE TABLE IF NOT EXISTS serp_queries (
  id TEXT PRIMARY KEY,
  engine TEXT NOT NULL DEFAULT 'google',
  query TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- Результат проверки позиции: position NULL — сайта нет в топ-20.
CREATE TABLE IF NOT EXISTS serp_checks (
  id TEXT PRIMARY KEY,
  query_id TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  position INTEGER,
  found_url TEXT,
  top TEXT                       -- JSON: кто в топ-5 (домены), чтобы видеть конкурентов
);
CREATE INDEX IF NOT EXISTS idx_serp_checks_query_time
  ON serp_checks(query_id, checked_at DESC);

-- Стартовый набор запросов: как люди ищут передачу посылок по нашим направлениям.
INSERT OR IGNORE INTO serp_queries (id, engine, query, active, created_at) VALUES
  ('q01', 'google', 'передать посылку варшава минск', 1, datetime('now')),
  ('q02', 'google', 'передать посылку минск варшава', 1, datetime('now')),
  ('q03', 'google', 'попутка передачка груз', 1, datetime('now')),
  ('q04', 'google', 'передать посылку брест варшава', 1, datetime('now')),
  ('q05', 'google', 'доставка посылок попутным транспортом', 1, datetime('now')),
  ('q06', 'google', 'попутка груз гродно белосток', 1, datetime('now')),
  ('q07', 'google', 'передать документы варшава минск', 1, datetime('now')),
  ('q08', 'google', 'поиск попутки для посылки', 1, datetime('now')),
  ('q09', 'google', 'посылка попутчикам минск москва', 1, datetime('now')),
  ('q10', 'google', 'передать посылку варшава гродно', 1, datetime('now')),
  ('q11', 'yandex', 'попутка передача посылок', 1, datetime('now')),
  ('q12', 'yandex', 'передать посылку варшава минск', 1, datetime('now')),
  ('q13', 'yandex', 'доска объявлений попутки посылки', 1, datetime('now')),
  ('q14', 'yandex', 'возить посылки попутно варшава', 1, datetime('now')),
  ('q15', 'yandex', 'передачка груза брест минск', 1, datetime('now')),
  ('q16', 'yandex', 'попутный перевозчик посылок польша беларусь', 1, datetime('now')),
  ('q17', 'yandex', 'найти попутку для передачи посылки', 1, datetime('now')),
  ('q18', 'yandex', 'посылки попутками минск варшава', 1, datetime('now')),
  ('q19', 'yandex', 'передача вещей попутчиками гродно', 1, datetime('now')),
  ('q20', 'yandex', 'попутка доставка белосток минск', 1, datetime('now'));
