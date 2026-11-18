/**
 * Статистика автоодобрения (v0.4.70): счётчики по дням в auto_pub_days и
 * причины задержки в auto_pub_reasons, сводка autoPublishStats для админки
 * (вкладка «итоги», блок «Автоодобрение»).
 *
 * Зачем отдельные таблицы, а не выборка из listings: точный дубль заявку НЕ
 * создаёт (строки в базе нет вовсе), а сами заявки удаляет cron — посчитать
 * такие события задним числом неоткуда. Отсюда же требование: сбой счётчика
 * не должен ронять создание заявки.
 */
import { describe, expect, it, vi } from 'vitest';

/* src/og тянет resvg.wasm — vite в тестах wasm не грузит. */
vi.mock('../src/og', () => ({
  renderOgImage: async () => new Uint8Array(),
  renderRouteOg: async () => new Uint8Array(),
}));

import type { Env } from '../src/types';
import worker from '../src/index';
import {
  autoPublishStats, bumpAutoPubReason, bumpAutoPubStat, countAutoPublish,
} from '../src/store';
import { DOUBT_LABELS, doubtLabel } from '../src/auto-publish';
import { mskDayIso, mskTodayIso } from '../src/util';

interface Call { sql: string; params: unknown[] }

/** База, которая только записывает запросы (и отдаёт то, что попросили). */
function recDb(rows: { days?: unknown[]; reasons?: unknown[] } = {}) {
  const calls: Call[] = [];
  const make = (sql: string) => {
    const call: Call = { sql, params: [] };
    calls.push(call);
    const stmt = {
      bind(...p: unknown[]) { call.params = p; return stmt; },
      async run() { return { meta: { changes: 1 } }; },
      async all() {
        if (sql.includes('FROM auto_pub_days')) return { results: rows.days ?? [] };
        if (sql.includes('FROM auto_pub_reasons')) return { results: rows.reasons ?? [] };
        return { results: [] };
      },
      async first() { return null; },
    };
    return stmt;
  };
  return {
    calls,
    env: { DB: { prepare: make, batch: async (s: unknown[]) => Promise.all(s as never) } } as unknown as Env,
  };
}

/** Имена колонок, в которые писали +1 (порядок сохраняется). */
const events = (calls: Call[]) => calls
  .map((c) => /INSERT INTO auto_pub_days \(day, (\w+)\)/.exec(c.sql)?.[1])
  .filter((x): x is string => Boolean(x));

/** Коды причин, которые записали. */
const reasons = (calls: Call[]) => calls
  .filter((c) => c.sql.includes('INSERT INTO auto_pub_reasons'))
  .map((c) => String(c.params[1]));

const verdict = (publish: boolean, codes: Array<keyof typeof DOUBT_LABELS> = []) => ({
  publish,
  doubts: codes.map((code) => ({ code, note: doubtLabel(code) })),
});

/* --------------------------- счётчики дня --------------------------- */

describe('bumpAutoPubStat: имя события — это имя колонки, поэтому список закрытый', () => {
  it('известное событие — UPSERT в свою колонку, день параметром', async () => {
    const { calls, env } = recDb();
    await bumpAutoPubStat(env, 'auto_published', '2026-11-18');
    const up = calls.find((c) => c.sql.includes('INSERT INTO auto_pub_days'));
    expect(up, 'запрос есть').toBeTruthy();
    expect(up!.sql).toContain('ON CONFLICT(day) DO UPDATE SET auto_published = auto_published + 1');
    expect(up!.params).toEqual(['2026-11-18']);
  });

  it('неизвестное имя не доходит до SQL: подставить в запрос нечего', async () => {
    const { calls, env } = recDb();
    await bumpAutoPubStat(env, 'x = 1; DROP TABLE listings; --' as never, '2026-11-18');
    expect(calls.filter((c) => c.sql.includes('INSERT INTO auto_pub_days'))).toHaveLength(0);
  });

  it('день по умолчанию — сегодняшний по МСК (как в остальной статистике)', async () => {
    const { calls, env } = recDb();
    await bumpAutoPubStat(env, 'held');
    expect(calls.find((c) => c.sql.includes('INSERT INTO auto_pub_days'))!.params).toEqual([mskTodayIso()]);
    expect(mskTodayIso()).toBe(mskDayIso(Date.now()));
  });
});

describe('bumpAutoPubReason: признак сомнения — строка на день и код', () => {
  it('пишет код и день, увеличивает n', async () => {
    const { calls, env } = recDb();
    await bumpAutoPubReason(env, 'ai_parsed', '2026-11-18');
    const up = calls.find((c) => c.sql.includes('INSERT INTO auto_pub_reasons'));
    expect(up!.sql).toContain('ON CONFLICT(day, code) DO UPDATE SET n = n + 1');
    expect(up!.params).toEqual(['2026-11-18', 'ai_parsed']);
  });

  it('мусор вместо кода не пишется', async () => {
    const { calls, env } = recDb();
    await bumpAutoPubReason(env, 'ai parsed');       // пробел
    await bumpAutoPubReason(env, 'CODE');            // регистр
    await bumpAutoPubReason(env, 'x"); DROP TABLE auto_pub_days; --');
    expect(calls.filter((c) => c.sql.includes('INSERT INTO auto_pub_reasons'))).toHaveLength(0);
  });

  it('у каждого кода сомнения есть короткая подпись для таблицы', () => {
    for (const code of Object.keys(DOUBT_LABELS)) {
      expect(doubtLabel(code).length, code).toBeGreaterThan(3);
    }
    expect(doubtLabel('неизвестный_код')).toBe('неизвестный_код');
  });
});

