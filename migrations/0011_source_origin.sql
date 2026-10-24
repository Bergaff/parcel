-- Происхождение заявки с точностью до сообщения: публичный username чата
-- и тема форума. Админке нужна ссылка «исходное сообщение» вида
-- t.me/<чат>/<тема>/<сообщение>; без username такая ссылка открывается
-- только у участников чата (t.me/c/…).
ALTER TABLE listings ADD COLUMN source_chat_username TEXT;
ALTER TABLE listings ADD COLUMN source_thread_id INTEGER;
