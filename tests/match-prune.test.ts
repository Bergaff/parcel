/**
 * История прогонов подбора живёт 3 дня: пары хранят снимки заявок, которые
 * быстро устаревают. Cron выметает их раз в сутки, а админка — прямо перед
 * показом истории, чтобы старые прогоны не висели в списке и счётчик
 * «История подборов: N» не врал.
 */
import { describe, expect, it, vi } from 'vitest';

/* src/og тянет resvg.wasm — vite в тестах wasm не грузит, а роуту подбора
   OG-картинки не нужны. Подменяем до импорта воркера. */
vi.mock('../src/og', () => ({
  renderOgImage: async () => new Uint8Array(),
  renderRouteOg: async () => new Uint8Array(),
}));

import { pruneMatchRuns } from '../src/store';
import type { Env } from '../src/types';
import worker from '../src/index';

interface Call { sql: string; params: unknown[] }

/** D1-подделка: пишет поток SQL, DELETE прогонов возвращает заданное число. */
function fakeDb(opts: { runsChanges?: number; runRows?: Array<Record<string, unknown>> } = {}) {
  const calls: Call[] = [];
  const make = (sql: string) => {
    const call: Call = { sql, params: [] };
    calls.push(call);
    const stmt = {
      bind(...params: unknown[]) { call.params = params; return stmt; },
      async all() {
        if (/SELECT \* FROM match_runs ORDER BY created_at DESC/.test(sql)) {
          return { results: opts.runRows ?? [] };
        }
        return { results: [] };
      },
      async run() {
        if (/DELETE FROM match_runs/.test(sql)) return { meta: { changes: opts.runsChanges ?? 0 } };
        return { meta: { changes: 1 } };
      },
      async first() { return null; },
    };
    return stmt;
  };
  return {
    db: {
      prepare: make,
      // как настоящий D1: batch выполняет каждый стейтмент и возвращает их результаты
      batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => Promise.all(stmts.map((st) => st.run())),
    },
    calls,
  };
}

const baseEnv = {
  KV: { get: async () => null, put: async () => undefined },
  SITE_URL: 'https://pop-utka.app',
  ADMIN_API_TOKEN: 'testkey',
} as unknown as Record<string, unknown>;

const deletes = (calls: Call[], table: string) =>
  calls.filter((c) => c.sql.startsWith(`DELETE FROM ${table}`));

describe('pruneMatchRuns — порог удаления', () => {
  it('сначала пары, потом прогоны; порог через datetime(), а не голое сравнение строк', async () => {
    const { db, calls } = fakeDb({ runsChanges: 2 });
    const env = { ...baseEnv, DB: db } as unknown as Env;
    const pruned = await pruneMatchRuns(env);
    expect(pruned).toBe(2);

    const pairs = deletes(calls, 'match_pairs');
    const runs = deletes(calls, 'match_runs');
    expect(pairs).toHaveLength(1);
    expect(runs).toHaveLength(1);
    // пары удаляются до прогонов: на ON DELETE CASCADE не полагаемся
    expect(calls.indexOf(pairs[0]!)).toBeLessThan(calls.indexOf(runs[0]!));
    expect(pairs[0]!.sql).toContain('WHERE run_id IN');
    for (const d of [...pairs, ...runs]) {
      // created_at пишется toISOString(); голое сравнение строк ломается на 'T'
      // против datetime('now') — урок v0.4.44, обе стороны оборачиваем
      expect(d.sql).toContain(`datetime(created_at) < datetime('now', ?)`);
      expect(d.params).toEqual(['-3 days']);
    }
  });

  it('свой срок хранения уходит в порог, мусор округляется до 1 дня', async () => {
    const a = fakeDb();
    await pruneMatchRuns({ ...baseEnv, DB: a.db } as unknown as Env, 7);
    expect(deletes(a.calls, 'match_runs')[0]!.params).toEqual(['-7 days']);

    const b = fakeDb();
    await pruneMatchRuns({ ...baseEnv, DB: b.db } as unknown as Env, 0);
    expect(deletes(b.calls, 'match_runs')[0]!.params).toEqual(['-1 days']);
  });
});

describe('GET /api/admin/match — выметание перед показом', () => {
  const runRow = {
    id: 'r1', created_at: new Date().toISOString(), from_city: null, to_city: null,
    days_window: 3, include_archive: 0, partial: 0, offers_total: 4, requests_total: 2,
    pairs_found: 1, notified: 0, note: null,
  };

  it('удаляет старые прогоны до выборки списка', async () => {
    const { db, calls } = fakeDb({ runRows: [runRow] });
    const env = { ...baseEnv, DB: db } as unknown as Env;
    const req = new Request('https://pop-utka.app/api/admin/match?limit=20', {
      headers: { Authorization: 'Bearer testkey' },
    });
    const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined };
    const fn = (worker as unknown as { fetch: (r: Request, e: Env, c: unknown) => Promise<Response> }).fetch;
    const res = await fn(req, env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: Array<{ id: string }> };
    expect(body.runs.map((r) => r.id)).toEqual(['r1']);
    // порядок важен: сначала DELETE старых, потом SELECT списка
    const delIdx = calls.findIndex((c) => c.sql.startsWith('DELETE FROM match_runs'));
    const selIdx = calls.findIndex((c) => /SELECT \* FROM match_runs ORDER BY/.test(c.sql));
    expect(delIdx).toBeGreaterThanOrEqual(0);
    expect(selIdx).toBeGreaterThan(delIdx);
  });
});