/* ------------------- что именно считаем при создании ------------------- */

describe('countAutoPublish: правило «что считаем» в одном месте', () => {
  it('админская опубликована автоматически — приход и автопубликация', async () => {
    const { calls, env } = recDb();
    await countAutoPublish(env, { byAdmin: true }, null, verdict(true));
    expect(events(calls)).toEqual(['admin_arrived', 'auto_published']);
    expect(reasons(calls)).toEqual([]);
  });

  it('админская задержана — приход, задержка и по единице на каждый признак', async () => {
    const { calls, env } = recDb();
    await countAutoPublish(env, { byAdmin: true }, null, verdict(false, ['ai_parsed', 'date_past']));
    expect(events(calls)).toEqual(['admin_arrived', 'held']);
    expect(reasons(calls)).toEqual(['ai_parsed', 'date_past']);
  });

  it('один признак не считается дважды, даже если сомнений несколько одинаковых', async () => {
    const { calls, env } = recDb();
    // city_garbage бывает дважды (откуда и куда) — в таблице нужна одна строка +2?
    // нет: считаем заявку, а не вхождения, поэтому пишем один раз
    await countAutoPublish(env, { byAdmin: true }, null, verdict(false, ['city_garbage', 'city_garbage']));
    expect(reasons(calls)).toEqual(['city_garbage']);
  });

  it('посторонняя заявка — только общее правило «нет контакта», приход не считаем', async () => {
    const { calls, env } = recDb();
    await countAutoPublish(env, { byAdmin: false }, { status: 'rejected', hidden: false }, null);
    expect(events(calls)).toEqual(['rejected_no_contact']);
  });

  it('посторонняя заявка без отказа — в счётчики не попадает вовсе', async () => {
    const { calls, env } = recDb();
    await countAutoPublish(env, { byAdmin: false }, null, null);
    expect(events(calls)).toEqual([]);
  });

  it('админская без контакта — отклонена: отказ и приход, автопубликации нет', async () => {
    const { calls, env } = recDb();
    await countAutoPublish(env, { byAdmin: true }, { status: 'rejected', hidden: false }, null);
    expect(events(calls)).toEqual(['rejected_no_contact', 'admin_arrived']);
  });

  it('решило не автоодобрение (AUTO_APPROVE=1) — только приход', async () => {
    const { calls, env } = recDb();
    await countAutoPublish(env, { byAdmin: true }, null, { publish: false, doubts: [] });
    expect(events(calls)).toEqual(['admin_arrived']);
  });
});

/* ------------------------------ сводка ------------------------------ */

const dayRow = (over: Record<string, unknown> = {}) => ({
  day: '2026-11-18', admin_arrived: 0, auto_published: 0, held: 0,
  dup_skipped: 0, rejected_no_contact: 0, ...over,
});

describe('autoPublishStats: что видит админ', () => {
  it('итоги складывает по дням, причины подписывает по-человечески', async () => {
    const { env } = recDb({
      days: [
        dayRow({ day: '2026-11-17', admin_arrived: 10, auto_published: 7, held: 3, dup_skipped: 2, rejected_no_contact: 1 }),
        dayRow({ day: '2026-11-18', admin_arrived: 5, auto_published: 4, held: 1, rejected_no_contact: 2 }),
      ],
      reasons: [{ code: 'ai_parsed', n: 3 }, { code: 'contact_in_text', n: 1 }],
    });
    const s = await autoPublishStats(env, 7);
    expect(s.byDay.map((d) => d.day)).toEqual(['2026-11-17', '2026-11-18']); // старые → новые
    expect(s.byDay[1]).toEqual({
      day: '2026-11-18', adminArrived: 5, autoPublished: 4, held: 1, dupSkipped: 0, rejectedNoContact: 2,
    });
    expect(s.totals).toEqual({ adminArrived: 15, autoPublished: 11, held: 4, dupSkipped: 2, rejectedNoContact: 3 });
    expect(s.reasons).toEqual([
      { code: 'ai_parsed', note: DOUBT_LABELS.ai_parsed, n: 3 },
      { code: 'contact_in_text', note: DOUBT_LABELS.contact_in_text, n: 1 },
    ]);
    expect(s.days).toBe(7);
  });

  it('«за 7 дней» — сегодня и шесть предыдущих; «за всё время» — без границы', async () => {
    const { calls, env } = recDb();
    const week = await autoPublishStats(env, 7);
    expect(week.since).toBe(mskDayIso(Date.now() - 6 * 86_400_000));
    const today = await autoPublishStats(env, 1);
    expect(today.since).toBe(mskTodayIso());
    const all = await autoPublishStats(env, 0);
    expect(all.since).toBe('0000-01-01');
    // граница уходит в запрос параметром, а не склеивается в SQL
    expect(calls.filter((c) => c.sql.includes('FROM auto_pub_days')).every((c) => c.params.length === 1)).toBe(true);
  });

  it('пустые счётчики — нули, а не NaN и не undefined', async () => {
    const { env } = recDb({ days: [dayRow()], reasons: [{ code: 'date_past', n: 0 }] });
    const s = await autoPublishStats(env, 30);
    expect(s.totals).toEqual({ adminArrived: 0, autoPublished: 0, held: 0, dupSkipped: 0, rejectedNoContact: 0 });
    // нулевую причину не показываем: строка «0 заявок» только путает
    expect(s.reasons).toEqual([]);
  });

  it('в таблице только дни окна: запрос фильтрует по since', async () => {
    const { calls, env } = recDb();
    await autoPublishStats(env, 30);
    const q = calls.find((c) => c.sql.includes('FROM auto_pub_days'));
    expect(q!.sql).toContain('WHERE day >= ?');
    expect(q!.params).toEqual([mskDayIso(Date.now() - 29 * 86_400_000)]);
  });
});

