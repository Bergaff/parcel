import { describe, expect, it } from 'vitest';
import { isMultiRoute, looksLikeListing, normalizeCity, parseDate, parseTelegramMessage, isPassengerOnly, worthAiCheck, parseRecurring, nextRecurringDate } from '../src/parser';
import { isRussianCity } from '../src/util';

const NOW = new Date('2026-09-06T12:00:00Z');

describe('города — по-русски', () => {
  it('знакомую латиницу переводит в русское название', () => {
    expect(normalizeCity('warsawa')).toBe('Варшава');
    expect(normalizeCity('Warsaw')).toBe('Варшава');
    expect(normalizeCity('kraków')).toBe('Краков');
    expect(normalizeCity('минске')).toBe('Минск');
  });
  it('незнакомую латиницу не пропускает как город', () => {
    expect(isRussianCity(normalizeCity('Qwertyville'))).toBe(false);
    expect(isRussianCity(normalizeCity('123'))).toBe(false);
    expect(isRussianCity(normalizeCity('Варшава'))).toBe(true);
    expect(isRussianCity(normalizeCity('Санкт-Петербург'))).toBe(true);
    expect(isRussianCity(normalizeCity('Зелёна-Гура'))).toBe(true);
  });
});

describe('пассажирские попутки — мимо доски', () => {
  it('просьбы пассажиров распознаёт и отделяет от посылок', () => {
    expect(isPassengerOnly('Пассажир. Воскресенье - 01.09. Гродно-Минск. Желательно с утра, ибо опоздаю на экзамен!!!')).toBe(true);
    expect(isPassengerOnly('2 Пассажира. Сегодня. 07.09. Минск-Гродно. В любое время. Скучно не будет)')).toBe(true);
    expect(isPassengerOnly('Кто подвезёт до Минска с утра? Оплачу')).toBe(true);
  });
  it('водителей и посылки не трогает', () => {
    expect(isPassengerOnly('Водитель. Понедельник - 02.09. Минск-Гродно. Выезд с 18 до 19 вечера. Комфортно и безопасно.')).toBe(false);
    expect(isPassengerOnly('Водитель грузового автомобиля (Sprinter). Среда. Гродно-Минск. Кому надо завезти пианино, обращайтесь!')).toBe(false);
    expect(isPassengerOnly('Нужно передать посылку Варшава - Львов, конверт с документами')).toBe(false);
    expect(isPassengerOnly('Возьму пассажира и посылки, Варшава - Минск, место есть')).toBe(false);
  });
});

describe('фильтр перед ИИ (worthAiCheck)', () => {
  it('живые формулировки пускает к ИИ', () => {
    expect(worthAiCheck('есть кто из Бреста в Варшаву в пятницу? надо коробку передать')).toBe(true);
    expect(worthAiCheck('Ребят, надо документы передать в Минск, заплачу')).toBe(true);
  });
  it('болтовню не пускает — ИИ не тратится', () => {
    expect(worthAiCheck('Спасибо большое!')).toBe(false);
    expect(worthAiCheck('ахах, классный мем')).toBe(false);
  });
});

