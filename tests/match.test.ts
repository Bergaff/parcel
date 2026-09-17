import { describe, expect, it } from 'vitest';
import {
  formatMatchDigest,
  isArchivedListing,
  listingSnapshot,
  listingTouchesCity,
  pairListings,
  parseSnapshot,
  scorePair,
} from '../src/match';
import { matchArgCities, matchArgDays, splitDigest } from '../src/telegram';
import type { Listing } from '../src/types';

const TODAY = '2026-09-20';

/** Заявка из базы: минимальный набор полей для подбора. */
function listing(fields: Partial<Listing>): Listing {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    type: 'offer',
    fromCity: 'Варшава',
    toCity: 'Минск',
    departureDate: '2026-09-25',
    weightKg: null,
    price: null,
    description: 'Возьму посылку.',
    phone: null,
    telegram: '@driver',
    status: 'published',
    source: 'parser',
    sourceChat: null,
    sourceChatId: null,
    sourceMessageId: null,
    createdAt: '2026-09-18T10:00:00.000Z',
    publishedAt: '2026-09-18T10:00:00.000Z',
    views: 0,
    ...fields,
  } as Listing;
}

const driver = (fields: Partial<Listing> = {}): Listing => listing({ type: 'offer', ...fields });
const parcel = (fields: Partial<Listing> = {}): Listing =>
  listing({ type: 'request', id: '00000000-0000-0000-0000-000000000002', telegram: '@sender', ...fields });

describe('scorePair: маршрут', () => {
  it('тот же маршрут — пара с высокой оценкой', () => {
    const v = scorePair(driver(), parcel({ departureDate: '2026-09-25' }));
    expect(v.reject).toBeNull();
    expect(v.score).toBeGreaterThanOrEqual(80);
    expect(v.reasons.join(' ')).toContain('маршрут совпадает');
  });

  it('встречный рейс парой не считается: посылка едет туда, куда едет водитель', () => {
    const v = scorePair(driver(), parcel({ fromCity: 'Минск', toCity: 'Варшава' }));
    expect(v.reject).toBe('route');
  });

  it('совпал только один город — по умолчанию не пара', () => {
    const v = scorePair(driver(), parcel({ toCity: 'Брест' }));
    expect(v.reject).toBe('route');
  });

  it('…но с флагом partial такая пара находится и оценивается ниже', () => {
    const partial = scorePair(driver(), parcel({ toCity: 'Брест' }), { partial: true });
    const exact = scorePair(driver(), parcel());
    expect(partial.reject).toBeNull();
    expect(partial.score).toBeLessThan(exact.score);
    expect(partial.reasons.join(' ')).toContain('совпадает город отправления');
  });

  it('города сравниваются после нормализации: «варшаве» = «Варшава»', () => {
    const v = scorePair(driver({ fromCity: 'из варшаве' }), parcel());
    expect(v.reject).toBeNull();
  });
});

describe('scorePair: даты, вес, контакты', () => {
  it('даты в окне — пара, за окном — нет', () => {
    expect(scorePair(driver(), parcel({ departureDate: '2026-09-27' })).reject).toBeNull();
    expect(scorePair(driver(), parcel({ departureDate: '2026-10-10' })).reject).toBe('date_gap');
    expect(scorePair(driver(), parcel({ departureDate: '2026-10-10' }), { days: 30 }).reject).toBeNull();
  });

  it('дата ближе — оценка выше', () => {
    const sameDay = scorePair(driver(), parcel({ departureDate: '2026-09-25' })).score;
    const threeDays = scorePair(driver(), parcel({ departureDate: '2026-09-28' })).score;
    expect(sameDay).toBeGreaterThan(threeDays);
  });

  it('без даты у одной из сторон пара остаётся, но оценка ниже', () => {
    const withDate = scorePair(driver(), parcel()).score;
    const noDate = scorePair(driver(), parcel({ departureDate: null })).score;
    expect(noDate).toBeLessThan(withDate);
    expect(noDate).toBeGreaterThan(30);
  });

  it('посылка тяжелее, чем готов взять водитель, — не пара', () => {
    expect(scorePair(driver({ weightKg: 5 }), parcel({ weightKg: 20 })).reject).toBe('weight');
    expect(scorePair(driver({ weightKg: 20 }), parcel({ weightKg: 5 })).reject).toBeNull();
  });

  it('один и тот же человек сам с собой не сводится', () => {
    expect(scorePair(driver({ telegram: '@same' }), parcel({ telegram: '@same' })).reject).toBe('same_contact');
    // Тот же номер в разных написаниях — тоже один человек
    expect(scorePair(driver({ telegram: null, phone: '+48 579 264 254' }),
      parcel({ telegram: null, phone: '48579264254' })).reject).toBe('same_contact');
  });

  it('нет контакта у одной стороны — штраф, но пара остаётся', () => {
    const v = scorePair(driver({ telegram: null, phone: null }), parcel());
    expect(v.reject).toBeNull();
    expect(v.score).toBeLessThan(scorePair(driver(), parcel()).score);
    expect(v.reasons.join(' ')).toContain('нет контакта');
  });
});

