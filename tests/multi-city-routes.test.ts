/**
 * Маршруты-цепочки (v0.4.55): «Минск-Брест-Белосток-Варшава» — одна заявка,
 * а не четыре.
 *
 * Контракт:
 *  - парсер и ИИ возвращают всю цепочку городов (промежуточные больше не теряются);
 *  - база хранит stops (JSON) + три нижнерегистровые колонки для поиска
 *    (route_lc, from_stops_lc — города посадки, to_stops_lc — города высадки);
 *  - поиск: заявка находится по ЛЮБОЙ паре городов цепочки в правильном
 *    порядке (Минск→Брест, Брест→Варшава, Минск→Варшава…), обратный порядок — нет;
 *  - отображение: «Минск … Варшава», все города — при наведении (title);
 *    обычная пара городов рисуется прежней стрелкой;
 *  - подбор: водитель-цепочка покрывает сегмент посылки (и наоборот — водитель
 *    везёт участок маршрута посылки);
 *  - правка городов в админке схлопывает цепочку (она больше не правдива),
 *    правка прочих полей — бережёт.
 */
import { describe, expect, it } from 'vitest';

import type { Env, Listing, ListingInput } from '../src/types';
import { parseTelegramMessage } from '../src/parser';
import { validateAiListing } from '../src/ai';
import { createListing, getListingById, listListings, normalizeStops, updateListing, resetSearchColumnsCache } from '../src/store';
import { listingTouchesCity, routeCovers, scorePair, selectCandidates } from '../src/match';
import { renderDetailHtml, renderRowHtml } from '../src/ssr';
import { routeStops } from '../src/util';
import { beforeEach } from 'vitest';

const NOW = new Date('2026-10-30T09:00:00Z');
const CHAIN = ['Минск', 'Брест', 'Белосток', 'Варшава'];

beforeEach(() => resetSearchColumnsCache());

/* ------------------------------ парсер ------------------------------ */

describe('парсер: цепочка городов не теряется', () => {
  it('«Минск-Брест-Белосток-Варшава» — все четыре города, концы те же', () => {
    const p = parseTelegramMessage('Минск-Брест-Белосток-Варшава, завтра, возьму посылку до 10 кг, @driver77', NOW);
    expect(p.fromCity).toBe('Минск');
    expect(p.toCity).toBe('Варшава');
    expect(p.stops).toEqual(CHAIN);
  });

  it('обычная пара — stops из двух городов', () => {
    const p = parseTelegramMessage('Минск-Варшава, завтра, возьму посылку, @driver77', NOW);
    expect(p.stops).toEqual(['Минск', 'Варшава']);
  });

  it('кольцо «Минск-Варшава-Минск» — прежняя первая пара', () => {
    const p = parseTelegramMessage('Минск-Варшава-Минск, завтра, возьму посылку, @driver77', NOW);
    expect(p.fromCity).toBe('Минск');
    expect(p.toCity).toBe('Варшава');
    expect(p.stops).toEqual(['Минск', 'Варшава']);
  });

  it('нет маршрута — stops null', () => {
    const p = parseTelegramMessage('Сегодня хорошая погода, всем привет', NOW);
    expect(p.stops).toBeNull();
  });
});

/* -------------------------------- ИИ -------------------------------- */

describe('ИИ: stops в ответе модели', () => {
  const opts = { now: NOW, originalText: 'минск-брест-белосток-варшава, везу посылки' };
  const base = {
    is_listing: true, type: 'offer', from_city: 'Минск', to_city: 'Варшава',
    departure_date: '2026-10-31', description: 'посылки и документы, есть место',
  };

  it('согласованная цепочка проходит', () => {
    const f = validateAiListing({ ...base, stops: CHAIN }, opts);
    expect(f?.stops).toEqual(CHAIN);
  });

  it('несогласованные концы — stops null (endpoints важнее)', () => {
    const f = validateAiListing({ ...base, stops: ['Гродно', 'Брест', 'Варшава'] }, opts);
    expect(f?.stops).toBeNull();
  });

  it('мусор в массиве отсекается, идущие подряд дубли схлопываются', () => {
    const f = validateAiListing(
      { ...base, stops: ['Минск', 42, 'Брест', 'Брест', null, 'Белосток', 'Варшава'] }, opts
    );
    expect(f?.stops).toEqual(CHAIN);
  });

  it('ровно два города — stops null (обычная пара)', () => {
    const f = validateAiListing({ ...base, stops: ['Минск', 'Варшава'] }, opts);
    expect(f?.stops).toBeNull();
  });
});

