import { describe, expect, it } from 'vitest';
import { looksLikeListing, normalizeCity, parseDate, parseTelegramMessage } from '../src/parser';
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
