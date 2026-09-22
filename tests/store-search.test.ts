/**
 * Поиск по городам и тексту: регистр не важен, а SQL не должен падать
 * на длинных названиях.
 *
 * Раньше города сравнивались GLOB-шаблоном «*[Аа][Мм][Сс]…» — по классу на
 * букву. SQLite такие шаблоны отвергает («LIKE or GLOB pattern too complex»),
 * и доска отдавала 500 на Амстердаме, Санкт-Петербурге и на поиске «лекарства».
 * Теперь регистр свёрнут в колонках *_lc, а в запросе обычный LIKE.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../src/types';
import {
  ensureSearchColumns, getCounts, isAdminOrigin, likeContains, listListings, pruneStalePending, resetSearchColumnsCache,
  searchByCity, sqlLowerCyr,
} from '../src/store';

interface Call { sql: string; params: unknown[] }

/** Подделка D1: запоминает SQL и параметры, строк не возвращает. */
function fakeDb(opts: { columns?: string[] } = {}) {
  const columns = opts.columns ?? ['id', 'type', 'from_city', 'to_city', 'description', 'status'];
  const calls: Call[] = [];
  const make = (sql: string) => {
    // SQL запоминаем сразу: ALTER/CREATE/UPDATE в ensureSearchColumns идут без bind()
    const call: Call = { sql, params: [] };
    calls.push(call);
    const stmt = {
      bind(...params: unknown[]) {
        call.params = params;
        return stmt;
      },
      async all() {
        if (/PRAGMA table_info/.test(sql)) return { results: columns.map((name) => ({ name })) };
        return { results: [] };
      },
      async run() { return { meta: { changes: 1 } }; },
      async first() { return null; },
    };
    return stmt;
  };
  const db = { prepare: make, batch: async (stmts: unknown[]) => Promise.all(stmts as never) };
  return { env: { DB: db } as unknown as Env, calls };
}

beforeEach(() => {
  resetSearchColumnsCache();
});

describe('шаблон поиска', () => {
  it('регистр сворачивается, подстрока обрамляется процентами', () => {
    expect(likeContains('Варшава')).toBe('%варшава%');
    expect(likeContains('МИНСК')).toBe('%минск%');
    expect(likeContains('  Амстердам ')).toBe('%  амстердам %');
  });

  it('спецсимволы LIKE экранируются — «100%» не превращается в «всё подряд»', () => {
    expect(likeContains('100%')).toBe('%100\\%%');
    expect(likeContains('a_b')).toBe('%a\\_b%');
    expect(likeContains('c\\d')).toBe('%c\\\\d%');
  });

  it('SQL-выражение lower() для кириллицы строится цепочкой REPLACE', () => {
    const expr = sqlLowerCyr('from_city');
    expect(expr).toContain("REPLACE(from_city, 'А', 'а')");
    expect(expr).toContain("'Ё', 'ё'");
    expect(expr).toContain("'Ґ', 'ґ'");
    expect(expr.startsWith('REPLACE(')).toBe(true);
  });
});