/* ------------------------ GET /api/admin/auto-stats ------------------------ */

/** База-фейк для ручки: отвечает на SELECT из auto_pub_days / auto_pub_reasons. */
function apiEnv(opts: { days: unknown[]; reasons: unknown[]; token?: string }) {
  const queries: string[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        const stmt = {
          bind: () => stmt,
          run: async () => ({ meta: { changes: 0 } }),
          all: async () => {
            queries.push(sql);
            if (sql.includes('FROM auto_pub_days')) return { results: opts.days };
            if (sql.includes('FROM auto_pub_reasons')) return { results: opts.reasons };
            return { results: [] };
          },
          first: async () => null,
        };
        return stmt;
      },
      batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => Promise.all(stmts.map((s) => s.run())),
    },
    KV: { get: async () => null, put: async () => undefined, delete: async () => undefined },
    SITE_URL: 'https://pop-utka.app',
    ADMIN_API_TOKEN: 'testkey',
  } as unknown as Env;
  return { env, queries };
}

async function get(env: Env, url: string, token: string | null = 'testkey') {
  const req = new Request(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined };
  const fn = (worker as unknown as { fetch: (r: Request, e: Env, c: unknown) => Promise<Response> }).fetch;
  return fn(req, env, ctx);
}

describe('GET /api/admin/auto-stats — админка видит счётчики за период', () => {
  const days = [dayRow({ day: '2026-11-18', admin_arrived: 4, auto_published: 3, held: 1 })];
  const reasons = [{ code: 'date_past', n: 1 }];

  it('отдаёт дни, итоги, причины и окно (since) — период подписан честно', async () => {
    const { env } = apiEnv({ days, reasons });
    const res = await get(env, 'https://pop-utka.app/api/admin/auto-stats?days=7');
    expect(res.status).toBe(200);
    const body = await res.json() as Awaited<ReturnType<typeof autoPublishStats>>;
    expect(body.days).toBe(7);
    expect(body.since).toBe(mskDayIso(Date.now() - 6 * 86_400_000));
    expect(body.totals).toEqual({
      adminArrived: 4, autoPublished: 3, held: 1, dupSkipped: 0, rejectedNoContact: 0,
    });
    expect(body.byDay).toHaveLength(1);
    expect(body.reasons[0]).toEqual({ code: 'date_past', note: DOUBT_LABELS.date_past, n: 1 });
  });

  it('без days — окно 30 дней (как открывается вкладка)', async () => {
    const { env } = apiEnv({ days, reasons });
    const body = await (await get(env, 'https://pop-utka.app/api/admin/auto-stats')).json() as { days: number };
    expect(body.days).toBe(30);
  });

  it('мусор и крайности в days не ломают запрос', async () => {
    const { env } = apiEnv({ days, reasons });
    for (const [q, want] of [['days=abc', 30], ['days=-5', 0], ['days=99999', 400]] as Array<[string, number]>) {
      const body = await (await get(env, `https://pop-utka.app/api/admin/auto-stats?${q}`)).json() as { days: number };
      expect(body.days, q).toBe(want);
    }
  });

  it('без ключа админа — 401, счётчики наружу не уходят', async () => {
    const { env } = apiEnv({ days, reasons });
    const res = await get(env, 'https://pop-utka.app/api/admin/auto-stats?days=7', null);
    expect(res.status).toBe(401);
  });

  it('пустая база — нули, а не ошибка: блок в админке рисуется всегда', async () => {
    const { env } = apiEnv({ days: [], reasons: [] });
    const res = await get(env, 'https://pop-utka.app/api/admin/auto-stats?days=30');
    expect(res.status).toBe(200);
    const body = await res.json() as { byDay: unknown[]; totals: Record<string, number> };
    expect(body.byDay).toEqual([]);
    expect(body.totals.adminArrived).toBe(0);
  });
});