describe('pairListings: фильтры и сортировка', () => {
  const base = [
    driver({ id: 'a', fromCity: 'Варшава', toCity: 'Минск', departureDate: '2026-09-25' }),
    driver({ id: 'b', fromCity: 'Краков', toCity: 'Киев', departureDate: '2026-09-25' }),
    parcel({ id: 'c', fromCity: 'Варшава', toCity: 'Минск', departureDate: '2026-09-26' }),
    parcel({ id: 'd', fromCity: 'Краков', toCity: 'Киев', departureDate: '2026-09-25' }),
  ];

  it('находит обе пары по всему списку', () => {
    const { pairs, stats } = pairListings(base, {}, TODAY);
    expect(pairs).toHaveLength(2);
    expect(stats.offers).toBe(2);
    expect(stats.requests).toBe(2);
  });

  it('фильтр по городам оставляет только нужный маршрут', () => {
    const { pairs, stats } = pairListings(base, { fromCity: 'Варшава', toCity: 'Минск' }, TODAY);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.offer.id).toBe('a');
    expect(pairs[0]!.request.id).toBe('c');
    expect(stats.offers).toBe(1);
    expect(stats.requests).toBe(1);
  });

  it('один город в фильтре тоже работает', () => {
    const { pairs } = pairListings(base, { fromCity: 'Краков' }, TODAY);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.offer.id).toBe('b');
  });

  it('архивные заявки по умолчанию не участвуют, с флагом — участвуют', () => {
    const withArchive = [
      ...base,
      driver({ id: 'e', status: 'expired' }),
      parcel({ id: 'f', departureDate: '2026-09-01' }), // дата прошла, статус published
    ];
    expect(pairListings(withArchive, {}, TODAY).pairs).toHaveLength(2);
    const { pairs, stats } = pairListings(withArchive, { includeArchive: true }, TODAY);
    expect(pairs.length).toBeGreaterThan(2);
    expect(stats.rejected.archived).toBe(0); // архив в подборе — не отклонён
  });

  it('expired-заявка без флага считается архивом и отклоняется', () => {
    const { stats } = pairListings([driver({ status: 'expired' }), parcel()], {}, TODAY);
    expect(stats.rejected.archived).toBe(1);
    expect(stats.offers).toBe(0);
  });

  it('пары сортируются по убыванию оценки, затем по ближайшей дате', () => {
    const many = [
      driver({ id: 'far', departureDate: '2026-09-27' }),
      driver({ id: 'near', departureDate: '2026-09-25' }),
      driver({ id: 'nocontact', telegram: null, phone: null, departureDate: '2026-09-25' }),
      parcel({ departureDate: '2026-09-25' }),
    ];
    const { pairs } = pairListings(many, {}, TODAY);
    expect(pairs.map((p) => p.offer.id)).toEqual(['near', 'far', 'nocontact']);
  });

  it('minScore отсекает слабые пары, limit — лишние', () => {
    const many: Listing[] = [];
    for (let i = 0; i < 5; i++) {
      many.push(driver({ id: `o${i}`, departureDate: `2026-09-2${i + 1}` }));
      many.push(parcel({ id: `r${i}`, departureDate: `2026-09-2${i + 1}` }));
    }
    expect(pairListings(many, { limit: 2 }, TODAY).pairs).toHaveLength(2);
    expect(pairListings(many, { minScore: 999 }, TODAY).pairs).toHaveLength(0);
  });

  it('встречные рейсы не дают ни одной пары', () => {
    const { pairs, stats } = pairListings([
      driver({ fromCity: 'Варшава', toCity: 'Минск' }),
      parcel({ fromCity: 'Минск', toCity: 'Варшава' }),
    ], {}, TODAY);
    expect(pairs).toHaveLength(0);
    expect(stats.rejected.route).toBe(1);
  });
});

describe('вспомогательные функции', () => {
  it('listingTouchesCity: пустой фильтр подходит всем', () => {
    expect(listingTouchesCity(driver(), null)).toBe(true);
    expect(listingTouchesCity(driver(), '  ')).toBe(true);
    expect(listingTouchesCity(driver(), 'Минск')).toBe(true); // город назначения
    expect(listingTouchesCity(driver(), 'Варшава')).toBe(true);
    expect(listingTouchesCity(driver(), 'Брест')).toBe(false);
  });

  it('isArchivedListing: expired или прошедшая дата', () => {
    expect(isArchivedListing(driver(), TODAY)).toBe(false);
    expect(isArchivedListing(driver({ status: 'expired' }), TODAY)).toBe(true);
    expect(isArchivedListing(driver({ departureDate: '2026-09-19' }), TODAY)).toBe(true);
    expect(isArchivedListing(driver({ departureDate: null }), TODAY)).toBe(false);
  });

  it('снимок заявки переживает JSON-цикл и сохраняет контакты списком', () => {
    const snap = listingSnapshot(driver({ phone: '+48579264254', telegram: '@driver' }));
    const back = parseSnapshot(JSON.stringify(snap));
    expect(back).toEqual(snap);
    expect(back?.contacts).toEqual(['@driver', '+48579264254']);
    expect(parseSnapshot('не json')).toBeNull();
    expect(parseSnapshot(null)).toBeNull();
  });
});