describe('parseTelegramMessage', () => {
  it('распознаёт классическое объявление водителя', () => {
    const p = parseTelegramMessage('Варшава — Львов, завтра, возьму посылку 10 кг, 100 zł, @driver77', NOW);
    expect(p.intent).toBe('offer');
    expect(p.fromCity).toBe('Варшава');
    expect(p.toCity).toBe('Львов');
    expect(p.departureDate).toBe(parseDate('завтра', NOW));
    expect(p.weightKg).toBe(10);
    expect(p.price).toBe('100 zł');
    expect(p.telegram).toBe('@driver77');
    expect(p.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('распознаёт запрос на передачу посылки', () => {
    // NOW фиксируем: без него «15.09» в прошлогоднем тесте уезжает на следующий год
    const p = parseTelegramMessage('Кто может передать посылку Краков → Киев? 5 кг, 15.09, +48 123 456 789', NOW);
    expect(p.intent).toBe('request');
    expect(p.fromCity).toBe('Краков');
    expect(p.toCity).toBe('Киев');
    expect(p.weightKg).toBe(5);
    expect(p.departureDate).toBe('2026-09-15');
    expect(p.phone).toContain('+48');
  });

  it('понимает маршрут через предлог «до»', () => {
    const p = parseTelegramMessage('Еду Берлин до Варшавы в пятницу. Есть место, 20 кг, 50 евро', NOW);
    expect(p.fromCity).toBe('Берлин');
    expect(p.toCity).toBe('Варшава');
    expect(p.departureDate).toBe(parseDate('пятница', NOW));
    expect(p.price).toBe('50 €');
  });

  it('находит дату днями недели', () => {
    // 2026-09-06 — воскресенье: следующая пятница 2026-09-11
    expect(parseDate('в пятницу', NOW)).toBe('2026-09-11');
    expect(parseDate('послезавтра', NOW)).toBe('2026-09-08');
  });

  it('не принимает за объявление обычный разговор', () => {
    const p = parseTelegramMessage('Сегодня хорошая погода, всем привет');
    expect(p.intent).toBeNull();
    expect(looksLikeListing('Сегодня хорошая погода, всем привет')).toBe(false);
  });

  it('игнорирует объявление без маршрута', () => {
    expect(looksLikeListing('Везу посылку завтра, 30 кг, 200 zl')).toBe(false);
  });

  it('считает контакт в ссылке t.me', () => {
    const p = parseTelegramMessage('Варшава — Краков, https://t.me/trasher завтра возьму');
    expect(p.telegram).toBe('@trasher');
  });

  it('распознаёт вес «до 15 кг»', () => {
    const p = parseTelegramMessage('Гданьск до Варшавы, беру до 15 кг');
    expect(p.weightKg).toBe(15);
  });

  it('понимает латинские названия городов и разделитель =>', () => {
    const p = parseTelegramMessage('Warszawa => Lviv, 15.09, до 10 kg, 100 pln', NOW);
    expect(p.fromCity).toBe('Варшава');
    expect(p.toCity).toBe('Львов');
    expect(p.departureDate).toBe('2026-09-15');
    expect(p.weightKg).toBe(10);
    expect(p.price).toBe('100 zł');
  });

  it('понимает латиницу с разделителем >> и словом «еду»', () => {
    const p = parseTelegramMessage('еду Krakow >> Kyiv в пятницу, есть место', NOW);
    expect(p.fromCity).toBe('Краков');
    expect(p.toCity).toBe('Киев');
    expect(p.intent).toBe('offer');
    expect(p.departureDate).toBe('2026-09-11');
  });

  it('понимает дату с названием месяца (рус. и укр.)', () => {
    expect(parseDate('15 сентября', NOW)).toBe('2026-09-15');
    expect(parseDate('5 жовтня', NOW)).toBe('2026-10-05');
    expect(parseDate('выезд 3 декабря', NOW)).toBe('2026-12-03');
  });

  it('понимает «кто едет» как запрос на передачу', () => {
    const p = parseTelegramMessage('Кто едет из Познани в Краков? Нужно передать посылку 2 кг', NOW);
    expect(p.intent).toBe('request');
    expect(p.fromCity).toBe('Познань');
    expect(p.toCity).toBe('Краков');
    expect(p.weightKg).toBe(2);
  });

  it('понимает «места свободны» и «сегодня»', () => {
    const p = parseTelegramMessage('https://t.me/driver88 Krakow >> Kyiv сегодня вечером, 2 места свободны', NOW);
    expect(p.intent).toBe('offer');
    expect(p.fromCity).toBe('Краков');
    expect(p.toCity).toBe('Киев');
    expect(p.departureDate).toBe('2026-09-06');
    expect(p.telegram).toBe('@driver88');
  });
});

describe('тип заявки: «водитель везёт» против «нужно передать»', () => {
  // Баг с доски: просьба «кто-то занимается перевозом посылок?» получала штамп
  // «водитель везёт», потому что слово «перевоз» считалось признаком водителя.
  it('просьбу найти перевозчика не принимает за предложение водителя', () => {
    const p = parseTelegramMessage(
      'добрый день, подскажи пожалуйста кто-то занимается перевозом посылок до 20 кг? варшава-брест?',
      NOW
    );
    expect(p.intent).toBe('request');
    expect(p.fromCity).toBe('Варшава');
    expect(p.toCity).toBe('Брест');
    expect(p.weightKg).toBe(20);
    expect(p.departureDate).toBeNull();
    // правила уверены — ИИ тратить не нужно
    expect(p.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('вопрос «занимаетесь доставкой?» — тоже просьба, а не рейс', () => {
    expect(parseTelegramMessage('Здравствуйте! Занимаетесь доставкой посылок Варшава — Гродно?', NOW).intent).toBe('request');
    expect(parseTelegramMessage('Кто везёт завтра Варшава — Брест? Посылка 5 кг', NOW).intent).toBe('request');
    expect(parseTelegramMessage('Ищу водителя Варшава — Брест, посылка 20 кг', NOW).intent).toBe('request');
  });

  it('объявления водителей остаются предложениями', () => {
    expect(parseTelegramMessage('Водитель, 25.09.2026 Варшава-Минск. Возьму посылки, домашние переезды.', NOW).intent).toBe('offer');
    expect(parseTelegramMessage('Занимаюсь перевозкой посылок Варшава-Минск, возьму до 20 кг', NOW).intent).toBe('offer');
    expect(parseTelegramMessage('Рейс Белосток — Минск 18.09, есть места, посылки, передачи', NOW).intent).toBe('offer');
    expect(parseTelegramMessage('Отвезу посылки Варшава — Краков, суббота', NOW).intent).toBe('offer');
  });

  it('понимает маршрут в падежах: «из Бреста в Варшаву»', () => {
    const p = parseTelegramMessage('есть кто из Бреста в Варшаву в пятницу? надо коробку передать', NOW);
    expect(p.intent).toBe('request');
    expect(p.fromCity).toBe('Брест');
    expect(p.toCity).toBe('Варшава');
  });

  it('спорное сообщение правила отдают ИИ (confidence < 0.7)', () => {
    const p = parseTelegramMessage('Варшава-Минск, перевозка посылок, есть кто 20.09?', NOW);
    expect(p.intent).toBe('request');
    expect(p.confidence).toBeLessThan(0.7);
  });
});

describe('isMultiRoute — несколько направлений в одном сообщении', () => {
  it('структурированная заявка — одно направление', () => {
    expect(isMultiRoute('ПОСЫЛКА #посылка Откуда: Минск Куда: Стамбул Когда: до 22.09.2026 Цена: 15 -20$ Комментарий: маленький конвертик с кусочком ткани')).toBe(false);
  });
  it('два рейса с диапазонами дат — несколько', () => {
    expect(isMultiRoute('🚗#водитель подстроюсь передачи попутчики посылки 18-19.9 Белосток Гр Минск 20-21.9 Мог Минск Белосток Vb+375256663703 TG+48459568684:KgRBPL')).toBe(true);
  });
  it('слово «обратно» — несколько', () => {
    expect(isMultiRoute('18.09, пятница, в 15.00-16.00 еду Белосток Кузница Гродно. Есть места, посылки пачкоматы. 20.09, воскресенье, в 11.00-12.00 обратно. Вайбер +375297872212.')).toBe(true);
    expect(isMultiRoute('28 сентября еду из РБ в Киев. Возьму попутчиков, посылки, передачи. Обратно из Киева в РБ в период с 29.09-1.10')).toBe(true);
  });
  it('одна дата и диапазон веса — одно направление', () => {
    expect(isMultiRoute('20.09 повезу посылки Варшава — Минск, возьму 5-10 кг')).toBe(false);
  });
});

describe('parseRecurring — регулярные рейсы («каждый четверг»)', () => {
  it('каждый/каждую + день недели', () => {
    expect(parseRecurring('Каждый четверг возим посылки Варшава — Минск')).toBe('каждый четверг');
    expect(parseRecurring('каждую пятницу езжу через границу')).toBe('каждую пятницу');
    expect(parseRecurring('КАЖДУЮ СРЕДУ вожу передачи')).toBe('каждую среду');
  });
  it('по + дни недели в дательном падеже и сокращения', () => {
    expect(parseRecurring('по вторникам вожу посылки')).toBe('каждый вторник');
    expect(parseRecurring('по вторникам и пятницам есть места')).toBe('по вторникам и пятницам');
    expect(parseRecurring('по вт и чт, доставка')).toBe('по вторникам и четвергам');
    // сокращения без «по» — слишком похоже на обычный текст, пропускаем
    expect(parseRecurring('вт и чт, доставка')).toBeNull();
  });
  it('ежедневно, будни, раз в неделю', () => {
    expect(parseRecurring('ездим каждый день, беру посылки')).toBe('ежедневно');
    expect(parseRecurring('ежедневные рейсы Минск — Варшава')).toBe('ежедневно');
    expect(parseRecurring('по будням возьму передачку')).toBe('по будням');
    expect(parseRecurring('пн-пт вожу посылки')).toBe('по будням');
    expect(parseRecurring('раз в неделю стабильно езжу')).toBe('раз в неделю');
    expect(parseRecurring('каждую неделю вожу')).toBe('раз в неделю');
  });
  it('разовый рейс — null', () => {
    expect(parseRecurring('20 сентября повезу посылку Варшава — Минск')).toBeNull();
    expect(parseRecurring('завтра еду, возьму 10 кг')).toBeNull();
    expect(parseRecurring('по 20 zł за килограмм')).toBeNull();
    // «вторник» без «каждый/по» — конкретный день, не расписание
    expect(parseRecurring('во вторник повезу коробку')).toBeNull();
  });

  it('parseTelegramMessage помечает регулярный рейс, дата = ближайший заезд', () => {
    const p = parseTelegramMessage('Варшава — Минск, каждый четверг возьму посылки, @driver77', NOW);
    expect(p.recurring).toBe('каждый четверг');
    // NOW = 2026-09-06 (воскресенье) → ближайший четверг 2026-09-10
    expect(p.departureDate).toBe('2026-09-10');
  });
  it('разовое объявление не получает расписания', () => {
    const p = parseTelegramMessage('Варшава — Львов, завтра, возьму посылку 10 кг, 100 zł, @driver77', NOW);
    expect(p.recurring).toBeNull();
  });
});

describe('nextRecurringDate — ближайший заезд по расписанию', () => {
  // 2026-09-10 — четверг
  it('каждый четверг после четверга — следующий четверг', () => {
    expect(nextRecurringDate('каждый четверг', '2026-09-10')).toBe('2026-09-17');
    // дата прошла в пятницу — ближайший снова четверг
    expect(nextRecurringDate('каждый четверг', '2026-09-11')).toBe('2026-09-17');
  });
  it('по вторникам и пятницам — ближайший из дней', () => {
    expect(nextRecurringDate('по вторникам и пятницам', '2026-09-08')).toBe('2026-09-11'); // вт → пт
    expect(nextRecurringDate('по вторникам и пятницам', '2026-09-11')).toBe('2026-09-15'); // пт → вт
  });
  it('ежедневно — завтра, по будням — следующий будний день', () => {
    expect(nextRecurringDate('ежедневно', '2026-09-10')).toBe('2026-09-11');
    // 2026-09-11 — пятница → понедельник 14-го
    expect(nextRecurringDate('по будням', '2026-09-11')).toBe('2026-09-14');
  });
  it('раз в неделю и нераспознанное расписание — плюс неделя', () => {
    expect(nextRecurringDate('раз в неделю', '2026-09-10')).toBe('2026-09-17');
    expect(nextRecurringDate('по чётным числам', '2026-09-10')).toBe('2026-09-17');
  });
  it('битая дата — null', () => {
    expect(nextRecurringDate('каждый четверг', 'завтра')).toBeNull();
    expect(nextRecurringDate('каждый четверг', '')).toBeNull();
  });
});

describe('маршрут из цепочки городов — от первого к последнему', () => {
  it('«Белосток-Кузница-Гродно» едет в Гродно, а не в Кузницу', () => {
    const p = parseTelegramMessage('Еду завтра,в 15:00+- Белосток-Кузница-Гродно Возьму попутчиков,передачки(без предоплаты)', NOW);
    expect(p.fromCity).toBe('Белосток');
    expect(p.toCity).toBe('Гродно');
  });
  it('через Брест: «Варшава - Брест - Минск» → Варшава → Минск', () => {
    const p = parseTelegramMessage('Сегодня 18.09 еду Варшава - Брест - Минск, есть 1 место. Могу взять документы/передачки', NOW);
    expect(p.fromCity).toBe('Варшава');
    expect(p.toCity).toBe('Минск');
  });
  it('список через запятую: «Катовице, Варшава, Брест, Минск» → Катовице → Минск', () => {
    const p = parseTelegramMessage('23.09-24.09 Катовице, Варшава, Брест, Минск Возьму попутчиков, передачи', NOW);
    expect(p.fromCity).toBe('Катовице');
    expect(p.toCity).toBe('Минск');
  });
  it('пробелы вместо дефисов: «Минск Брузги Варшава» → Минск → Варшава', () => {
    const p = parseTelegramMessage('Еду 21.09 утром Минск Брузги Варшава Возьму попутчиков Есть место для багажа Документы, передачи', NOW);
    expect(p.fromCity).toBe('Минск');
    expect(p.toCity).toBe('Варшава');
  });
  it('длинная цепочка до Познани', () => {
    const p = parseTelegramMessage('Еду 20.09 по маршруту—Гомель- Бобруйск -Минск -Барановичи -Брест -Варшава -Познань и обратно. Возьму передачи ,документы', NOW);
    expect(p.fromCity).toBe('Гомель');
    expect(p.toCity).toBe('Познань');
  });
  it('кольцо «Минск - Варшава - Минск» не даёт Минск → Минск', () => {
    const p = parseTelegramMessage('Еду Минск - Варшава - Минск, возьму передачи', NOW);
    expect(p.fromCity).toBe('Минск');
    expect(p.toCity).toBe('Варшава');
  });
  it('«из Москвы в Краков» — склонение с заменой буквы', () => {
    const p = parseTelegramMessage('Добрый день. Ищу кто доставит документы из Москвы в Краков. Пишите в личку', NOW);
    expect(p.fromCity).toBe('Москва');
    expect(p.toCity).toBe('Краков');
  });
});

describe('города: частые написания из чатов', () => {
  it('Бяла и Белая — один город', () => {
    expect(normalizeCity('Бяла')).toBe('Бяла');
    expect(normalizeCity('Белая')).toBe('Бяла');
    expect(normalizeCity('с Бялой')).toBe('Бяла');
    expect(normalizeCity('Biala Podlaska')).toBe('Бяла');
  });
  it('Тересполь и Седлеце известны', () => {
    expect(normalizeCity('Тересполе')).toBe('Тересполь');
    expect(normalizeCity('тересполя')).toBe('Тересполь');
    expect(normalizeCity('Седльце')).toBe('Седлеце');
  });
  it('мск и спб — города', () => {
    expect(normalizeCity('мск')).toBe('Москва');
    expect(normalizeCity('спб')).toBe('Санкт-Петербург');
    expect(normalizeCity('Москву')).toBe('Москва');
    expect(normalizeCity('в Прагу')).toBe('Прага');
  });
});

describe('«ищу место» — пассажирская заявка, не посылка', () => {
  it('поиск места в машине пропускаем', () => {
    expect(isPassengerOnly('Добрый день, подскажите, будет ли кто ехать Вильнюс-Минск ночью? Ищу 1 место, рюкзак. Спасибо!')).toBe(true);
    expect(isPassengerOnly('Добрый день! Ищу 3 места 26.09 Минск-Варшава (аэропорт Модлин к 19:00)')).toBe(true);
  });
  it('водительские «есть места» — не пассажирские', () => {
    expect(isPassengerOnly('Еду Варшава-Минск, есть 4 места, посылки и передачи, без предоплаты')).toBe(false);
    expect(isPassengerOnly('Минск - Вильнюс - Каунас - Минск Есть 4 места посылки и передачи')).toBe(false);
  });
});
