/**
 * «Не считать меня»: визиты владельца сайта не попадают в цифры медиакита.
 *
 * Повод — разбор Search Console: 43 клика из 68 пришли из Беларуси, и часть
 * из них вполне могла быть собственными заходами владельца. Без пометки
 * отличить их невозможно, поэтому помеченный браузер исключается из всех
 * агрегатов, а страница честно пишет, сколько просмотров исключено.
 */
import { describe, expect, it } from 'vitest';

import type { Env } from '../src/types';
import {
  gatherVisitStats, OWN_COOKIE, renderAudiencePage, setOwnVisitor, trackPageView,
  type AudienceStats,
} from '../src/visit-stats';

interface Call { sql: string; params: unknown[] }

/** Заглушка D1+KV: запоминает SQL и параметры, строк не возвращает. */
function recEnv() {
  const calls: Call[] = [];
  const kv = new Map<string, string>();
  const make = (sql: string) => {
    const call: Call = { sql, params: [] };
    calls.push(call);
    const stmt = {
      bind(...params: unknown[]) { call.params = params; return stmt; },
      async run() { return { meta: { changes: 1 } }; },
      async all() { return { results: [] }; },
      // счётчик «своих» и сводка по ботам — разные запросы: подделка отвечает
      // каждому своё, иначе перепутанный порядок полей незаметен
      async first() {
        if (/v\.vid IN \(SELECT vid FROM stat_own\)/.test(sql)) return { n: 7 };
        if (/FROM stat_bot_chats/.test(sql)) return { total: 4, active: 2, groups: 3 };
        return null;
      },
    };
    return stmt;
  };
  const env = {
    DB: { prepare: make, batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => Promise.all(stmts.map((s) => s.run())) },
    KV: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => { kv.set(k, v); } },
    SITE_URL: 'https://pop-utka.app',
  } as unknown as Env;
  return { env, calls };
}

const HUMAN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';
const BOT = 'Googlebot/2.1 (+http://www.google.com/bot.html)';

describe('пометка «своих» визитов', () => {
  it('просмотр из помеченного браузера пишет vid в stat_own', async () => {
    const { env, calls } = recEnv();
    await trackPageView(env, {
      path: '/r/varshava-minsk', ip: '1.2.3.4', ua: HUMAN, country: 'BY',
      asOrg: null, referer: 'https://www.google.by/', own: true,
    });
    const own = calls.filter((c) => /INSERT OR IGNORE INTO stat_own/.test(c.sql));
    expect(own).toHaveLength(1);
    expect(String(own[0]!.params[0])).toMatch(/^[0-9a-f]{32}$/);
  });

  it('обычный посетитель не помечается', async () => {
    const { env, calls } = recEnv();
    await trackPageView(env, {
      path: '/', ip: '5.6.7.8', ua: HUMAN, country: 'PL', asOrg: null, referer: null,
    });
    expect(calls.filter((c) => /INSERT OR IGNORE INTO stat_own/.test(c.sql))).toHaveLength(0);
    // сам просмотр записан
    expect(calls.some((c) => /INSERT INTO stat_views/.test(c.sql))).toBe(true);
  });

  it('робот не помечается, даже если пришёл с кукой', async () => {
    const { env, calls } = recEnv();
    await trackPageView(env, {
      path: '/', ip: '9.9.9.9', ua: BOT, country: null, asOrg: null, referer: null, own: true,
    });
    expect(calls.filter((c) => /INSERT OR IGNORE INTO stat_own/.test(c.sql))).toHaveLength(0);
  });

  it('setOwnVisitor ставит пометку и снимает её', async () => {
    const { env, calls } = recEnv();
    const vid = await setOwnVisitor(env, { ip: '1.2.3.4', ua: HUMAN }, true);
    expect(vid).toMatch(/^[0-9a-f]{32}$/);
    expect(calls.some((c) => /INSERT OR IGNORE INTO stat_own/.test(c.sql))).toBe(true);

    calls.length = 0;
    await setOwnVisitor(env, { ip: '1.2.3.4', ua: HUMAN }, false);
    const del = calls.filter((c) => /DELETE FROM stat_own WHERE vid = \?/.test(c.sql));
    expect(del).toHaveLength(1);
    expect(del[0]!.params[0]).toBe(vid);
  });

  it('тот же человек в тот же день — тот же vid (пометка не слетает)', async () => {
    const { env } = recEnv();
    const a = await setOwnVisitor(env, { ip: '1.2.3.4', ua: HUMAN }, true);
    const b = await setOwnVisitor(env, { ip: '1.2.3.4', ua: HUMAN }, true);
    expect(a).toBe(b);
  });

  it('роботу пометку не ставим', async () => {
    const { env } = recEnv();
    expect(await setOwnVisitor(env, { ip: '9.9.9.9', ua: BOT }, true)).toBeNull();
  });

  it('имя куки закреплено: по нему middleware узнаёт владельца', () => {
    expect(OWN_COOKIE).toBe('poputka_own');
  });
});

