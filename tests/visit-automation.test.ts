/**
 * Отсечение псевдоживого трафика: headless-фермы на резидентных прокси
 * исполняют JS-маячок и попадают в «живую» аудиторию медиакита.
 *
 * Повод — неделя 10–16.11.2026: «живые» просмотры США выросли 22→374
 * (38,1% недели), Франция 7→80, при десктопном профиле (Windows 61%),
 * 82,6% прямых заходов и глубине 5,2 страницы на «посетителя» 13 ноября.
 * Fix: маячок передаёт сигналы браузера (?s=), сервер их оценивает
 * (scoreClientSignals) и помеченные посетители дня выпадают из живых
 * агрегатов, оставаясь видимыми отдельной строкой «Отсечено автоматов».
 */
import { describe, expect, it } from 'vitest';

import type { Env } from '../src/types';
import {
  AUTO_SCORE, confirmJsVisit, gatherVisitStats, renderAudiencePage, renderDailyCsv,
  scoreClientSignals, type AudienceStats,
} from '../src/visit-stats';
import { gatherMediaStats } from '../src/mediakit';

const WIN_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const BOT_UA = 'Googlebot/2.1 (+http://www.google.com/bot.html)';

/** Полезная нагрузка маячка честного десктопного браузера. */
function payload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    wd: 0, tz: 'Europe/Minsk', tzo: -180, w: 1920, h: 1080, dpr: 1,
    lang: 'ru-BY', langs: 2, cores: 8, touch: 0, plat: 'Win32',
    ...over,
  });
}

/* ---------------- оценка сигналов ---------------- */

describe('scoreClientSignals — честные браузеры не страдают', () => {
  it('обычный десктоп — 0 баллов', () => {
    expect(scoreClientSignals(payload(), WIN_UA, 'BY').score).toBe(0);
  });

  it('настоящий iPhone — 0 (в iOS-UA «like Mac OS X» — не несовпадение платформы)', () => {
    const s = scoreClientSignals(
      payload({ w: 390, h: 844, dpr: 3, lang: 'ru', langs: 1, cores: 6, touch: 5, plat: 'iPhone' }),
      IPHONE_UA, 'BY'
    );
    expect(s.score).toBe(0);
  });

  it('нет полезной нагрузки (старый app.js из кэша, мусор) — 0: живых не режем', () => {
    for (const v of ['', null, undefined, 'не json', '{"wd":1'.padEnd(3000, '0')]) {
      expect(scoreClientSignals(v, WIN_UA, 'US').score, String(v)).toBe(0);
    }
  });

  it('один слабый сигнал — ещё не отсечение (Brave/Firefox с защитой приватности)', () => {
    expect(scoreClientSignals(payload({ cores: 0 }), WIN_UA, 'BY').score).toBeLessThan(AUTO_SCORE);
    expect(scoreClientSignals(payload({ dpr: 1, touch: 0 }), WIN_UA, 'BY').score).toBe(0);
  });

  it('UTC+0 у посетителя из Великобритании — норма, из США — подозрительно', () => {
    const gb = scoreClientSignals(payload({ tzo: 0, tz: 'Europe/London' }), WIN_UA, 'GB');
    expect(gb.score).toBe(0);
    const us = scoreClientSignals(payload({ tzo: 0, tz: '' }), WIN_UA, 'US');
    expect(us.flags).toContain('tz');
    expect(us.score).toBe(2);
  });
});

