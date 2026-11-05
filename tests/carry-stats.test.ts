/**
 * «Что передают» (v0.4.61): категории по ключевым словам в описаниях.
 * Описания заполнены на 100% (цена — на 1%), поэтому что реально передают,
 * видно только из текста: документы, лекарства, еда, техника, ключи…
 * Отчёт живёт в админской «статистике» и кормит рекламные тексты и SEO.
 */
import { describe, expect, it } from 'vitest';

import type { Env } from '../src/types';
import { CARRY_CATEGORIES, carryCategoryBoard, carryListings, carryTopRoutes, listCarryStats } from '../src/store';

function envWith(row: Record<string, unknown> | null) {
  const calls: Array<{ sql: string }> = [];
  const stmt = {
    bind: () => stmt,
    async first() { return row; },
    async all() { return { results: [] }; },
    async run() { return { meta: { changes: 0 } }; },
  };
  const env = {
    DB: { prepare: (sql: string) => { calls.push({ sql }); return stmt; } },
  } as unknown as Env;
  return { env, calls };
}

describe('«что передают» — категории по словам в описаниях', () => {
  it('считает, режет пустые категории, сортирует по объёму', async () => {
    const row: Record<string, unknown> = { total: 100, oth: 40, oth_o: 30, oth_r: 10, oth_30: 12, upd: '2026-11-01 09:00:00' };
    CARRY_CATEGORIES.forEach((c, i) => {
      // документы (i=0) — 25, техника (i=3) — 60, остальные пусты
      row[`c${i}`] = i === 0 ? 25 : i === 3 ? 60 : 0;
      row[`c${i}_o`] = i === 0 ? 20 : i === 3 ? 50 : 0;
      row[`c${i}_r`] = i === 0 ? 5 : i === 3 ? 10 : 0;
      row[`c${i}_30`] = i === 0 ? 7 : i === 3 ? 15 : 0;
    });
    const { env } = envWith(row);
    const s = await listCarryStats(env);
    expect(s.total).toBe(100);
    expect(s.categories).toHaveLength(2); // пустые отфильтрованы
    expect(s.categories[0]!.label).toBe(CARRY_CATEGORIES[3]!.label); // сортировка по total
    expect(s.categories[0]).toMatchObject({ total: 60, offers: 50, requests: 10, last30: 15 });
    expect(s.categories[1]).toMatchObject({ total: 25, offers: 20, requests: 5, last30: 7 });
    expect(s.other).toMatchObject({ total: 40, offers: 30, requests: 10, last30: 12 });
    expect(s.updatedAt).toBe('2026-11-01 09:00:00');
  });

  it('SQL: нижнерегистровые описания, без отклонённых, окно 30 дней', async () => {
    const { env, calls } = envWith(null);
    const s = await listCarryStats(env);
    expect(s.total).toBe(0);
    expect(s.categories).toHaveLength(0);
    const sql = calls[0]!.sql;
    expect(sql).toContain('description_lc LIKE');
    expect(sql).toContain("status IN ('published','expired')"); // отклонённые — шум
    expect(sql).toContain("datetime('now', '-30 days', '+3 hours')");
    expect(sql).toContain('документ');
    expect(sql).toContain('лекарст');
    // «прочее» — ни одного совпадения
    expect(sql).toContain('NOT (');
  });

  it('ключевые слова не содержат известных ловушек', () => {
    const words = CARRY_CATEGORIES.flatMap((c) => c.words);
    for (const trap of ['договор', 'телефон', 'детал', 'шин', 'евро', 'доллар', 'карт', 'кот', 'ед']) {
      expect(words, `«${trap}» даёт ложные срабатывания`).not.toContain(trap);
    }
  });
});

describe('публичные цифры GEO-страниц (/peredat)', () => {
  function fakeDb(opts: { row?: Record<string, unknown> | null; results?: Array<Record<string, unknown>> }) {
    const calls: string[] = [];
    const stmt = {
      bind: () => stmt,
      async first() { return opts.row ?? null; },
      async all() { return { results: opts.results ?? [] }; },
      async run() { return { meta: { changes: 0 } }; },
    };
    const env = { DB: { prepare: (sql: string) => { calls.push(sql); return stmt; } } } as unknown as Env;
    return { env, calls };
  }

  it('listCarryStats boardOnly: только то, что реально на доске', async () => {
    const { env, calls } = fakeDb({ row: null });
    await listCarryStats(env, { boardOnly: true });
    expect(calls[0]).toContain("status = 'published'");
    expect(calls[0]).not.toContain("status IN ('published','expired')");
  });

  it('carryCategoryBoard: цифры живых заявок и свежесть темы', async () => {
    const { env, calls } = fakeDb({ row: { board: 25, offers: 20, requests: 5, last30: 7, upd: '2026-11-01 09:00:00' } });
    const s = await carryCategoryBoard(env, ['документ', 'паспорт']);
    expect(s).toEqual({ board: 25, offers: 20, requests: 5, last30: 7, updatedAt: '2026-11-01 09:00:00' });
    expect(calls[0]).toContain("status = 'published'");
    expect(calls[0]).toContain("description_lc LIKE '%документ%' OR description_lc LIKE '%паспорт%'");
  });

  it('carryTopRoutes: направления группируются, пустые города отброшены', async () => {
    const { env, calls } = fakeDb({ results: [
      { from_city: 'Минск', to_city: 'Варшава', total: 9 },
      { from_city: '', to_city: 'Брест', total: 2 },
    ] });
    const r = await carryTopRoutes(env, ['посылк'], 50);
    expect(r).toEqual([{ from: 'Минск', to: 'Варшава', total: 9 }]);
    expect(calls[0]).toContain('GROUP BY from_city, to_city');
    expect(calls[0]).toContain('LIMIT ?');
  });

  it('carryListings: публичная проекция — происхождение до сообщения срезано', async () => {
    const { env, calls } = fakeDb({ results: [{
      id: 'x-1', type: 'offer', from_city: 'Минск', to_city: 'Варшава',
      description: 'Везу документы', status: 'published', source: 'telegram',
      source_chat_username: '@secret_chat', source_message_id: 42, source_thread_id: 7,
      created_at: '2026-11-01 10:00:00',
    }] });
    const items = await carryListings(env, ['документ']);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('x-1');
    expect(items[0]!.sourceChatUsername).toBeNull();
    expect(items[0]!.sourceMessageId).toBeNull();
    expect(items[0]!.sourceThreadId).toBeNull();
    expect(calls[0]).toContain('ORDER BY datetime(COALESCE(published_at, created_at)) DESC');
  });
});
