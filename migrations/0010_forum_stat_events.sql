-- События публикаций в форум-канал: по строчке на публикацию. Счётчик
-- forum_stats показывает только «сколько всего», а по событиям видно,
-- какой процент заявок дошёл до канала за период и что падает в «прочее»
-- (админка, вкладка «канал»).
CREATE TABLE forum_stat_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route_key TEXT NOT NULL,
  from_city TEXT NOT NULL,
  to_city TEXT NOT NULL,
  thread INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_forum_stat_events_at ON forum_stat_events(created_at);