describe('scoreClientSignals — автоматы набирают порог', () => {
  it('navigator.webdriver — сразу отсечение', () => {
    const s = scoreClientSignals(payload({ wd: 1 }), WIN_UA, 'US');
    expect(s.score).toBeGreaterThanOrEqual(AUTO_SCORE);
    expect(s.flags).toContain('webdriver');
  });

  it('headless без экрана и плотности пикселей — отсечение', () => {
    const s = scoreClientSignals(payload({ w: 0, h: 0, dpr: 0 }), WIN_UA, 'US');
    expect(s.score).toBeGreaterThanOrEqual(AUTO_SCORE);
    expect(s.flags).toEqual(expect.arrayContaining(['screen', 'dpr']));
  });

  it('«телефон» без касаний и с пустым языком — подделка', () => {
    const s = scoreClientSignals(payload({ touch: 0, lang: '', w: 360, h: 640, dpr: 2 }), IPHONE_UA, 'US');
    expect(s.score).toBeGreaterThanOrEqual(AUTO_SCORE);
    expect(s.flags).toEqual(expect.arrayContaining(['lang', 'touch']));
  });

  it('Windows-UA поверх Linux-платформы + пустые языки — подделка', () => {
    const s = scoreClientSignals(payload({ plat: 'Linux x86_64', lang: '', langs: 0 }), WIN_UA, 'FR');
    expect(s.flags).toEqual(expect.arrayContaining(['lang', 'langs', 'plat']));
    expect(s.score).toBeGreaterThanOrEqual(AUTO_SCORE);
  });

  it('типичная ферма из разбора 10–16.11: webdriver + UTC из США', () => {
    const s = scoreClientSignals(payload({ wd: true, tzo: 0, tz: '' }), WIN_UA, 'US');
    expect(s.score).toBeGreaterThanOrEqual(AUTO_SCORE);
  });
});

/* ---------------- запись маячка ---------------- */

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
      async all() {
        if (/PRAGMA table_info/.test(sql)) return { results: [{ name: 'recurring' }] };
        return { results: [] };
      },
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

describe('confirmJsVisit — метка автомата', () => {
  it('таблица stat_js_flags создаётся вместе с остальными', async () => {
    const { env, calls } = recEnv();
    await confirmJsVisit(env, { ip: '1.2.3.4', ua: WIN_UA, signals: payload(), country: 'BY' });
    expect(calls.some((c) => /CREATE TABLE IF NOT EXISTS stat_js_flags/.test(c.sql))).toBe(true);
  });

  it('честный браузер — только stat_js, без метки', async () => {
    const { env, calls } = recEnv();
    await confirmJsVisit(env, { ip: '1.2.3.4', ua: WIN_UA, signals: payload(), country: 'BY' });
    expect(calls.some((c) => /INSERT OR IGNORE INTO stat_js /.test(c.sql))).toBe(true);
    expect(calls.some((c) => /INSERT INTO stat_js_flags/.test(c.sql))).toBe(false);
  });

  it('автомат — stat_js и метка с баллами и флагами', async () => {
    const { env, calls } = recEnv();
    await confirmJsVisit(env, { ip: '5.6.7.8', ua: WIN_UA, signals: payload({ wd: 1 }), country: 'US' });
    const flag = calls.find((c) => /INSERT INTO stat_js_flags/.test(c.sql));
    expect(flag).toBeTruthy();
    // day, vid, score, flags, updated_at
    expect(Number(flag!.params[2])).toBeGreaterThanOrEqual(AUTO_SCORE);
    expect(String(flag!.params[3])).toContain('webdriver');
  });

  it('маячок без сигналов (старый кэш) — живым остаётся, метки нет', async () => {
    const { env, calls } = recEnv();
    await confirmJsVisit(env, { ip: '9.9.9.9', ua: WIN_UA, country: 'US' });
    expect(calls.some((c) => /INSERT OR IGNORE INTO stat_js /.test(c.sql))).toBe(true);
    expect(calls.some((c) => /INSERT INTO stat_js_flags/.test(c.sql))).toBe(false);
  });

  it('роботу по User-Agent маячок не пишется вовсе', async () => {
    const { env, calls } = recEnv();
    await confirmJsVisit(env, { ip: '9.9.9.9', ua: BOT_UA, signals: payload({ wd: 1 }), country: 'US' });
    expect(calls.filter((c) => /stat_js/.test(c.sql))).toHaveLength(0);
  });
});

/* ---------------- агрегаты ---------------- */

