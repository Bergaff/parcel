-- Статистика автоодобрения (v0.4.70): наблюдать, как работает автопубликация
-- заявок от админских аккаунтов (src/auto-publish.ts). Админка → «итоги».
--
-- Одна строка на день (день по МСК — как в остальной статистике сайта).
-- Счётчики ведутся с момента включения: задним числом их не восстановить,
-- поэтому в админке блок честно пишет, за какой период посчитано.
-- Таблица крошечная (строка в день), отдельная чистка не нужна.
CREATE TABLE IF NOT EXISTS auto_pub_days (
  day TEXT PRIMARY KEY,
  -- заявок от админских аккаунтов создано (личка админа, пересылки, копии радара)
  admin_arrived INTEGER NOT NULL DEFAULT 0,
  -- из них опубликовано автоматически, без модератора
  auto_published INTEGER NOT NULL DEFAULT 0,
  -- из них задержано на модерацию: разбор усомнился (причины — в auto_pub_reasons)
  held INTEGER NOT NULL DEFAULT 0,
  -- не создано как точный дубль (правило общее, поэтому по всем источникам)
  dup_skipped INTEGER NOT NULL DEFAULT 0,
  -- отклонено из-за отсутствия контакта (тоже по всем источникам)
  rejected_no_contact INTEGER NOT NULL DEFAULT 0
);

-- Почему автопубликация задержала заявку: строка на день и признак сомнения.
-- Коды — из src/auto-publish.ts (Doubt['code']), подписи к ним — DOUBT_LABELS.
CREATE TABLE IF NOT EXISTS auto_pub_reasons (
  day TEXT NOT NULL,
  code TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, code)
);
