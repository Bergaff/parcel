/**
 * Регулярные рейсы в archiveExpired: cron катит дату выезда на ближайший
 * заезд, а не роняет живую заявку в архив. Проверяем SQL-поток на фальшивом D1:
 * какие строки он выбрал и какие UPDATE в итоге выполнил.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../src/types';
import { archiveExpired, listListings, pruneRejected, resetSearchColumnsCache, touchListing } from '../src/store';

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
function fakeDb(
  selectRows: Record<string, unknown>[],
  opts: { hiddenChanges?: number; datelessChanges?: number } = {},
) {
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
      async run() {
        // скрытые заявки — отдельная статистика, чтобы старые тесты не путались
        if (/hidden = 1/.test(sql)) return { meta: { changes: opts.hiddenChanges ?? 0 } };
        // то же для видимых без даты: иначе подделка отвечала бы «1» на любой
        // UPDATE, и старые ожидания чисел поехали бы просто из-за нового запроса
        if (/COALESCE\(hidden, 0\) = 0/.test(sql)) return { meta: { changes: opts.datelessChanges ?? 0 } };
        return { meta: { changes: 1 } };
      },
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

describe('archiveExpired — скрытые заявки без контакта', () => {
  const NOW = new Date('2026-09-22T12:00:00Z');

  it('без даты выезда: 30 дней живёт, потом архив, ещё 30 — удаление', async () => {
    const { env, calls } = fakeDb([], { hiddenChanges: 2 });
    const res = await archiveExpired(env, NOW);
    const expire = calls.find((c) => /UPDATE listings SET status = 'expired'\s+WHERE hidden = 1/.test(c.sql));
    expect(expire, 'скрытые без даты уходят в архив по возрасту').toBeTruthy();
    expect(expire!.sql).toContain("departure_date IS NULL");
    expect(expire!.sql).toContain("-30 days");
    const del = calls.find((c) => /DELETE FROM listings\s+WHERE hidden = 1/.test(c.sql));
    expect(del, 'архив скрытых удаляется').toBeTruthy();
    expect(del!.sql).toContain("-60 days");
    // статистика схлопывает обе категории (обычный архив дал бы 1 + скрытые 2)
    expect(res.archived).toBe(3);
    expect(res.deleted).toBe(3);
  });

  it('видимые без даты: 21 день на доске → архив, 51 → удаление, и это видно в счёте', async () => {
    const { env, calls } = fakeDb([], { datelessChanges: 7 });
    const res = await archiveExpired(env, NOW);
    const expire = calls.find((c) => /UPDATE listings SET status = 'expired'\s+WHERE COALESCE\(hidden, 0\) = 0/.test(c.sql));
    expect(expire, 'видимые заявки без даты должны стареть').toBeTruthy();
    expect(expire!.sql).toContain('departure_date IS NULL');
    expect(expire!.sql).toContain('recurring IS NULL'); // регулярные — пункт 1 и 4
    expect(expire!.sql).toContain("-21 days");
    expect(expire!.sql).toContain('COALESCE(published_at, created_at)'); // возраст считаем от публикации
    const del = calls.find((c) => /DELETE FROM listings\s+WHERE COALESCE\(hidden, 0\) = 0/.test(c.sql));
    expect(del, 'архив без даты удаляется').toBeTruthy();
    expect(del!.sql).toContain("-51 days");
    // счёт честный: обычные (1+1) + скрытые (0) + бездатные (7+7)
    expect(res.dateless).toBe(14);
    expect(res.archived).toBe(1 + 7);
    expect(res.deleted).toBe(1 + 7);
  });

  it('без датчика изменений новый шаг ничего не приписывает', async () => {
    const { env } = fakeDb([]);
    const res = await archiveExpired(env, NOW);
    expect(res.dateless).toBe(0);
  });

  it('колонку hidden воркер гарантирует сам (PRAGMA до UPDATE)', async () => {
    const { env, calls } = fakeDb([]);
    await archiveExpired(env, NOW);
    const pragma = calls.findIndex((c) => /PRAGMA table_info/.test(c.sql));
    const firstHidden = calls.findIndex((c) => /hidden = 1/.test(c.sql));
    expect(pragma).toBeGreaterThanOrEqual(0);
    expect(firstHidden).toBeGreaterThan(pragma);
  });
});

/* Метки времени в базе лежат в двух форматах: toISOString() при создании
   ('2026-10-01T11:55:00.000Z') и datetime('now') при освежении заявки
   ('2026-10-01 11:55:00'). SQLite сравнивает их как СТРОКИ, а 'T' (0x54)
   больше пробела (0x20), поэтому ISO-метка на границе срока выглядит
   «моложе», чем есть. Замер на настоящей D1:
   SELECT '2026-10-02T01:00:00.000Z' < datetime('now','-21 days')  → 0
   SELECT '2026-10-02 01:00:00'     < datetime('now','-21 days')  → 1
   при границе '2026-10-02 06:22:15'. На доске 23.10.2026 так висели две
   заявки возрастом 22 дня вместо того, чтобы уйти в архив на 21-й.
   Поэтому и сравнения, и сортировки — через datetime(). */