/* ------------------------------- store ------------------------------- */

/** Порядок колонок INSERT INTO listings (createListing, 30 колонок). */
const COLS = ['id', 'type', 'from_city', 'to_city', 'departure_date', 'recurring', 'weight_kg',
  'price', 'description', 'phone', 'telegram', 'status', 'source', 'source_chat', 'source_chat_id',
  'source_message_id', 'source_chat_username', 'source_thread_id',
  'by_admin', 'hidden', 'created_at', 'published_at', 'from_city_lc',
  'to_city_lc', 'description_lc', 'reject_reason',
  'stops', 'route_lc', 'from_stops_lc', 'to_stops_lc'];

interface Call { sql: string; params: unknown[] }

/** D1-подделка: PRAGMA — все колонки на месте, строка — из параметров INSERT. */
function storeFake(opts: { row?: Record<string, unknown> | null } = {}) {
  const calls: Call[] = [];
  const make = (sql: string) => {
    const call: Call = { sql, params: [] };
    calls.push(call);
    const stmt = {
      bind(...params: unknown[]) { call.params = params; return stmt; },
      async run() { return { meta: { changes: 1 } }; },
      async all() {
        if (/PRAGMA table_info/.test(sql)) return { results: COLS.map((name) => ({ name })) };
        return { results: [] };
      },
      async first() {
        if (/SELECT \* FROM listings WHERE id/.test(sql)) {
          if (opts.row !== undefined) return opts.row;
          const ins = [...calls].reverse().find((c) => c.sql.includes('INSERT INTO listings'));
          if (!ins) return null;
          const row: Record<string, unknown> = {};
          COLS.forEach((name, i) => { row[name] = ins.params[i]; });
          return row;
        }
        if (/SELECT from_city, to_city, stops/.test(sql)) return opts.row ?? null;
        return null;
      },
    };
    return stmt;
  };
  const env = {
    DB: { prepare: make, batch: async (s: Array<{ run: () => Promise<unknown> }>) => Promise.all(s.map((x) => x.run())) },
    SITE_URL: 'https://pop-utka.app',
  } as unknown as Env;
  return { env, calls };
}

const input = (over: Partial<ListingInput> = {}): ListingInput => ({
  type: 'offer', fromCity: 'Минск', toCity: 'Варшава',
  description: 'Еду в пятницу, возьму посылку', telegram: '@driver',
  status: 'published', source: 'telegram',
  ...over,
});

describe('normalizeStops — валидация цепочки', () => {
  it('согласованная цепочка проходит как есть', () => {
    expect(normalizeStops(CHAIN, 'Минск', 'Варшава')).toEqual(CHAIN);
  });
  it('мусор/несогласованные концы — обычная пара', () => {
    expect(normalizeStops(null, 'Минск', 'Варшава')).toEqual(['Минск', 'Варшава']);
    expect(normalizeStops('строка', 'Минск', 'Варшава')).toEqual(['Минск', 'Варшава']);
    expect(normalizeStops(['Гродно', 'Брест'], 'Минск', 'Варшава')).toEqual(['Минск', 'Варшава']);
    expect(normalizeStops(['Минск'], 'Минск', 'Варшава')).toEqual(['Минск', 'Варшава']);
  });
  it('пустые и идущие подряд дубли схлопываются', () => {
    expect(normalizeStops(['Минск', '', 'Брест', 'Брест', 'Варшава'], 'Минск', 'Варшава'))
      .toEqual(['Минск', 'Брест', 'Варшава']);
  });
});

