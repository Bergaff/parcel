-- Итоги месяцев: снимки статистики, которые переживают удаление объявлений.
-- Архив чистится через 30 дней после выезда (см. archiveExpired), поэтому
-- считать «сколько заявок было в марте» по живым строкам нельзя — цифры
-- пересчитываются и складываются сюда (cron раз в сутки + кнопка в админке).
CREATE TABLE IF NOT EXISTS stats_months (
  month      TEXT PRIMARY KEY,          -- '2026-09'
  total      INTEGER NOT NULL DEFAULT 0,
  payload    TEXT NOT NULL DEFAULT '{}',-- MonthStat целиком: типы, города, направления, цены по валютам
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
