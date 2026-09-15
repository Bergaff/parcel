-- Публичные ссылки на чаты-источники: админ задаёт вручную для чатов,
-- которые часто мелькают (t.me/имя или пригласительная t.me/+…).
-- Используются в подписи «из чата …» на доске вместо служебной t.me/c/…,
-- которая открывается только у участников чата.
CREATE TABLE IF NOT EXISTS chat_links (
  chat_id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
