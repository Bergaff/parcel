/**
 * Честные просмотры заявок («Самые просматриваемые», v0.4.54).
 *
 * Повод — сомнение владельца: топ-10 отчёта был весь из архива с 4–8
 * «просмотрами». Причина: сырой счётчик listings.views крутился только на
 * кликах внутри сайта (API), прямые/поисковые заходы на карточку не считались,
 * боты и собственные заходы не отсекались, дедупликации не было.
 *
 * Контракт теперь: stat_item_views — одна строка на человека в сутки на заявку
 * (PRIMARY KEY day+listing+vid, INSERT OR IGNORE), с флагами bot и own;
 * отчёт = COUNT(*) WHERE bot=0 AND own=0. Пишется и на SSR /item/:id
 * (мидлварь) и на API /api/listings/:id (клик внутри сайта).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/* src/og тянет resvg.wasm — vite в тестах wasm не грузит. */
import { vi } from 'vitest';
vi.mock('../src/og', () => ({
  renderOgImage: async () => new Uint8Array(),
  renderRouteOg: async () => new Uint8Array(),
}));

import type { Env } from '../src/types';
import { trackItemView } from '../src/visit-stats';
import { listMostViewed } from '../src/store';
import worker from '../src/index';

interface Call { sql: string; params: unknown[] }

const HUMAN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';
const BOT = 'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)';
const SHELL = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

/** Заглушка D1+KV: запоминает SQL и параметры. first() отвечает строкой заявки. */
function recEnv(listingRow: Record<string, unknown> | null = null) {
  const calls: Call[] = [];
  const kv = new Map<string, string>();
  const make = (sql: string) => {
    const call: Call = { sql, params: [] };
    calls.push(call);
    const stmt = {
      bind(...params: unknown[]) { call.params = params; return stmt; },
      async run() { return { meta: { changes: 1 } }; },
      async all() {
        if (/PRAGMA table_info/.test(sql)) return { results: [] };
        return { results: [] };
      },
      async first() {
        if (/FROM listings WHERE id/.test(sql)) return listingRow;
        return null;
      },
    };
    return stmt;
  };
  const env = {
    DB: { prepare: make, batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => Promise.all(stmts.map((s) => s.run())) },
    KV: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v); } },
    ASSETS: { fetch: async () => new Response(SHELL, { status: 200 }) },
    SITE_URL: 'https://pop-utka.app',
  } as unknown as Env;
  return { env, calls };
}

const itemInserts = (calls: Call[]) => calls.filter((c) => /INSERT OR IGNORE INTO stat_item_views/.test(c.sql));

const ROW = {
  id: 'aaaaaaaa-1111-2222-3333-444444444444',
  type: 'offer', from_city: 'Минск', to_city: 'Варшава',
  departure_date: null, recurring: null, weight_kg: null, price: null,
  description: 'Еду в пятницу', phone: null, telegram: '@ivan',
  status: 'published', source: 'telegram', created_at: '2026-10-01T08:00:00.000Z',
  published_at: '2026-10-01T08:00:00.000Z', views: 99, by_admin: 0, hidden: 0,
};

