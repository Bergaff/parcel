import { describe, expect, it } from 'vitest';
import { parseAiListings, validateAiListing } from '../src/ai';

const NOW = new Date('2026-09-14T12:00:00+03:00');
const TEXT = 'Завтра везу посылку Крокодилово — Бегемотово, 5 кг, 100 zł, @driver77';

function ok(overrides: Record<string, unknown> = {}) {
  return {
    is_listing: true,
    is_passenger: false,
    type: 'offer',
    from_city: 'Крокодилово',
    to_city: 'Бегемотово',
    departure_date: '2026-09-15',
    weight_kg: 5,
    price: '100 zł',
    telegram: '@driver77',
    phone: null,
    description: 'Везу посылку, 5 кг, оплата 100 zł',
    ...overrides,
  };
}

describe('validateAiListing — валидация ответа DeepSeek', () => {
  it('корректный ответ превращается в поля заявки', () => {
    const f = validateAiListing(ok(), { now: NOW, originalText: TEXT });
    expect(f).not.toBeNull();
    expect(f!.type).toBe('offer');
    expect(f!.fromCity).toBe('Крокодилово');
    expect(f!.toCity).toBe('Бегемотово');
    expect(f!.departureDate).toBe('2026-09-15');
    expect(f!.weightKg).toBe(5);
    expect(f!.price).toBe('100 zł');
    expect(f!.telegram).toBe('@driver77');
  });

  it('знакомую латиницу переводит: Warsaw → Варшава', () => {
    const f = validateAiListing(ok({ from_city: 'Warsaw', to_city: 'Минск' }), { now: NOW, originalText: TEXT });
    expect(f!.fromCity).toBe('Варшава');
  });

  it('не-объявление и пассажирская попутка — мимо', () => {
    expect(validateAiListing({ is_listing: false }, { now: NOW, originalText: TEXT })).toBeNull();
    expect(validateAiListing(ok({ is_passenger: true }), { now: NOW, originalText: TEXT })).toBeNull();
  });

  it('незнакомую латиницу в городах — отбраковывает', () => {
    expect(validateAiListing(ok({ from_city: 'Qwertyville' }), { now: NOW, originalText: TEXT })).toBeNull();
  });

  it('мусор вместо JSON и пустые поля — отбраковывает', () => {
    expect(validateAiListing('не JSON', { now: NOW, originalText: TEXT })).toBeNull();
    expect(validateAiListing(null, { now: NOW, originalText: TEXT })).toBeNull();
    expect(validateAiListing(ok({ from_city: '', to_city: '' }), { now: NOW, originalText: TEXT })).toBeNull();
    expect(validateAiListing(ok({ type: 'поездка' }), { now: NOW, originalText: TEXT })).toBeNull();
  });

  it('невалидная дата отбрасывается, заявка остаётся', () => {
    expect(validateAiListing(ok({ departure_date: '1111-11-11' }), { now: NOW, originalText: TEXT })!.departureDate).toBeNull();
    expect(validateAiListing(ok({ departure_date: '2030-01-01' }), { now: NOW, originalText: TEXT })!.departureDate).toBeNull();
  });

  it('дикий вес и кривой контакт отбрасываются', () => {
    expect(validateAiListing(ok({ weight_kg: 5000 }), { now: NOW, originalText: TEXT })!.weightKg).toBeNull();
    expect(validateAiListing(ok({ telegram: 'не-юзернейм!!!' }), { now: NOW, originalText: TEXT })!.telegram).toBeNull();
  });

  it('короткое описание заменяет исходным текстом (без дубля контакта)', () => {
    const f = validateAiListing(ok({ description: 'ок' }), { now: NOW, originalText: TEXT });
    // исходный текст не калечим — убираем только контакт, он показан отдельной строкой
    expect(f!.description).toBe('Завтра везу посылку Крокодилово — Бегемотово, 5 кг, 100 zł');
    expect(f!.description).not.toContain('@driver77');
  });
});

