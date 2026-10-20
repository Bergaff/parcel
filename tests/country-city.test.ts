/**
 * Страна вместо города.
 *
 * Повод — настоящая выгрузка: на доске 69 значений «города» оказались страной
 * («Россия» 15 раз, «Беларусь» 7, «Германия» и «Польша» по 6), у 14 заявок
 * страна в обоих полях. По стране не работает ничего: расстояние и пункты
 * пропуска считаются по CITY_GEO, страница маршрута не строится, поиск
 * попутчиков не сходится. Поэтому страну городом не считаем ни на одном входе:
 * сайт и бот просят назвать город, а разбор чатов такое не публикует.
 */
import { describe, expect, it, vi } from 'vitest';

/* src/og тянет resvg.wasm — в тестах wasm не грузится, а воркер импортируем */
vi.mock('../src/og', () => ({
  renderOgImage: async () => new Uint8Array(),
  renderRouteOg: async () => new Uint8Array(),
}));

import { validateAiListing } from '../src/ai';
import { validateListing } from '../src/index';
import { cityAnswer } from '../src/telegram';
import { countryInsteadOfCity, countryNotCityMessage } from '../src/util';

/* Все 27 написаний, которые реально лежали в поле «город» на доске. */
const REAL = ['Россия', 'Беларусь', 'Германия', 'Польша', 'Италия', 'Черногория', 'Чехия', 'Таиланд',
  'Литва', 'Бельгия', 'Япония', 'Израиль', 'Китай', 'Украина', 'Корея', 'Сингапур', 'Бразилия',
  'Греция', 'Турция', 'Испания', 'Сша', 'Кипр', 'Америка', 'Латвия', 'Аргентина', 'Египет', 'Индонезия'];

describe('countryInsteadOfCity', () => {
  it('узнаёт все написания из настоящей выгрузки', () => {
    const missed = REAL.filter((v) => !countryInsteadOfCity(v));
    expect(missed).toEqual([]);
    expect(countryInsteadOfCity('Сша')).toBe('США');
    expect(countryInsteadOfCity('Америка')).toBe('США');
    expect(countryInsteadOfCity('РФ')).toBe('Россия');
    expect(countryInsteadOfCity('Белоруссия')).toBe('Беларусь');
    expect(countryInsteadOfCity('голландия')).toBe('Нидерланды');
    expect(countryInsteadOfCity('  Россия.  ')).toBe('Россия');
  });

  it('города городом и остаются', () => {
    for (const city of ['Москва', 'Варшава', 'Минск', 'Брест', 'Гродно', 'Тересполь', 'Санкт-Петербург',
      'Сан-Паулу', 'Вроцлав', 'Киев', 'Дубай', 'Стамбул', 'Ереван', 'Каменный Лог']) {
      expect(countryInsteadOfCity(city), city).toBeNull();
    }
  });

  it('названия, которые одновременно страна и город, не отбираем', () => {
    // Тунис, Люксембург, Кувейт, Панама, Монако — и страна, и город. Отобрать
    // такое значит заблокировать настоящую заявку, поэтому их в списке нет.
    for (const ambiguous of ['Тунис', 'Люксембург', 'Монако', 'Панама', 'Андорра']) {
      expect(countryInsteadOfCity(ambiguous), ambiguous).toBeNull();
    }
  });

  it('пусто и мусор — не страна', () => {
    expect(countryInsteadOfCity(null)).toBeNull();
    expect(countryInsteadOfCity(undefined)).toBeNull();
    expect(countryInsteadOfCity('')).toBeNull();
    expect(countryInsteadOfCity('   ')).toBeNull();
  });

  it('подсказка называет страну и, если знаем, город для примера', () => {
    expect(countryNotCityMessage('Россия')).toContain('Укажите город, а не страну: «Россия»');
    expect(countryNotCityMessage('Россия')).toContain('например, «Москва»');
    expect(countryNotCityMessage('Беларусь')).toContain('например, «Минск»');
    expect(countryNotCityMessage('Польша')).toContain('например, «Варшава»');
    // страны, городов которой мы не знаем, — без примера, но с тем же смыслом
    const mn = countryNotCityMessage('Черногория');
    expect(mn).toContain('«Черногория»');
    expect(mn).not.toContain('например');
  });
});

describe('страна не проходит ни на одном входе', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    type: 'offer',
    fromCity: 'Москва',
    toCity: 'Варшава',
    description: 'Еду завтра утром, возьму посылку до 10 кг',
    telegram: '@driver',
    ...over,
  });

  it('форма сайта: страна в «откуда» — просим город', () => {
    const r = validateListing(body({ fromCity: 'Россия' }));
    expect(r.error).toContain('Укажите город, а не страну: «Россия»');
    expect(r.error).toContain('например, «Москва»');
    expect(r.input).toBeUndefined();
  });

  it('форма сайта: страна в «куда» — просим город', () => {
    const r = validateListing(body({ toCity: 'Чехия' }));
    expect(r.error).toContain('«Чехия»');
    expect(r.input).toBeUndefined();
  });

  it('обычные города проходят как раньше', () => {
    const r = validateListing(body());
    expect(r.error).toBeUndefined();
    expect(r.input?.fromCity).toBe('Москва');
    expect(r.input?.toCity).toBe('Варшава');
  });

  it('бот: на страну отвечает подсказкой и шаг не засчитывает', () => {
    for (const [value, example] of [['Россия', 'Москва'], ['Беларусь', 'Минск'], ['Польша', 'Варшава'], ['Черногория', null]] as Array<[string, string | null]>) {
      const r = cityAnswer(value);
      expect(r.ok, value).toBe(false);
      if (r.ok) continue;
      expect(r.reply).toContain('это страна');
      expect(r.reply).toContain('Напишите город');
      if (example) expect(r.reply).toContain(example);
      else expect(r.reply).not.toContain('например');
    }
  });

  it('бот: прежние правила шага «откуда/куда» не пострадали', () => {
    expect(cityAnswer('Warsaw')).toEqual({ ok: true, city: 'Варшава' });
    expect(cityAnswer('Варшаве')).toEqual({ ok: true, city: 'Варшава' });
    expect(cityAnswer('Минск')).toEqual({ ok: true, city: 'Минск' });
    const withDigits = cityAnswer('Москва 2');
    expect(withDigits.ok).toBe(false);
    if (!withDigits.ok) expect(withDigits.reply).toContain('цифр');
    expect(cityAnswer('М').ok).toBe(false);
    expect(cityAnswer('Qwerty').ok).toBe(false); // латиница, которую не перевели
  });

  it('разбор чатов: страна вместо города — заявку не создаём', () => {
    const now = new Date('2026-10-20T12:00:00Z');
    const ai = (from: string, to: string) => validateAiListing({
      is_listing: true, is_passenger: false, type: 'offer',
      from_city: from, to_city: to, departure_date: null, weight_kg: null, price: null,
      description: 'Возьму посылки и документы', telegram: '@driver77', phone: null,
    }, { now, originalText: `${from} - ${to}, возьму посылки и документы, @driver77` });

    expect(ai('Россия', 'Чехия')).toBeNull();
    expect(ai('Греция', 'Россия')).toBeNull();
    expect(ai('Москва', 'Польша')).toBeNull();
    expect(ai('Москва', 'Варшава')).not.toBeNull();
  });
});