describe('агрегаты медиакита без «своих»', () => {
  it('каждый живой агрегат отсекает помеченные vid', async () => {
    const { env, calls } = recEnv();
    await gatherVisitStats(env, 7);
    const live = calls.filter((c) => /JOIN stat_js/.test(c.sql));
    expect(live.length).toBeGreaterThanOrEqual(8);
    const missed = live.filter((c) => !/NOT IN \(SELECT vid FROM stat_own\)/.test(c.sql));
    expect(missed.map((c) => c.sql.slice(0, 70))).toEqual([]);
  });

  it('сколько просмотров исключено — отдельным счётчиком', async () => {
    const { env, calls } = recEnv();
    const stats = await gatherVisitStats(env, 7);
    expect(calls.some((c) => /v\.vid IN \(SELECT vid FROM stat_own\)/.test(c.sql))).toBe(true);
    expect(stats.ownViews).toBe(7);
  });

  it('счётчик «своих» не путается со сводкой по ботам (порядок полей)', async () => {
    const { env } = recEnv();
    const stats = await gatherVisitStats(env, 7);
    expect(stats.ownViews).toBe(7);
    expect(stats.bot).toEqual({ total: 4, active: 2, groups: 3, privates: 1 });
  });
});

describe('страница медиакита говорит о пометке', () => {
  const base: AudienceStats = {
    days: 7, generatedAt: '2026-10-19T12:00:00Z', coveredDays: 5, avgUniques: 4, views: 20,
    rawViews: 40, uniquesSum: 20, pagesPerVisitor: '1,0', botsFiltered: 20, daily: [],
    countries: [], dcViews: 0, ownViews: 0, devices: [], os: [], sources: [], referrers: [],
    pages: [], bot: { total: 2, active: 1, groups: 1, privates: 1 },
  };

  it('кнопка «Не считать мои визиты», когда браузер не помечен', () => {
    const html = renderAudiencePage({ audience: base, board: null });
    expect(html).toContain('Не считать мои визиты');
    expect(html).toContain('action="/mediakit/own-visits?days=7"');
    expect(html).not.toContain('Снова считать мои визиты');
  });

  it('помеченный браузер — кнопка обратная и примечание', () => {
    const html = renderAudiencePage({ audience: base, board: null, ownExcluded: true });
    expect(html).toContain('Снова считать мои визиты');
    expect(html).toContain('Этот браузер помечен');
  });

  it('сколько просмотров исключено — видно на странице', () => {
    const html = renderAudiencePage({ audience: { ...base, ownViews: 12 }, board: null });
    expect(html).toContain('помеченные визиты владельца');
    expect(html).toContain('12 просмотров за период');
    // склонение: 1 просмотр, 2 просмотра, 5 просмотров
    expect(renderAudiencePage({ audience: { ...base, ownViews: 1 }, board: null })).toContain('1 просмотр за период');
    expect(renderAudiencePage({ audience: { ...base, ownViews: 3 }, board: null })).toContain('3 просмотра за период');
  });

  it('ничего не помечено — лишнего текста нет', () => {
    const html = renderAudiencePage({ audience: base, board: null });
    expect(html).not.toContain('помеченные визиты владельца');
  });
});