describe('формат метки времени не влияет ни на возраст, ни на порядок', () => {
  const NOW = new Date('2026-10-23T00:00:00Z');

  it('все пороги возраста сравниваются через datetime()', async () => {
    const { env, calls } = fakeDb([]);
    await archiveExpired(env, NOW);
    const bare = calls.map((c) => c.sql)
      .filter((sql) => /(?:COALESCE\(published_at, created_at\)|created_at)\s*[<>]\s*datetime\(/.test(sql));
    expect(bare).toEqual([]);
    // чтобы тест не проверял пустоту: порогов в archiveExpired шесть
    const wrapped = calls.map((c) => c.sql)
      .filter((sql) => /datetime\((?:COALESCE\(published_at, created_at\)|created_at)\)\s*[<>]/.test(sql));
    expect(wrapped.length).toBeGreaterThanOrEqual(6);
  });

  it('чистка отклонённых старше 90 дней — тоже через datetime()', async () => {
    const { env, calls } = fakeDb([]);
    await pruneRejected(env);
    const del = calls.find((c) => c.sql.startsWith('DELETE FROM listings'));
    expect(del!.sql).toContain("datetime(COALESCE(published_at, created_at)) < datetime('now', '-90 days')");
  });

  it('доска сортируется по нормализованной метке', async () => {
    // иначе освежённая заявка (формат datetime('now')) оказывалась ниже
    // всех созданных в тот же день (формат toISOString) — «освежить» не работало
    const { env, calls } = fakeDb([]);
    await listListings(env, {});
    const q = calls.find((c) => c.sql.startsWith('SELECT * FROM listings'));
    expect(q!.sql).toContain('datetime(COALESCE(published_at, created_at)) DESC');
  });

  it('освежение пишет метку в том же формате, что и создание', async () => {
    const calls: Call[] = [];
    const row = {
      id: 'aaaa1111-2222-3333-4444-555555555555', type: 'offer',
      from_city: 'Минск', to_city: 'Варшава', description: 'Еду, возьму посылку',
      status: 'published', source: 'site', views: 0,
      created_at: '2026-10-01T10:00:00.000Z', published_at: '2026-10-01T10:05:00.000Z',
    };
    const make = (sql: string) => {
      const call: Call = { sql, params: [] };
      calls.push(call);
      const stmt = {
        bind(...params: unknown[]) { call.params = params; return stmt; },
        async all() { return { results: [] }; },
        async run() { return { meta: { changes: 1 } }; },
        async first() { return row; },
      };
      return stmt;
    };
    const env = { DB: { prepare: make } } as unknown as Env;
    await touchListing(env, row.id);
    const upd = calls.find((c) => c.sql.startsWith('UPDATE listings SET published_at'));
    expect(upd, 'освежение должно обновлять published_at').toBeTruthy();
    expect(upd!.sql).toContain('published_at = ?');
    expect(String(upd!.params[0])).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});
