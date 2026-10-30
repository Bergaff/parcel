/**
 * Отчёт «чьи юзернеймы чаще всего в заявках» (админ-вкладка «статистика»).
 * listTopUsernames группирует заявки по контакту-юзернейму без учёта регистра,
 * исключает отклонённые, сортирует по числу заявок и отдаёт знаменатель доли
 * (сколько всего заявок с юзернеймом).
 */
import { describe, expect, it } from 'vitest';

import type { Env } from '../src/types';
import { listTopUsernames } from '../src/store';

interface Call { sql: string; params: unknown[] }

/** Подделка D1: агрегат возвращает заданные строки, count — заданное число. */
function fakeDb(aggRows: Array<Record<string, unknown>>, withContact: number) {
  const calls: Call[] = [];
  const make = (sql: string) => {
    const call: Call = { sql, params: [] };
    calls.push(call);
    const stmt = {
      bind(...params: unknown[]) { call.params = params; return stmt; },
      async all() {
        return { results: /GROUP BY lower\(telegram\)/.test(sql) ? aggRows : [] };
      },
      async first() {
        return /COUNT\(\*\) AS n/.test(sql) ? { n: withContact } : null;
      },
      async run() { return { meta: { changes: 0 } }; },
    };
    return stmt;
  };
  const db = { prepare: make, batch: async (s: unknown[]) => Promise.all(s as never) };
  return { env: { DB: db } as unknown as Env, calls };
}

const agg = (calls: Call[]) => calls.find((c) => /GROUP BY lower\(telegram\)/.test(c.sql))!;

describe('listTopUsernames — отчёт по юзернеймам', () => {
  it('группирует без учёта регистра, исключает rejected, сортирует по числу заявок', async () => {
    const { env, calls } = fakeDb([], 0);
    await listTopUsernames(env, 20);
    const a = agg(calls);
    expect(a.sql).toMatch(/GROUP BY lower\(telegram\)/);
    expect(a.sql).toMatch(/status != 'rejected'/);
    expect(a.sql).toMatch(/ORDER BY total DESC/);
    expect(a.params[0]).toBe(20);
  });

  it('считает живые и архив, но не отклонённые (WHERE покрывает и то и другое)', async () => {
    const { env, calls } = fakeDb([], 0);
    await listTopUsernames(env, 20);
    // отклонённые исключены явно; published/expired/pending остаются
    expect(agg(calls).sql).not.toMatch(/status IN/);
    expect(agg(calls).sql).toMatch(/telegram IS NOT NULL/);
  });

  it('маппит строки: username, total, offers, requests, lastAt (datetime и null)', async () => {
    const { env } = fakeDb([
      { username: '@ivan', total: 7, offers: 5, requests: 2, last_at: '2026-10-29 12:00:00' },
      { username: '@maria', total: 3, offers: 0, requests: 3, last_at: null },
    ], 10);
    const { rows, withContact } = await listTopUsernames(env, 20);
    expect(withContact).toBe(10);
    expect(rows).toEqual([
      { username: '@ivan', total: 7, offers: 5, requests: 2, lastAt: '2026-10-29 12:00:00' },
      { username: '@maria', total: 3, offers: 0, requests: 3, lastAt: null },
    ]);
  });

  it('знаменатель доли берётся отдельным COUNT', async () => {
    const { env, calls } = fakeDb([], 42);
    const { withContact } = await listTopUsernames(env, 20);
    expect(withContact).toBe(42);
    expect(calls.some((c) => /COUNT\(\*\) AS n/.test(c.sql))).toBe(true);
  });

  it('limit зажимается в 1..100', async () => {
    const hi = fakeDb([], 0);
    await listTopUsernames(hi.env, 500);
    expect(agg(hi.calls).params[0]).toBe(100);
    const lo = fakeDb([], 0);
    await listTopUsernames(lo.env, 0);
    expect(agg(lo.calls).params[0]).toBe(1);
  });

  it('пустая база — пустой отчёт, знаменатель 0', async () => {
    const { env } = fakeDb([], 0);
    const { rows, withContact } = await listTopUsernames(env, 20);
    expect(rows).toEqual([]);
    expect(withContact).toBe(0);
  });
});