describe('formatMatchDigest: сводка в Telegram', () => {
  const { pairs, stats } = pairListings([driver(), parcel()], {}, TODAY);

  it('показывает города, даты, контакты и ссылки на карточки', () => {
    const digest = formatMatchDigest({
      fromCity: 'Варшава', toCity: 'Минск', days: 3, pairs, stats,
      siteUrl: 'https://pop-utka.app/',
    });
    expect(digest).toContain('Подбор пар');
    expect(digest).toContain('Варшава — Минск');
    // ссылки — на настоящие адреса карточек (без «#»: его поисковики не видят)
    expect(digest).toContain('https://pop-utka.app/item/');
    expect(digest).toContain('Пар: <b>1</b>');
  });

  it('без пар объясняет, почему', () => {
    const digest = formatMatchDigest({
      fromCity: null, toCity: null, days: 3, pairs: [],
      stats: { offers: 3, requests: 4, pairs: 0, rejected: { route: 5, date_gap: 2, weight: 0, same_contact: 0, archived: 1 } },
    });
    expect(digest).toContain('Пар не нашлось');
    expect(digest).not.toContain('#/item/');
  });

  it('длинные сводки режутся на сообщения по границе Telegram', () => {
    const long = Array.from({ length: 120 }, (_, i) => `блок ${i}`).join('\n\n');
    const parts = splitDigest(long, 200);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(200);
    expect(parts.join('\n\n')).toBe(long);
    expect(splitDigest('коротко')).toEqual(['коротко']);
  });
});

describe('/подбор: разбор аргументов команды', () => {
  it('без аргументов — все города, окно 3 дня', () => {
    expect(matchArgCities('')).toEqual({ fromCity: null, toCity: null });
    expect(matchArgDays('')).toBe(3);
  });

  it('два города: откуда и куда', () => {
    expect(matchArgCities('Варшава Минск')).toEqual({ fromCity: 'Варшава', toCity: 'Минск' });
  });

  it('один город — фильтр по нему', () => {
    expect(matchArgCities('Краков')).toEqual({ fromCity: 'Краков', toCity: null });
  });

  it('города в падежах и с предлогами', () => {
    expect(matchArgCities('из Варшавы в Минск')).toEqual({ fromCity: 'Варшава', toCity: 'Минск' });
  });

  it('повтор города не даёт двух одинаковых фильтров', () => {
    expect(matchArgCities('Варшава Варшава')).toEqual({ fromCity: 'Варшава', toCity: null });
  });

  it('незнакомый город тоже нормализуется', () => {
    expect(matchArgCities('Гродно')).toEqual({ fromCity: 'Гродно', toCity: null });
    expect(matchArgCities('Солигорск Жодино')).toEqual({ fromCity: 'Солигорск', toCity: 'Жодино' });
  });

  it('знакомый город внутри составного названия находится', () => {
    // «Брест-Литовск» — историческое название Бреста: парсер знает «Брест»
    expect(matchArgCities('Гродно Брест-Литовск')).toEqual({ fromCity: 'Гродно', toCity: 'Брест' });
  });

  it('флаги и дни за города не принимаются', () => {
    expect(matchArgCities('с архивом и одним общим городом')).toEqual({ fromCity: null, toCity: null });
    expect(matchArgCities('архив один город 14 дней')).toEqual({ fromCity: null, toCity: null });
    expect(matchArgCities('Варшава Минск 7 дней архив')).toEqual({ fromCity: 'Варшава', toCity: 'Минск' });
  });

  it('флаги «архив» и «один город» находятся в русском тексте (\\b с кириллицей не работает)', async () => {
    const { matchArgFlags } = await import('../src/telegram');
    expect(matchArgFlags('с архивом')).toEqual({ includeArchive: true, partial: false });
    expect(matchArgFlags('Варшава Минск архив')).toEqual({ includeArchive: true, partial: false });
    expect(matchArgFlags('и с одним общим городом')).toEqual({ includeArchive: false, partial: true });
    expect(matchArgFlags('один город')).toEqual({ includeArchive: false, partial: true });
    expect(matchArgFlags('пары с одним городом')).toEqual({ includeArchive: false, partial: true });
    expect(matchArgFlags('частичное совпадение')).toEqual({ includeArchive: false, partial: true });
    expect(matchArgFlags('Варшава Минск')).toEqual({ includeArchive: false, partial: false });
    expect(matchArgFlags('Варшава Минск 7 дней архив один город')).toEqual({ includeArchive: true, partial: true });
  });

  it('число дней — из аргументов, в пределах 1…30', () => {
    expect(matchArgDays('Варшава Минск 7 дней')).toBe(7);
    expect(matchArgDays('окно 14 дн.')).toBe(14);
    expect(matchArgDays('100 дней')).toBe(30);
    expect(matchArgDays('0 дней')).toBe(3); // ноль — бессмыслица, окно по умолчанию
    expect(matchArgDays('Варшава Минск')).toBe(3);
  });
});