describe('validateAiListing — контакты без дублей (заявка №63367269)', () => {
  it('один и тот же номер в telegram и phone остаётся одним контактом', () => {
    const f = validateAiListing(ok({ telegram: '+48579264254', phone: '+48579264254' }), { now: NOW, originalText: TEXT });
    expect(f!.phone).toBe('+48579264254');
    expect(f!.telegram).toBeNull();
  });

  it('номер, который ИИ положил в telegram, переезжает в phone', () => {
    const f = validateAiListing(ok({ telegram: '+48579264254', phone: null }), { now: NOW, originalText: TEXT });
    expect(f!.telegram).toBeNull();
    expect(f!.phone).toBe('+48579264254');
  });

  it('юзернейм, который ИИ положил в phone, переезжает в telegram', () => {
    const f = validateAiListing(ok({ telegram: null, phone: 'driver77' }), { now: NOW, originalText: TEXT });
    expect(f!.telegram).toBe('@driver77');
    expect(f!.phone).toBeNull();
  });

  it('разные контакты остаются оба', () => {
    const f = validateAiListing(ok({ telegram: '@driver77', phone: 'Vb+375256663703' }), { now: NOW, originalText: TEXT });
    expect(f!.telegram).toBe('@driver77');
    expect(f!.phone).toBe('+375256663703');
  });
});

describe('validateAiListing — описание не повторяет поля карточки', () => {
  it('убирает «шапку» с маршрутом, датой и типом', () => {
    const f = validateAiListing(ok({
      from_city: 'Варшава', to_city: 'Минск', departure_date: '2026-09-25',
      telegram: null, phone: '+48579264254',
      description: 'Водитель, 25.09.2026 Варшава-Минск. Возьму посылки, домашние переезды. Telegram, Whatsapp.',
    }), { now: NOW, originalText: TEXT });
    expect(f!.description).toBe('Возьму посылки, домашние переезды. Telegram, Whatsapp.');
  });

  it('убирает из описания номер, который показан в контактах', () => {
    const f = validateAiListing(ok({
      telegram: null, phone: '+48579264254',
      description: 'Возьму посылки и домашние переезды, звоните +48 579 264 254',
    }), { now: NOW, originalText: TEXT });
    expect(f!.description).toBe('Возьму посылки и домашние переезды, звоните');
    expect(f!.phone).toBe('+48579264254');
  });
});

describe('parseAiListings — несколько направлений из одного сообщения', () => {
  const opts = { now: NOW, originalText: 'водитель: два рейса Белосток — Минск и обратно' };

  it('массив listings → две заявки (туда и обратно), контакты чинятся', () => {
    const raw = {
      listings: [
        ok({ from_city: 'Белосток', to_city: 'Минск', departure_date: '2026-09-18', telegram: null, phone: 'Vb+375256663703', description: '18-19.9 Белосток Гродно Минск, передачи, попутчики' }),
        ok({ from_city: 'Минск', to_city: 'Белосток', departure_date: '2026-09-20', telegram: 'KgRBPL', phone: 'TG+48459568684', description: '20-21.9 Могилёв Минск Белосток, обратно' }),
      ],
    };
    const list = parseAiListings(raw, opts);
    expect(list).toHaveLength(2);
    expect(list[0]!.fromCity).toBe('Белосток');
    expect(list[0]!.toCity).toBe('Минск');
    expect(list[0]!.phone).toBe('+375256663703'); // «Vb+…» → номер
    expect(list[1]!.fromCity).toBe('Минск');
    expect(list[1]!.departureDate).toBe('2026-09-20');
    expect(list[1]!.telegram).toBe('@KgRBPL'); // юзернейм без @ → с @
    expect(list[1]!.phone).toBe('+48459568684'); // «TG+…» → номер
  });

  it('старый формат (один объект) — одна заявка', () => {
    expect(parseAiListings(ok(), opts)).toHaveLength(1);
  });

  it('пусто и мусор — пусто', () => {
    expect(parseAiListings({ listings: [] }, opts)).toEqual([]);
    expect(parseAiListings({ listings: [{ is_listing: false }] }, opts)).toEqual([]);
    expect(parseAiListings('мусор', opts)).toEqual([]);
  });

  it('больше трёх направлений — обрезаем до трёх', () => {
    const raw = { listings: [1, 2, 3, 4, 5].map(() => ok()) };
    expect(parseAiListings(raw, opts)).toHaveLength(3);
  });
});