describe('trackItemView — запись просмотра заявки', () => {
  it('человек: bot=0, own=0, vid — суточный хеш, заявка — параметром', async () => {
    const { env, calls } = recEnv();
    await trackItemView(env, { listingId: 'abc-123', ip: '1.2.3.4', ua: HUMAN });
    const ins = itemInserts(calls);
    expect(ins).toHaveLength(1);
    const [day, listingId, vid, bot, own] = ins[0]!.params as unknown[];
    expect(String(day)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(listingId).toBe('abc-123');
    expect(String(vid)).toMatch(/^[0-9a-f]{32}$/);
    expect(bot).toBe(0);
    expect(own).toBe(0);
  });

  it('бот: bot=1, vid общий — отчёт его исключит', async () => {
    const { env, calls } = recEnv();
    await trackItemView(env, { listingId: 'abc-123', ip: '9.9.9.9', ua: BOT });
    const ins = itemInserts(calls);
    expect(ins).toHaveLength(1);
    const [, , vid, bot] = ins[0]!.params as unknown[];
    expect(vid).toBe('bot');
    expect(bot).toBe(1);
  });

  it('владелец сайта (куки own): own=1 — в отчёт не попадёт', async () => {
    const { env, calls } = recEnv();
    await trackItemView(env, { listingId: 'abc-123', ip: '1.2.3.4', ua: HUMAN, own: true });
    const [, , , bot, own] = itemInserts(calls)[0]!.params as unknown[];
    expect(bot).toBe(0);
    expect(own).toBe(1);
  });

  it('дедупликация — INSERT OR IGNORE (обновление страницы не накручивает)', () => {
    const { env, calls } = recEnv();
    return trackItemView(env, { listingId: 'x', ip: '1.1.1.1', ua: HUMAN }).then(() => {
      expect(itemInserts(calls)[0]!.sql).toMatch(/INSERT OR IGNORE INTO stat_item_views/);
      expect(itemInserts(calls)[0]!.sql).toMatch(/PRIMARY KEY|day, listing_id, vid/i);
    });
  });

  it('пустой id — ничего не пишем', async () => {
    const { env, calls } = recEnv();
    await trackItemView(env, { listingId: '  ', ip: '1.2.3.4', ua: HUMAN });
    expect(itemInserts(calls)).toHaveLength(0);
  });
});

describe('listMostViewed — отчёт из stat_item_views', () => {
  it('JOIN по заявкам, только живые люди, сортировка по числу просмотров', async () => {
    const { env, calls } = recEnv();
    await listMostViewed(env, 10);
    const q = calls.find((c) => /FROM stat_item_views/.test(c.sql))!;
    expect(q.sql).toMatch(/JOIN listings l ON l\.id = v\.listing_id/);
    expect(q.sql).toMatch(/v\.bot = 0 AND v\.own = 0/);
    expect(q.sql).toMatch(/GROUP BY v\.listing_id/);
    expect(q.sql).toMatch(/ORDER BY human_views DESC/);
    expect(q.params[0]).toBe(10);
  });

  it('views в отчёте — честное число людей, а не сырой счётчик', async () => {
    // подделка возвращает строку заявки с сырым views=99 и human_views=5
    const calls: Call[] = [];
    const make = (sql: string) => {
      const call: Call = { sql, params: [] };
      calls.push(call);
      const stmt = {
        bind(...params: unknown[]) { call.params = params; return stmt; },
        async all() { return { results: [{ ...ROW, human_views: 5 }] }; },
        async first() { return null; },
        async run() { return { meta: { changes: 0 } }; },
      };
      return stmt;
    };
    const env = { DB: { prepare: make } } as unknown as Env;
    const rows = await listMostViewed(env, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.views).toBe(5);
    expect(rows[0]!.fromCity).toBe('Минск');
  });
});

describe('воркер пишет просмотр заявки на обоих путях', () => {
  async function callWorker(path: string, ua: string) {
    const { env, calls } = recEnv({ ...ROW });
    const pending: Array<Promise<unknown>> = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => undefined)); },
      passThroughOnException: () => undefined,
    };
    (globalThis as Record<string, unknown>).caches = {
      default: { match: async () => undefined, put: async () => undefined },
    };
    const fn = (worker as unknown as { fetch: (r: Request, e: Env, c: unknown) => Promise<Response> }).fetch;
    const res = await fn(new Request(`https://pop-utka.app${path}`, { headers: { 'user-agent': ua } }), env, ctx);
    await Promise.all(pending);
    delete (globalThis as Record<string, unknown>).caches;
    return { res, calls };
  }

  it('прямой заход на /item/:id (SSR) — просмотр засчитан, человек', async () => {
    const { res, calls } = await callWorker(`/item/${ROW.id}`, HUMAN);
    expect(res.status).toBe(200);
    const ins = itemInserts(calls);
    expect(ins).toHaveLength(1);
    expect(ins[0]!.params[1]).toBe(ROW.id);
    expect(ins[0]!.params[3]).toBe(0); // bot
  });

  it('YandexBot на /item/:id — записан с bot=1 (отчёт исключит)', async () => {
    const { calls } = await callWorker(`/item/${ROW.id}`, BOT);
    const ins = itemInserts(calls);
    expect(ins).toHaveLength(1);
    expect(ins[0]!.params[3]).toBe(1);
  });

  it('клик внутри сайта (API /api/listings/:id) — просмотр засчитан', async () => {
    const { res, calls } = await callWorker(`/api/listings/${ROW.id}`, HUMAN);
    expect(res.status).toBe(200);
    const ins = itemInserts(calls);
    expect(ins).toHaveLength(1);
    expect(ins[0]!.params[1]).toBe(ROW.id);
    expect(ins[0]!.params[4]).toBe(0); // own
  });

  it('404 карточки просмотр не пишет', async () => {
    const { env, calls } = recEnv(null); // заявки нет
    const pending: Array<Promise<unknown>> = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p.catch(() => undefined)); }, passThroughOnException: () => undefined };
    (globalThis as Record<string, unknown>).caches = {
      default: { match: async () => undefined, put: async () => undefined },
    };
    const fn = (worker as unknown as { fetch: (r: Request, e: Env, c: unknown) => Promise<Response> }).fetch;
    await fn(new Request(`https://pop-utka.app/api/listings/${ROW.id}`, { headers: { 'user-agent': HUMAN } }), env, ctx);
    await Promise.all(pending);
    delete (globalThis as Record<string, unknown>).caches;
    expect(itemInserts(calls)).toHaveLength(0);
  });
});