describe('createListing — цепочка в INSERT', () => {
  it('stops JSON + три поисковые колонки (посадка/высадка/порядок)', async () => {
    const { env, calls } = storeFake();
    await createListing(env, input({ stops: CHAIN }));
    const ins = calls.find((c) => c.sql.includes('INSERT INTO listings'))!;
    const row: Record<string, unknown> = {};
    COLS.forEach((name, i) => { row[name] = ins.params[i]; });
    expect(row.stops).toBe(JSON.stringify(CHAIN));
    expect(row.route_lc).toBe('минск брест белосток варшава');
    expect(row.from_stops_lc).toBe('минск брест белосток'); // сесть можно не в последнем
    expect(row.to_stops_lc).toBe('брест белосток варшава'); // выйти — не в первом
  });

  it('обычная пара — те же колонки из двух городов', async () => {
    const { env, calls } = storeFake();
    await createListing(env, input());
    const ins = calls.find((c) => c.sql.includes('INSERT INTO listings'))!;
    const row: Record<string, unknown> = {};
    COLS.forEach((name, i) => { row[name] = ins.params[i]; });
    expect(row.stops).toBe('["Минск","Варшава"]');
    expect(row.route_lc).toBe('минск варшава');
    expect(row.from_stops_lc).toBe('минск');
    expect(row.to_stops_lc).toBe('варшава');
  });

  it('mapRow читает цепочку обратно; битый JSON лечится парой', async () => {
    const ok = storeFake();
    const created = await createListing(ok.env, input({ stops: CHAIN }));
    expect(created.stops).toEqual(CHAIN);

    const garbage = storeFake({ row: { ...baseRow(), stops: 'не json' } });
    const healed = await getListingById(garbage.env, 'x1');
    expect(healed!.stops).toEqual(['Минск', 'Варшава']);

    const mismatch = storeFake({ row: { ...baseRow(), stops: '["Минск","Гродно"]' } });
    const healed2 = await getListingById(mismatch.env, 'x1');
    expect(healed2!.stops).toEqual(['Минск', 'Варшава']);
  });
});

function baseRow() {
  return {
    id: 'x1', type: 'offer', from_city: 'Минск', to_city: 'Варшава', departure_date: null,
    recurring: null, weight_kg: null, price: null, description: 'посылка', phone: null,
    telegram: '@driver', status: 'published', source: 'telegram', created_at: '2026-10-01T08:00:00.000Z',
    published_at: '2026-10-01T08:00:00.000Z', views: 0, by_admin: 0, hidden: 0,
  };
}

describe('поиск по сегментам цепочки (buildWhere)', () => {
  it('оба города: COALESCE по посадке/высадке + порядок instr(from) < instr(to)', async () => {
    const { env, calls } = storeFake();
    await listListings(env, { from: 'Брест', to: 'Варшава' });
    const q = calls.find((c) => /^SELECT \* FROM listings/.test(c.sql))!;
    expect(q.sql).toContain('COALESCE(from_stops_lc, from_city_lc) LIKE ?');
    expect(q.sql).toContain('COALESCE(to_stops_lc, to_city_lc) LIKE ?');
    expect(q.sql).toContain("instr(COALESCE(route_lc, from_city_lc || ' ' || to_city_lc), ?) < instr(COALESCE(route_lc, from_city_lc || ' ' || to_city_lc), ?)");
    expect(q.params).toContain('%брест%');
    expect(q.params).toContain('%варшава%');
    // порядок: сырые нижнерегистровые города для instr — рядом, from раньше to
    const iFrom = q.params.indexOf('брест');
    const iTo = q.params.indexOf('варшава');
    expect(iFrom).toBeGreaterThanOrEqual(0);
    expect(iTo).toBe(iFrom + 1);
  });

  it('один город: LIKE по колонке сегментов (промежуточные находятся)', async () => {
    const { env, calls } = storeFake();
    await listListings(env, { from: 'Белосток' });
    const q = calls.find((c) => /^SELECT \* FROM listings/.test(c.sql))!;
    expect(q.sql).toContain('COALESCE(from_stops_lc, from_city_lc) LIKE ?');
    expect(q.sql).not.toContain('instr(');
    expect(q.params).toContain('%белосток%');
  });

  it('q-поиск захватывает промежуточные города (route_lc)', async () => {
    const { env, calls } = storeFake();
    await listListings(env, { q: 'Белосток' });
    const q = calls.find((c) => /^SELECT \* FROM listings/.test(c.sql))!;
    expect(q.sql).toContain('OR route_lc LIKE ?');
  });
});

