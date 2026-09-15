import { describe, expect, it } from 'vitest';
import { contactKind, dedupeDescription, normalizeContacts, uniqueContacts } from '../src/util';

describe('normalizeContacts — один контакт в одном поле, без дублей', () => {
  it('одинаковый номер в обоих полях остаётся один раз', () => {
    expect(normalizeContacts('+48579264254', '+48579264254')).toEqual({
      telegram: null,
      phone: '+48579264254',
    });
    expect(uniqueContacts('+48579264254', '+48579264254')).toEqual(['+48579264254']);
  });

  it('один и тот же номер в разных записях — тоже дубль', () => {
    expect(uniqueContacts('+48 579 264 254', '+48579264254')).toEqual(['+48 579 264 254']);
  });

  it('номер, попавший в поле telegram, переезжает в phone', () => {
    expect(normalizeContacts('+48579264254', null)).toEqual({ telegram: null, phone: '+48579264254' });
    expect(normalizeContacts('Vb+375256663703', null)).toEqual({ telegram: null, phone: '+375256663703' });
  });

  it('юзернейм, попавший в поле phone, переезжает в telegram', () => {
    expect(normalizeContacts(null, 'KgRBPL')).toEqual({ telegram: '@KgRBPL', phone: null });
    expect(normalizeContacts(null, 'https://t.me/driver77')).toEqual({ telegram: '@driver77', phone: null });
  });

  it('разные контакты остаются оба: telegram первым', () => {
    expect(uniqueContacts('@driver77', '+48579264254')).toEqual(['@driver77', '+48579264254']);
    expect(normalizeContacts('@driver77', '+48 579 264 254')).toEqual({
      telegram: '@driver77',
      phone: '+48 579 264 254',
    });
  });

  it('мусор отбрасывается', () => {
    expect(normalizeContacts('не-юзернейм!!!', 'позвоните мне')).toEqual({ telegram: null, phone: null });
    expect(uniqueContacts(null, null)).toEqual([]);
  });

  it('contactKind различает юзернейм и номер', () => {
    expect(contactKind('@driver77')).toBe('telegram');
    expect(contactKind('t.me/driver77')).toBe('telegram');
    expect(contactKind('driver77')).toBe('telegram');
    expect(contactKind('+48579264254')).toBe('phone');
    expect(contactKind('TG+48459568684')).toBe('phone');
    expect(contactKind('')).toBeNull();
    expect(contactKind('привет')).toBeNull();
  });
});

describe('dedupeDescription — описание не повторяет поля карточки', () => {
  it('убирает «шапку» с маршрутом, датой и типом (дубль полей карточки)', () => {
    const ctx = {
      type: 'offer' as const,
      fromCity: 'Варшава',
      toCity: 'Минск',
      departureDate: '2026-09-25',
      phone: '+48579264254',
    };
    expect(dedupeDescription('Водитель, 25.09.2026 Варшава-Минск. Возьму посылки, домашние переезды. Telegram, Whatsapp.', ctx))
      .toBe('Возьму посылки, домашние переезды. Telegram, Whatsapp.');
  });

  it('убирает из текста контакт, который показан отдельной строкой', () => {
    expect(dedupeDescription('Возьму посылку до 10 кг, писать +48 579 264 254', { phone: '+48579264254' }))
      .toBe('Возьму посылку до 10 кг, писать');
    expect(dedupeDescription('Возьму посылку, @driver77', { telegram: '@driver77' }))
      .toBe('Возьму посылку');
  });

  it('схлопывает повторяющиеся предложения и срезает маршрут с края', () => {
    const text = 'Возьму посылки, Варшава — Минск. Возьму посылки, Варшава — Минск. Есть место в багажнике.';
    expect(dedupeDescription(text, { fromCity: 'Варшава', toCity: 'Минск' }))
      .toBe('Возьму посылки. Есть место в багажнике.');
  });

  it('срезает шапку «дата маршрут» и вес с ценой', () => {
    expect(dedupeDescription('25.09 Варшава-Минск, возьму посылки, до 20 кг, 100 zł', {
      fromCity: 'Варшава', toCity: 'Минск', departureDate: '2026-09-25',
    })).toBe('Возьму посылки');
  });

  it('дословный текст сообщения не перекраивает: переносы строк на месте', () => {
    const raw = 'Водитель. Понедельник - 02.09. Минск-Гродно.\nВыезд с 18 до 19 вечера.\nВайбер +375297872212.';
    // контактов в контексте нет — менять нечего, текст возвращается как есть
    expect(dedupeDescription(raw, { stripFields: false })).toBe(raw);
    // номер, который показан строкой «Контакты:», из текста убирается
    expect(dedupeDescription(raw, { phone: '+375297872212', stripFields: false }))
      .toBe('Водитель. Понедельник - 02.09. Минск-Гродно.\nВыезд с 18 до 19 вечера.\nВайбер.');
  });

  it('в тексте, который сочинил ИИ, вычёркивает маршрут и дату, сохраняя строки', () => {
    expect(dedupeDescription('Водитель. 02.09 Минск-Гродно.\nВыезд с 18 до 19 вечера.\nКомфортно и безопасно.', {
      type: 'offer', fromCity: 'Минск', toCity: 'Гродно', departureDate: '2026-09-02',
    })).toBe('Выезд с 18 до 19 вечера.\nКомфортно и безопасно.');
  });

  it('не трогает осмысленный текст и не возвращает пустоту', () => {
    expect(dedupeDescription('Заберу из дома, коробка 40×40, нужна аккуратная перевозка.', {
      fromCity: 'Варшава', toCity: 'Минск',
    })).toBe('Заберу из дома, коробка 40×40, нужна аккуратная перевозка.');
    // описание целиком состоит из маршрута — чистить нечего, оставляем как есть
    expect(dedupeDescription('Варшава — Минск', { fromCity: 'Варшава', toCity: 'Минск' }))
      .toBe('Варшава — Минск');
    expect(dedupeDescription('', {})).toBe('');
  });
});
