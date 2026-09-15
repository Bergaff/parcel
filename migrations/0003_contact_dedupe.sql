-- Чистка дублей контактов в уже сохранённых заявках.
--
-- Раньше бот и ИИ могли положить один и тот же номер и в telegram, и в phone
-- (пример: заявка №63367269, «Контакты: +48579264254» дважды). Из-за этого
-- карточка модератора печатала контакт двумя строками, а сайт строил
-- несуществующую ссылку t.me/+48579264254.
--
-- Новый код так не делает: контакты нормализует normalizeContacts() в src/util.ts
-- (вызывается в createListing/updateListing, в разборе ИИ и в форме сайта),
-- а карточка печатает их через uniqueContacts(). Здесь — разовая чистка старых строк.

-- 1) Один и тот же контакт в обоих полях (с точностью до пробелов, скобок, дефисов и @)
UPDATE listings
   SET telegram = NULL
 WHERE telegram IS NOT NULL
   AND phone IS NOT NULL
   AND replace(replace(replace(replace(replace(lower(telegram), ' ', ''), '-', ''), '(', ''), ')', ''), '@', '')
     = replace(replace(replace(replace(replace(lower(phone), ' ', ''), '-', ''), '(', ''), ')', ''), '@', '');

-- 2) Номер, записанный в поле telegram (включая «Vb+375…», «TG+48…»): переносим в phone, если там пусто
UPDATE listings
   SET phone = CASE WHEN instr(telegram, '+') > 0
                    THEN substr(telegram, instr(telegram, '+'))  -- отрезаем префикс мессенджера
                    ELSE telegram END,
       telegram = NULL
 WHERE telegram IS NOT NULL
   AND (telegram LIKE '+%' OR telegram GLOB '[0-9]*' OR telegram GLOB '*+[0-9]*')
   AND phone IS NULL;

-- 3) Номер в поле telegram при уже заполненном phone — это дубль второго контакта, убираем
UPDATE listings
   SET telegram = NULL
 WHERE telegram IS NOT NULL
   AND (telegram LIKE '+%' OR telegram GLOB '[0-9]*' OR telegram GLOB '*+[0-9]*');
