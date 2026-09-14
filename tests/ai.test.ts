import { describe, expect, it } from 'vitest';
import { validateAiListing } from '../src/ai';

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

  it('короткое описание заменяет исходным текстом', () => {
    const f = validateAiListing(ok({ description: 'ок' }), { now: NOW, originalText: TEXT });
    expect(f!.description).toBe(TEXT);
  });
});
