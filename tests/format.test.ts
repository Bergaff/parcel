/**
 * Форматирование дат и «сколько назад».
 *
 * agoText() на сервере и ago() в public/app.js обязаны выдавать одно и то же:
 * строки доски сначала печатает SSR, потом их же перерисовывает клиент — если
 * правила разойдутся, текст под заголовком меняется на глазах у читателя.
 */
import { describe, expect, it } from 'vitest';

import { agoText, fmtDateWithYear, fmtDayShort } from '../src/format';

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0); // 15:00 по МСК
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('agoText', () => {
  it('свежие заявки — «только что», потом минуты и часы', () => {
    expect(agoText(iso(-10 * 1000), NOW)).toBe('только что');
    expect(agoText(iso(-5 * MIN), NOW)).toBe('5 мин назад');
    expect(agoText(iso(-2 * HOUR), NOW)).toBe('сегодня в 13:00');
  });

  it('вчера и старше — день и короткий месяц', () => {
    expect(agoText(iso(-30 * HOUR), NOW)).toBe('вчера');
    expect(agoText(iso(-10 * DAY), NOW)).toBe('7 сен');
  });

  it('день считается по МСК, а не по UTC', () => {
    // 16 сентября 22:30 UTC — это уже 17 сентября 01:30 по МСК
    expect(agoText('2026-09-16T22:30:00.000Z', Date.UTC(2026, 8, 20, 12, 0, 0))).toBe('17 сен');
  });

  it('дата в будущем и мусор не ломают строку', () => {
    expect(agoText(iso(HOUR), NOW)).toBe('17 сен');
    expect(agoText(null, NOW)).toBe('');
    expect(agoText('не дата', NOW)).toBe('');
  });

  it('без явного «сейчас» работает от текущего времени', () => {
    expect(agoText(new Date(Date.now() - 5 * 1000).toISOString())).toBe('только что');
  });
});

describe('fmtDateWithYear и fmtDayShort', () => {
  it('полная дата — для карточки, короткая — для строк доски', () => {
    expect(fmtDateWithYear('2030-05-20')).toBe('20 мая 2030');
    expect(fmtDateWithYear('2026-09-10')).toBe('10 сентября 2026');
    expect(fmtDayShort('2026-09-10')).toBe('10 сен');
  });

  it('пусто и мусор возвращаются как есть', () => {
    expect(fmtDateWithYear(null)).toBe('');
    expect(fmtDayShort('')).toBe('');
  });
});
