/**
 * Экспорт заявок в таблицу (CSV).
 *
 * Проверяем то, что легко сломать молча: кодировку (BOM), разделитель («;»),
 * экранирование описаний с кавычками и переносами, соответствие колонок
 * шапке, сортировку и то, что файл отдаётся только с ключом админки.
 */
import { describe, expect, it, vi } from 'vitest';

/* src/og тянет resvg.wasm — vite в тестах wasm не грузит, а роуту выгрузки
   OG-картинки не нужны. Подменяем до импорта воркера. */
vi.mock('../src/og', () => ({
  renderOgImage: async () => new Uint8Array(),
  renderRouteOg: async () => new Uint8Array(),
}));

import {
  CSV_HEADERS, SOURCE_LABEL, STATUS_LABEL, TYPE_LABEL,
  csvCell, daysUntil, fmtStamp, listingCsvRow, renderListingsCsv,
} from '../src/listing-csv';
import { listAllForExport } from '../src/store';
import type { Env, Listing, ListingStatus } from '../src/types';
import worker from '../src/index';

const TODAY = '2026-10-19';

function listing(over: Partial<Listing> = {}): Listing {
  return {
    id: 'aaaa1111-2222-3333-4444-555555555555',
    type: 'offer',
    fromCity: 'Минск',
    toCity: 'Варшава',
    departureDate: '2026-10-25',
    recurring: null,
    weightKg: 5,
    price: '50 EUR',
    description: 'Еду вечером; возьму "документы" и небольшую коробку',
    phone: '+375 29 000-00-00',
    telegram: '@driver',
    status: 'published',
    source: 'parser',
    sourceChat: 'Чат Минск — Варшава',
    sourceChatId: '-100123',
    sourceMessageId: 42,
    byAdmin: false,
    fromPerson: false,
    hidden: false,
    createdAt: '2026-10-19T13:14:15.000Z',
    publishedAt: '2026-10-19 13:20:00',
    views: 7,
    pinnedUntil: null,
    ...over,
  } as Listing;
}

