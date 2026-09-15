import { describe, expect, it } from 'vitest';
import { isMultiRoute, looksLikeListing, normalizeCity, parseDate, parseTelegramMessage, isPassengerOnly, worthAiCheck } from '../src/parser';
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
    const p = parseTelegramMessage('Кто может передать посылку Краков → Киев? 5 кг, 15.09, +48 123 456 789');
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
