/**
 * «Что передают» (v0.4.61): категории по ключевым словам в описаниях.
 * Описания заполнены на 100% (цена — на 1%), поэтому что реально передают,
 * видно только из текста: документы, лекарства, еда, техника, ключи…
 * Отчёт живёт в админской «статистике» и кормит рекламные тексты и SEO.
 */
import { describe, expect, it } from 'vitest';

import type { Env } from '../src/types';
import { CARRY_CATEGORIES, listCarryStats } from '../src/store';

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
    const row: Record<string, unknown> = { total: 100, oth: 40, oth_o: 30, oth_r: 10, oth_30: 12 };
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