describe('запросы к базе', () => {
  it('фильтр по городу — LIKE по *_lc, никакого GLOB', async () => {
    const { env, calls } = fakeDb();
    await listListings(env, { from: 'Амстердам' });
    const query = calls.find((c) => /^SELECT \* FROM listings/.test(c.sql))!;
    expect(query.sql).toContain('from_city_lc LIKE ?');
    expect(query.sql).not.toContain('GLOB');
    expect(query.params).toContain('%амстердам%');
  });

  it('оба города и поиск по тексту', async () => {
    const { env, calls } = fakeDb();
    await listListings(env, { from: 'Варшава', to: 'Минск', q: 'лекарства' });
    const query = calls.find((c) => /^SELECT \* FROM listings/.test(c.sql))!;
    expect(query.sql).toContain('to_city_lc LIKE ?');
    expect(query.sql).toContain('description_lc LIKE ?');
    expect(query.params).toContain('%лекарства%');
  });

  it('счётчики типов используют тот же фильтр', async () => {
    const { env, calls } = fakeDb();
    await getCounts(env, { from: 'Санкт-Петербург' });
    const query = calls.find((c) => /COUNT\(\*\)/.test(c.sql))!;
    expect(query.sql).toContain('from_city_lc LIKE ?');
    expect(query.params).toContain('%санкт-петербург%');
  });

  it('поиск по городу (бот) — LIKE по обеим колонкам', async () => {
    const { env, calls } = fakeDb();
    await searchByCity(env, 'Ивано-Франковск');
    const query = calls.find((c) => /status IN \('published', 'expired'\)/.test(c.sql))!;
    expect(query.sql).toContain('from_city_lc LIKE ?');
    expect(query.sql).toContain('to_city_lc LIKE ?');
    expect(query.params.slice(0, 2)).toEqual(['%ивано-франковск%', '%ивано-франковск%']);
  });

  it('без фильтра городов *_lc не трогаем, recurring проверяем одним PRAGMA', async () => {
    const { env, calls } = fakeDb({
      columns: ['id', 'type', 'from_city', 'to_city', 'description', 'status', 'recurring'],
    });
    await listListings(env, {});
    expect(calls.some((c) => c.sql.includes('ALTER TABLE'))).toBe(false);
    expect(calls.some((c) => /ADD COLUMN \w+_lc/.test(c.sql))).toBe(false);
    expect(calls.filter((c) => /PRAGMA/.test(c.sql)).length).toBe(1);
  });
});

describe('колонки *_lc', () => {
  it('их нет — добавляем, индексируем и заполняем старые строки', async () => {
    const { env, calls } = fakeDb();
    await ensureSearchColumns(env);
    const sqls = calls.map((c) => c.sql);
    expect(sqls.some((s) => s.includes('ALTER TABLE listings ADD COLUMN from_city_lc'))).toBe(true);
    expect(sqls.some((s) => s.includes('ALTER TABLE listings ADD COLUMN to_city_lc'))).toBe(true);
    expect(sqls.some((s) => s.includes('ALTER TABLE listings ADD COLUMN description_lc'))).toBe(true);
    expect(sqls.some((s) => s.includes('CREATE INDEX IF NOT EXISTS idx_listings_from_lc'))).toBe(true);
    const fill = sqls.find((s) => /^UPDATE listings SET/.test(s))!;
    expect(fill).toContain('REPLACE(');
    expect(fill).toContain('WHERE from_city_lc IS NULL');
  });

  it('колонки уже есть — ALTER не повторяем', async () => {
    const { env, calls } = fakeDb({
      columns: ['id', 'from_city', 'to_city', 'description', 'from_city_lc', 'to_city_lc', 'description_lc'],
    });
    await ensureSearchColumns(env);
    expect(calls.some((c) => c.sql.includes('ALTER TABLE'))).toBe(false);
  });

  it('повторный вызов в том же isolate не дёргает базу', async () => {
    const { env, calls } = fakeDb({
      columns: [
        'id', 'type', 'from_city', 'to_city', 'description', 'status', 'recurring',
        'from_city_lc', 'to_city_lc', 'description_lc',
      ],
    });
    await ensureSearchColumns(env);
    await listListings(env, {}); // закрепляет recurring и *_lc
    const first = calls.length;
    await ensureSearchColumns(env);
    await listListings(env, { from: 'Минск' });
    expect(calls.length).toBe(first + 1); // только сам SELECT
  });

  it('сбой базы не оставляет «готовность» навсегда', async () => {
    const { env, calls } = fakeDb();
    const broken = {
      DB: { prepare: () => { throw new Error('D1 down'); } },
    } as unknown as Env;
    await expect(ensureSearchColumns(broken)).rejects.toThrow('D1 down');
    await ensureSearchColumns(env);
    expect(calls.some((c) => /PRAGMA/.test(c.sql))).toBe(true);
  });
});