describe('живые агрегаты режут автоматов', () => {
  it('каждый живой запрос содержит NOT EXISTS по stat_js_flags', async () => {
    const { env, calls } = recEnv();
    await gatherVisitStats(env, 7);
    const live = calls.filter((c) => /JOIN stat_js j/.test(c.sql));
    expect(live.length).toBeGreaterThanOrEqual(8);
    for (const c of live) {
      expect(c.sql, c.sql.slice(0, 70)).toContain('NOT EXISTS');
      expect(c.sql).toContain('stat_js_flags');
    }
  });

  it('срез автоматов — отдельный запрос по дням, с исключением «своих»', async () => {
    const { env, calls } = recEnv();
    await gatherVisitStats(env, 7);
    const auto = calls.find((c) => /JOIN stat_js_flags f/.test(c.sql) && /COUNT\(DISTINCT v\.vid\) AS visitors/.test(c.sql));
    expect(auto).toBeTruthy();
    expect(auto!.sql).toContain('NOT IN (SELECT vid FROM stat_own)');
    expect(auto!.sql).toContain('GROUP BY v.day');
  });

  it('пустая база — нули в autoViews/autoVisitors и в днях', async () => {
    const { env } = recEnv();
    const stats = await gatherVisitStats(env, 7);
    expect(stats.autoViews).toBe(0);
    expect(stats.autoVisitors).toBe(0);
    expect(stats.daily.every((d) => d.auto === 0)).toBe(true);
  });

  it('«просмотров карточек людьми» в медиаките — SQL режет автоматов', async () => {
    const { env, calls } = recEnv();
    await gatherMediaStats(env).catch(() => undefined);
    const q = calls.find((c) => /FROM stat_item_views/.test(c.sql));
    expect(q).toBeTruthy();
    expect(q!.sql).toContain('stat_js_flags');
    expect(q!.sql).toMatch(/iv\.bot = 0 AND iv\.own = 0/);
  });
});

/* ---------------- страница и CSV ---------------- */

const audience: AudienceStats = {
  days: 7, generatedAt: '2026-11-16T06:08:00Z', coveredDays: 7, avgUniques: 65, views: 982,
  rawViews: 24334, uniquesSum: 456, pagesPerVisitor: '2,2', botsFiltered: 19913,
  autoViews: 681, autoVisitors: 41,
  daily: [
    { day: '2026-11-13', uniques: 77, views: 404, bots: 2575, auto: 260 },
    { day: '2026-11-14', uniques: 59, views: 147, bots: 2874, auto: 421 },
  ],
  countries: [{ country: 'US', views: 374, share: 38.1 }],
  dcViews: 32, ownViews: 5,
  devices: [{ name: 'Компьютер', views: 669, share: 68.1 }],
  os: [{ name: 'Windows', views: 598, share: 60.9 }],
  sources: [{ name: 'Напрямую', views: 811, share: 82.6 }],
  referrers: [{ host: 'yandex.by', views: 26, share: 2.6 }],
  pages: [{ name: 'Карточки', views: 386, share: 39.3 }],
  bot: { total: 59, active: 14, groups: 7, privates: 52 },
};

describe('страница медиакита показывает срез честно', () => {
  it('примечание про автоматы — с числами, когда срез был', () => {
    const html = renderAudiencePage({ audience, board: null });
    expect(html).toContain('Отсечено как браузерные автоматы');
    expect(html).toContain('681 просмотр');
    expect(html).toContain('41 псевдопосетителя');
    expect(html).toContain('в живые цифры они не входят');
  });

  it('колонок и чисел нет, когда автоматов не резали', () => {
    const html = renderAudiencePage({ audience: { ...audience, autoViews: 0, autoVisitors: 0 }, board: null });
    expect(html).not.toContain('Отсечено как браузерные автоматы');
    // столбец дневной таблицы остаётся — методика прозрачная
    expect(html).toContain('Отсечено автоматов');
  });

  it('дневная таблица — столбец «Отсечено автоматов» и числа по дням', () => {
    const html = renderAudiencePage({ audience, board: null });
    expect(html).toContain('<th>Отсечено автоматов</th>');
    expect(html).toContain('<td class="mono">2026-11-13</td><td>77</td><td>404</td><td>260</td><td>2575</td>');
  });

  it('методика объясняет проверку сигналами', () => {
    const html = renderAudiencePage({ audience, board: null });
    expect(html).toContain('navigator.webdriver');
    expect(html).toContain('Проверка сигналами');
    expect(html).toContain('фермы на резидентных прокси');
  });

  it('CSV — колонка auto_cut', () => {
    const csv = renderDailyCsv(audience.daily);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('day;visitors_live;views_live;auto_cut;bots_filtered');
    expect(csv).toContain('2026-11-13;77;404;260;2575');
  });
});