describe('ячейка CSV', () => {
  it('всегда в кавычках, внутренние кавычки удвоены', () => {
    expect(csvCell('Минск')).toBe('"Минск"');
    expect(csvCell('возьму "сумку"')).toBe('"возьму ""сумку"""');
  });

  it('точка с запятой остаётся внутри ячейки, перенос строки — становится пробелом', () => {
    // разделитель — «;», поэтому «;» внутри описания обязана быть в кавычках,
    // иначе Excel разорвёт строку на лишние колонки
    expect(csvCell('документы; коробка')).toBe('"документы; коробка"');
    // перенос внутри ячейки разъезжает строку таблицы на несколько экранных
    expect(csvCell('первая\nвторая')).toBe('"первая вторая"');
    expect(csvCell('ночью\r\nеду\r\nБрест - Бяла')).toBe('"ночью еду Брест - Бяла"');
    expect(csvCell('\n')).toBe('""');
  });

  it('числа как есть, пустые значения — пустой ячейкой', () => {
    expect(csvCell(5)).toBe('"5"');
    expect(csvCell(0)).toBe('"0"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
  });
});

describe('колонки', () => {
  it('значений ровно столько, сколько заголовков', () => {
    expect(listingCsvRow(listing(), TODAY)).toHaveLength(CSV_HEADERS.length);
    // порядок не поехал на заявке без даты, без веса и в архиве
    expect(listingCsvRow(listing({
      departureDate: null, weightKg: null, price: null, phone: null,
      telegram: null, recurring: 'каждый четверг', status: 'expired', publishedAt: null,
    }), TODAY)).toHaveLength(CSV_HEADERS.length);
  });

  it('статусы, типы и источники — по-русски, как в админке', () => {
    expect(STATUS_LABEL.published).toBe('на доске');
    expect(STATUS_LABEL.expired).toBe('в архиве');
    expect(STATUS_LABEL.pending).toBe('на модерации');
    expect(STATUS_LABEL.rejected).toBe('отклонена');
    expect(TYPE_LABEL.offer).toBe('водитель везёт');
    expect(TYPE_LABEL.request).toBe('ищу передачу');
    expect(SOURCE_LABEL.parser).toBe('из чата');
    expect(SOURCE_LABEL.site).toBe('с сайта');
    expect(SOURCE_LABEL.telegram).toBe('из бота');
    const row = listingCsvRow(listing(), TODAY);
    expect(row).toContain('на доске');
    expect(row).toContain('водитель везёт');
    expect(row).toContain('из чата');
  });

  it('кто подал: админ, посторонний человек или пусто', () => {
    const i = (l: Listing) => listingCsvRow(l, TODAY)[14];
    expect(i(listing({ byAdmin: true }))).toBe('админ');
    expect(i(listing({ fromPerson: true }))).toBe('сам человек');
    expect(i(listing())).toBe('');
  });

  it('скрытая заявка помечена, обычная — нет', () => {
    const i = (l: Listing) => listingCsvRow(l, TODAY)[18];
    expect(i(listing({ hidden: true }))).toBe('да');
    expect(i(listing())).toBe('');
  });
});

describe('дни до выезда', () => {
  it('вперёд — положительные, назад — отрицательные', () => {
    expect(daysUntil('2026-10-25', TODAY)).toBe(6);
    expect(daysUntil('2026-10-19', TODAY)).toBe(0);
    expect(daysUntil('2026-10-16', TODAY)).toBe(-3);
  });

  it('нет даты или мусор — null, а не NaN в таблице', () => {
    expect(daysUntil(null, TODAY)).toBeNull();
    expect(daysUntil('не дата', TODAY)).toBeNull();
    const row = listingCsvRow(listing({ departureDate: null }), TODAY);
    expect(row[6]).toBeNull();
    expect(Number.isNaN(Number(row[6]))).toBe(false);
  });

  it('перевод года считается честно', () => {
    expect(daysUntil('2027-01-01', '2026-12-31')).toBe(1);
  });
});

describe('отметки времени', () => {
  it('секунды и «T» убираем, пустое остаётся пустым', () => {
    expect(fmtStamp('2026-10-19T13:14:15.000Z')).toBe('2026-10-19 13:14');
    expect(fmtStamp('2026-10-19 13:14:15')).toBe('2026-10-19 13:14');
    expect(fmtStamp(null)).toBe('');
  });
});

describe('файл целиком', () => {
  it('UTF-8 с BOM, разделитель «;», переносы CRLF', () => {
    const csv = renderListingsCsv([listing()], TODAY);
    expect(csv.charCodeAt(0), 'BOM обязателен, иначе Excel ломает кириллицу').toBe(0xFEFF);
    expect(csv).toContain('\r\n');
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv).not.toContain('\n\r');
    const lines = csv.slice(1).split('\r\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.startsWith('"id";"статус";"тип"')).toBe(true);
    expect(lines[0]!.split(';')).toHaveLength(CSV_HEADERS.length);
  });

  it('пустой список — файл только с шапкой', () => {
    const csv = renderListingsCsv([], TODAY);
    expect(csv.charCodeAt(0)).toBe(0xFEFF);
    expect(csv.slice(1).split('\r\n').filter((l) => l.length > 0)).toHaveLength(1);
  });

  it('многострочное описание остаётся одной строкой таблицы', () => {
    const csv = renderListingsCsv([listing({ description: 'Ночью около 02-00\nеду\nБрест - Бяла' })], TODAY);
    // шапка + одна заявка = две строки, хотя в описании было три
    expect(csv.slice(1).split('\r\n').filter((l) => l.length > 0)).toHaveLength(2);
    expect(csv).toContain('"Ночью около 02-00 еду Брест - Бяла"');
  });

  it('описание с кавычками и «;» не рвёт строку', () => {
    const csv = renderListingsCsv([listing()], TODAY);
    const row = csv.slice(1).split('\r\n')[1]!;
    // одна заявка — одна строка, даже если в описании есть «;»
    expect(csv.slice(1).split('\r\n').filter((l) => l.length > 0)).toHaveLength(2);
    // кавычки внутри значения удваиваются, а само значение остаётся в кавычках
    expect(row).toContain('""документы""');
    expect(row).toContain('Минск');
    expect(row).toContain('2026-10-25');
    expect(row).toContain('"6"'); // дней до выезда
  });
});

/* ---------- store ---------- */

interface Call { sql: string; params: unknown[] }

function recEnv(rows: Array<Record<string, unknown>> = []) {
  const calls: Call[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        const call: Call = { sql, params: [] };
        calls.push(call);
        const stmt = {
          bind(...params: unknown[]) { call.params = params; return stmt; },
          async run() { return { meta: { changes: 1 } }; },
          async all() { return { results: /SELECT \* FROM listings/.test(sql) ? rows : [] }; },
          async first() { return null; },
        };
        return stmt;
      },
      async batch(stmts: Array<{ run: () => Promise<unknown> }>) {
        return Promise.all(stmts.map((s) => s.run()));
      },
    },
    KV: { get: async () => null, put: async () => undefined },
    SITE_URL: 'https://pop-utka.app',
  } as unknown as Env;
  return { env, calls };
}

const selectCall = (calls: Call[]) => calls.find((c) => /SELECT \* FROM listings/.test(c.sql));

