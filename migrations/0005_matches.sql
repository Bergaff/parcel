-- Подбор пар «водитель везёт» ↔ «нужно передать» и история таких подборов.
--
-- Админ нажимает кнопку в админке (вкладка «подбор») — сервер сравнивает
-- заявки и сохраняет прогон: кто с кем совпал, почему и с какой оценкой.
-- История нужна, чтобы не подбирать одно и то же заново и видеть, что уже
-- показали людям.
--
-- Пары хранят снимок заявок (offer_json/request_json): сами заявки удаляются
-- кроном через 30 дней после даты выезда, а история подбора остаётся читаемой.

CREATE TABLE IF NOT EXISTS match_runs (
  id              TEXT PRIMARY KEY,
  created_at      TEXT NOT NULL,
  from_city       TEXT,                 -- фильтр «откуда» (NULL — без фильтра)
  to_city         TEXT,                 -- фильтр «куда»
  days_window     INTEGER NOT NULL DEFAULT 3,
  include_archive INTEGER NOT NULL DEFAULT 0,
  partial         INTEGER NOT NULL DEFAULT 0,   -- учитывать совпадение одного города
  offers_total    INTEGER NOT NULL DEFAULT 0,   -- сколько заявок водителей просмотрели
  requests_total  INTEGER NOT NULL DEFAULT 0,   -- сколько заявок на передачу просмотрели
  pairs_found     INTEGER NOT NULL DEFAULT 0,
  notified        INTEGER NOT NULL DEFAULT 0,   -- отправляли ли сводку в Telegram
  note            TEXT                          -- пометка админа («разослал 15.09»)
);

CREATE INDEX IF NOT EXISTS idx_match_runs_created ON match_runs (created_at DESC);

CREATE TABLE IF NOT EXISTS match_pairs (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES match_runs(id) ON DELETE CASCADE,
  offer_id     TEXT NOT NULL,
  request_id   TEXT NOT NULL,
  score        INTEGER NOT NULL DEFAULT 0,
  reason       TEXT,                    -- почему пара: «маршрут совпадает, даты ±1 день»
  offer_json   TEXT NOT NULL,           -- снимок заявки водителя
  request_json TEXT NOT NULL,           -- снимок заявки на передачу
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_match_pairs_run ON match_pairs (run_id);
CREATE INDEX IF NOT EXISTS idx_match_pairs_offer ON match_pairs (offer_id);