describe('updateListing — цепочка при правке', () => {
  const before = {
    ...baseRow(),
    stops: '["Минск","Брест","Варшава"]', route_lc: 'минск брест варшава',
    from_stops_lc: 'минск брест', to_stops_lc: 'брест варшава',
  };

  it('смена города схлопывает цепочку (она больше не правдива)', async () => {
    const { env, calls } = storeFake({ row: before });
    await updateListing(env, 'x1', { type: 'offer', fromCity: 'Гродно', toCity: 'Варшава', description: 'посылка' });
    // не перепутать с backfill UPDATE из ensureSearchColumns (тот без stops)
    const upd = calls.find((c) => c.sql.includes('UPDATE listings SET') && c.sql.includes('stops = ?'))!;
    // stops/route_lc/from_stops_lc/to_stops_lc — индексы 13..16, все null
    expect(upd.params.slice(13, 17)).toEqual([null, null, null, null]);
  });

  it('правка без смены городов цепочку бережёт', async () => {
    const { env, calls } = storeFake({ row: before });
    await updateListing(env, 'x1', { type: 'offer', fromCity: 'Минск', toCity: 'Варшава', description: 'новое описание', price: '50 BYN' });
    const upd = calls.find((c) => c.sql.includes('UPDATE listings SET') && c.sql.includes('stops = ?'))!;
    expect(upd.params[13]).toBe('["Минск","Брест","Варшава"]');
    expect(upd.params[14]).toBe('минск брест варшава');
    expect(upd.params[15]).toBe('минск брест');
    expect(upd.params[16]).toBe('брест варшава');
  });
});

/* ------------------------------- подбор ------------------------------- */

const chainOffer = {
  id: 'o1', type: 'offer', fromCity: 'Минск', toCity: 'Варшава', stops: CHAIN,
  departureDate: '2026-10-31', telegram: '@driver', phone: null, weightKg: null,
  status: 'published', createdAt: '2026-10-29T08:00:00.000Z',
} as unknown as Listing;

const segmentRequest = (from: string, to: string, over: Partial<Listing> = {}) => ({
  id: 'r1', type: 'request', fromCity: from, toCity: to,
  departureDate: '2026-10-31', telegram: '@person', phone: null, weightKg: null,
  status: 'published', createdAt: '2026-10-29T09:00:00.000Z',
  ...over,
}) as unknown as Listing;