describe('listAllForExport', () => {
  it('берёт все статусы и сортирует по дате выезда вниз', async () => {
    const { env, calls } = recEnv();
    await listAllForExport(env);
    const call = selectCall(calls);
    expect(call, 'должен быть один SELECT из listings').toBeTruthy();
    expect(call!.sql, 'никакого фильтра по статусу — выгружаем всё').not.toContain('WHERE status');
    expect(call!.sql).toContain('ORDER BY departure_date DESC');
    expect(call!.params).toEqual([5000]);
  });

  it('необязательный фильтр по статусу уходит в параметры, не в строку', async () => {
    const { env, calls } = recEnv();
    await listAllForExport(env, 5000, 'pending');
    const call = selectCall(calls);
    expect(call!.sql).toContain('WHERE status = ?');
    expect(call!.params).toEqual(['pending', 5000]);
  });

  it('строки базы превращаются в Listing', async () => {
    const { env } = recEnv([{
      id: 'x1', type: 'request', from_city: 'Брест', to_city: 'Варшава',
      departure_date: '2026-11-02', weight_kg: null, price: 'договорная',
      description: 'нужно передать ключи', status: 'pending', source: 'site',
      by_admin: 2, hidden: 1, created_at: '2026-10-19 10:00:00', views: 0,
    }]);
    const items = await listAllForExport(env);
    expect(items).toHaveLength(1);
    expect(items[0]!.fromCity).toBe('Брест');
    expect(items[0]!.fromPerson).toBe(true);
    expect(items[0]!.hidden).toBe(true);
    expect(items[0]!.departureDate).toBe('2026-11-02');
  });
});

/* ---------- роут ---------- */

const ADMIN_TOKEN = 'testkey';

function routeEnv(rows: Array<Record<string, unknown>> = []) {
  const { env, calls } = recEnv(rows);
  const full = {
    ...env as unknown as Record<string, unknown>,
    ADMIN_API_TOKEN: ADMIN_TOKEN,
  } as unknown as Env;
  return { env: full, calls };
}

const dbRow = {
  id: 'aaaa1111', type: 'offer', from_city: 'Минск', to_city: 'Варшава',
  departure_date: '2026-10-25', weight_kg: 5, price: '50 EUR',
  description: 'Еду вечером; возьму "документы"', status: 'published',
  source: 'parser', source_chat: 'Чат Минск — Варшава', by_admin: 0, hidden: 0,
  created_at: '2026-10-19 13:14:15', published_at: null, views: 7,
};

async function get(path: string, token?: string) {
  const { env, calls } = routeEnv([dbRow]);
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const req = new Request(`https://pop-utka.app${path}`, { headers });
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined };
  const fn = (worker as unknown as { fetch: (r: Request, e: Env, c: unknown) => Promise<Response> }).fetch;
  const res = await fn(req, env, ctx);
  return {
    res,
    calls,
    text: async () => res.text(),
    // res.text() по спецификации снимает BOM, поэтому кодировку проверяем в байтах
    bytes: async () => new Uint8Array(await res.clone().arrayBuffer()),
  };
}

describe('GET /api/admin/listings.csv', () => {
  it('без ключа админки — 401', async () => {
    const { res } = await get('/api/admin/listings.csv');
    expect(res.status).toBe(401);
  });

  it('с чужим ключом — 401', async () => {
    const { res } = await get('/api/admin/listings.csv', 'wrong-key');
    expect(res.status).toBe(401);
  });

  it('с ключом — CSV в UTF-8 с нужными заголовками', async () => {
    const { res, text } = await get('/api/admin/listings.csv', ADMIN_TOKEN);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('Content-Type')).toContain('charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    expect(res.headers.get('Content-Disposition')).toMatch(/poputka-zayavki-\d{4}-\d{2}-\d{2}\.csv/);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    const bytes = await (await get('/api/admin/listings.csv', ADMIN_TOKEN)).bytes();
    expect([bytes[0], bytes[1], bytes[2]], 'файл обязан начинаться с EF BB BF').toEqual([0xEF, 0xBB, 0xBF]);
    const body = await text();
    expect(body.charCodeAt(0)).toBe(0x22); // text() снял BOM — дальше идёт кавычка шапки
    const lines = body.split('\r\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('Минск');
    expect(lines[1]).toContain('""документы""');
  });

  it('по умолчанию выгружает все статусы, ?status= — фильтрует', async () => {
    const all = await get('/api/admin/listings.csv', ADMIN_TOKEN);
    expect(selectCall(all.calls)!.params).toEqual([5000]);
    const pending = await get('/api/admin/listings.csv?status=pending', ADMIN_TOKEN);
    expect(selectCall(pending.calls)!.params).toEqual(['pending', 5000]);
    // неизвестный статус — как «все», а не пустой файл
    const junk = await get('/api/admin/listings.csv?status=чепуха', ADMIN_TOKEN);
    expect(selectCall(junk.calls)!.sql).not.toContain('WHERE status');
  });

  it('пути не пересекаются с /api/admin/listings/:id/status', async () => {
    const statuses: ListingStatus[] = ['published', 'pending', 'rejected', 'expired'];
    expect(statuses).toHaveLength(4);
    const { res } = await get('/api/admin/listings.csv', ADMIN_TOKEN);
    expect(res.status).not.toBe(404);
  });
});
