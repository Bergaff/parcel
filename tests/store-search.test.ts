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
  ensureSearchColumns, getCounts, likeContains, listListings, resetSearchColumnsCache,
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

  it('без фильтра городов колонки не трогаем и PRAGMA не дёргаем', async () => {
    const { env, calls } = fakeDb();
    await listListings(env, {});
    expect(calls.some((c) => /PRAGMA/.test(c.sql))).toBe(false);
    expect(calls.some((c) => /ALTER TABLE/.test(c.sql))).toBe(false);
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
    const { env, calls } = fakeDb();
    await ensureSearchColumns(env);
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