describe('подбор по сегментам', () => {
  it('routeCovers: сегмент по порядку — да, обратный — нет', () => {
    expect(routeCovers(chainOffer, 'Брест', 'Варшава')).toBe(true);
    expect(routeCovers(chainOffer, 'Минск', 'Белосток')).toBe(true);
    expect(routeCovers(chainOffer, 'Варшава', 'Брест')).toBe(false);
    expect(routeCovers(chainOffer, 'Гродно', 'Варшава')).toBe(false);
    expect(routeCovers(chainOffer, 'Минск', 'Минск')).toBe(false);
  });

  it('касание города: промежуточные считаются', () => {
    expect(listingTouchesCity(chainOffer, 'Белосток')).toBe(true);
    expect(listingTouchesCity(chainOffer, 'Киев')).toBe(false);
  });

  it('водитель-цепочка покрывает сегмент посылки — пара почти как полное совпадение', () => {
    const v = scorePair(chainOffer, segmentRequest('Брест', 'Варшава'));
    expect(v.reject).toBeNull();
    expect(v.score).toBeGreaterThanOrEqual(55);
    expect(v.reasons[0]).toContain('проезжает сегмент');
  });

  it('водитель везёт участок маршрута посылки — пара ниже рангом, но предлагается', () => {
    const shortOffer = { ...chainOffer, stops: undefined, fromCity: 'Минск', toCity: 'Брест' } as unknown as Listing;
    const chainRequest = segmentRequest('Минск', 'Варшава', { stops: ['Минск', 'Брест', 'Варшава'] });
    const v = scorePair(shortOffer, chainRequest);
    expect(v.reject).toBeNull();
    expect(v.score).toBeGreaterThanOrEqual(45);
    expect(v.reasons[0]).toContain('везёт участок');
  });

  it('обычный водитель Минск→Варшава НЕ покрывает Брест→Варшава', () => {
    const plain = { ...chainOffer, stops: undefined } as unknown as Listing;
    const v = scorePair(plain, segmentRequest('Брест', 'Варшава'));
    expect(v.reject).toBe('route');
  });

  it('обратный сегмент (Варшава→Брест) пару не даёт', () => {
    const v = scorePair(chainOffer, segmentRequest('Варшава', 'Брест'));
    expect(v.reject).toBe('route');
  });

  it('фильтр подбора по промежуточному городу находит водителя-цепочку', () => {
    const { offers } = selectCandidates([chainOffer], { fromCity: 'Белосток' });
    expect(offers).toHaveLength(1);
  });
});

/* ----------------------------- отображение ----------------------------- */

const ssrListing = (over: Partial<Listing> = {}) => ({
  id: 'b5023c82-e043-4863-9fae-ee19a095f211',
  type: 'offer', fromCity: 'Минск', toCity: 'Варшава', stops: CHAIN,
  departureDate: '2030-05-20', weightKg: 8, price: '30 BYN',
  description: 'Еду в субботу утром, возьму одну сумку', phone: null, telegram: '@ivan_waw',
  status: 'published', source: 'telegram', createdAt: '2026-09-15T07:10:00.000Z',
  publishedAt: '2026-09-15T07:40:00.000Z', views: 12,
  ...over,
}) as Listing;

describe('отображение: «Минск … Варшава» с городами при наведении', () => {
  it('строка доски: многоточие, title со всей цепочкой, aria-label тоже', () => {
    const html = renderRowHtml(ssrListing());
    expect(html).toContain('<span class="r-arrow r-via" title="Минск → Брест → Белосток → Варшава"');
    expect(html).toContain('aria-label="через Брест, Белосток">…</span>');
    expect(html).toContain('aria-label="Минск → Брест → Белосток → Варшава: открыть объявление"');
    expect(html).not.toContain('<span class="r-arrow">→</span>');
  });

  it('обычная пара — прежняя стрелка, никакого многоточия', () => {
    const html = renderRowHtml(ssrListing({ stops: undefined }));
    expect(html).toContain('<span class="r-arrow">→</span>');
    expect(html).not.toContain('r-via');
  });

  it('карточка: h1 с многоточием и наведением', () => {
    const html = renderDetailHtml(ssrListing(), { origin: 'https://pop-utka.app' });
    expect(html).toContain('r-arrow r-via');
    expect(html).toContain('title="Минск → Брест → Белосток → Варшава"');
  });

  it('routeStops: нет stops — обычная пара (старые строки базы)', () => {
    expect(routeStops({ fromCity: 'Минск', toCity: 'Варшава' })).toEqual(['Минск', 'Варшава']);
    expect(routeStops({ fromCity: 'Минск', toCity: 'Варшава', stops: CHAIN })).toEqual(CHAIN);
    expect(routeStops({ fromCity: 'Минск', toCity: 'Варшава', stops: ['Минск'] })).toEqual(['Минск', 'Варшава']);
  });
});
