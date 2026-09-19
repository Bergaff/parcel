/**
 * Регулярные рейсы в archiveExpired: cron катит дату выезда на ближайший
 * заезд, а не роняет живую заявку в архив. Проверяем SQL-поток на фальшивом D1:
 * какие строки он выбрал и какие UPDATE в итоге выполнил.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../src/types';
import { archiveExpired, resetSearchColumnsCache } from '../src/store';

interface Call { sql: string; params: unknown[] }

/** Строка регулярной заявки из базы. */
function recurringRow(over: Record<string, unknown> = {}) {
  return {
    id: '11111111-2222-3333-4444-555555555555',
    recurring: 'каждый четверг',
    departure_date: '2026-09-10',
    ...over,
  };
}

/** D1-подделка: SELECT возвращает заданные строки, UPDATE/DELETE «выполняются». */
function fakeDb(selectRows: Record<string, unknown>[]) {
  const calls: Call[] = [];
  const make = (sql: string) => {
    const call: Call = { sql, params: [] };
    calls.push(call);
    const stmt = {
      bind(...params: unknown[]) {
        call.params = params;
        return stmt;
      },
      async all() {
        if (/PRAGMA table_info/.test(sql)) {
          // колонка recurring уже есть — ALTER не нужен
          return { results: ['id', 'recurring'].map((name) => ({ name })) };
        }
        if (/^SELECT id, recurring/.test(sql)) return { results: selectRows };
        return { results: [] };
      },
      async run() { return { meta: { changes: 1 } }; },
      async first() { return null; },
    };
    return stmt;
  };
  return { env: { DB: { prepare: make } } as unknown as Env, calls };
}

beforeEach(() => {
  resetSearchColumnsCache();
});

describe('archiveExpired — регулярные рейсы', () => {
  // суббота 2026-09-19: если cron простаивал, дата должна догнать сегодня
  const NOW = new Date('2026-09-19T12:00:00Z');

  it('катит дату на ближайший заезд вместо архива', async () => {
    const { env, calls } = fakeDb([recurringRow()]);
    const res = await archiveExpired(env, NOW);

    expect(res.rolled).toBe(1);
    // 2026-09-10 — четверг; сегодня 19-е (суббота) → следующий четверг 24-го,
    // с догоном за один прогон, а не по шагу в день
    const roll = calls.find((c) => c.sql.startsWith('UPDATE listings SET departure_date = ?'));
    expect(roll).toBeDefined();
    expect(roll!.params[0]).toBe('2026-09-24');
    expect(roll!.params[1]).toBe('11111111-2222-3333-4444-555555555555');
    // архивирующий UPDATE не должен трогать регулярные
    const archive = calls.find((c) => c.sql.includes("SET status = 'expired'"));
    expect(archive!.sql).toContain('recurring IS NULL');
  });

  it('будущая дата — не катится', async () => {
    // предстоящий четверг 23-го... в будущем относительно NOW — SELECT такую
    // строку не вернёт, но и случайная строка с будущей датой не трогается
    const { env, calls } = fakeDb([recurringRow({ departure_date: '2026-09-24' })]);
    const res = await archiveExpired(env, NOW);
    expect(res.rolled).toBe(0);
    expect(calls.find((c) => c.sql.startsWith('UPDATE listings SET departure_date = ?'))).toBeUndefined();
  });

  it('живым регулярным запрос нужен только с непрошедшей датой', async () => {
    const { env, calls } = fakeDb([recurringRow()]);
    await archiveExpired(env, NOW);
    const select = calls.find((c) => c.sql.startsWith('SELECT id, recurring'));
    expect(select!.sql).toContain("departure_date < date('now', '+3 hours')");
    expect(select!.sql).toContain("datetime('now', '-45 days')");
  });

  it('мёртвые расписания удаляются отдельным запросом', async () => {
    const { env, calls } = fakeDb([]);
    await archiveExpired(env, NOW);
    const prune = calls.find((c) => c.sql.startsWith('DELETE FROM listings') && c.sql.includes('recurring IS NOT NULL'));
    expect(prune).toBeDefined();
    expect(prune!.sql).toContain("datetime('now', '-45 days')");
  });
});