describe('свежая база: чтение доски гарантирует recurring само', () => {
  // Раньше колонку recurring создавали только пути записи (createListing),
  // а чтение доски ссылается на неё в buildWhere — свежая база без единого
  // объявления отдавала 500 на главной, пока бот что-нибудь не создаст.
  it('listListings без фильтров добавляет recurring до SELECT', async () => {
    const { env, calls } = fakeDb(); // колонок recurring и *_lc нет
    await listListings(env, {});
    const alter = calls.findIndex((c) => c.sql.includes('ADD COLUMN recurring'));
    const select = calls.findIndex((c) => /^SELECT \* FROM listings/.test(c.sql));
    expect(alter).toBeGreaterThanOrEqual(0);
    expect(select).toBeGreaterThan(alter);
  });

  it('бэкфилл recurring идёт после *_lc — он читает description_lc', async () => {
    const { env, calls } = fakeDb();
    await listListings(env, {});
    const lc = calls.findIndex((c) => c.sql.includes('ADD COLUMN description_lc'));
    const backfill = calls.findIndex((c) => /UPDATE listings SET\s+recurring = CASE/.test(c.sql));
    expect(lc).toBeGreaterThanOrEqual(0);
    expect(backfill).toBeGreaterThan(lc);
  });

  it('getCounts (счётчик в шапке) тоже гарантирует recurring', async () => {
    const { env, calls } = fakeDb();
    await getCounts(env, {});
    expect(calls.some((c) => c.sql.includes('ADD COLUMN recurring'))).toBe(true);
  });

  it('searchByCity (поиск бота) тоже гарантирует recurring', async () => {
    const { env, calls } = fakeDb();
    await searchByCity(env, 'Минск');
    expect(calls.some((c) => c.sql.includes('ADD COLUMN recurring'))).toBe(true);
  });
});

describe('происхождение заявки: админ или посторонний человек', () => {
  const mk = (over: Record<string, unknown>) =>
    ({ source: 'site', sourceChatId: null, byAdmin: false, ...over }) as Parameters<typeof isAdminOrigin>[1];
  const env = { ADMIN_IDS: '42, 43' } as unknown as Env;

  it('колонка by_admin говорит «админ»', () => {
    expect(isAdminOrigin(env, mk({ byAdmin: true }))).toBe(true);
    expect(isAdminOrigin(env, mk({}))).toBe(false);
  });

  it('старые строки: личное сообщение боту от админского ID — тоже админ', () => {
    expect(isAdminOrigin(env, mk({ source: 'telegram', sourceChatId: '42' }))).toBe(true);
    expect(isAdminOrigin(env, mk({ source: 'telegram', sourceChatId: '999' }))).toBe(false);
    // заявка с сайта админским ID не помечается — ключ админки шёл бы в by_admin
    expect(isAdminOrigin(env, mk({ source: 'site', sourceChatId: '42' }))).toBe(false);
  });
});

describe('очередь модерации: просроченные заявки', () => {
  it('pending с прошедшей датой выезда удаляется, регулярные — нет', async () => {
    const { env, calls } = fakeDb();
    const n = await pruneStalePending(env);
    expect(n).toBe(1); // fakeDb: run() всегда рапортует об одном изменении
    const del = calls.find((c) => /^DELETE FROM listings/.test(c.sql))!;
    expect(del.sql).toContain("status = 'pending'");
    expect(del.sql).toContain('recurring IS NULL');
    expect(del.sql).toContain("departure_date < date('now', '+3 hours')");
    // DELETE ссылается на recurring — колонку запрос гарантирует сам (PRAGMA раньше)
    expect(calls.findIndex((c) => /PRAGMA/.test(c.sql))).toBeLessThan(calls.indexOf(del));
  });
});
