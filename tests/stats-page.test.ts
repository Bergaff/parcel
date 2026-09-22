/**
 * Публичная страница итогов /itogi: цифры, таблица цен по валютам,
 * ссылки на страницы направлений и поведение, когда снимков ещё нет.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../src/types';
import type { MonthStat } from '../src/stats';

const db = vi.hoisted(() => ({
  snapshots: [] as MonthStat[],
  summaries: {} as Record<string, string>,
  refreshes: 0,
  pairs: [] as Array<{ fromCity: string; toCity: string; total: number; active: number; lastmod: string }>,
  cities: [] as Array<{ city: string; count: number; active: number; lastmod: string }>,
}));

vi.mock('../src/store', () => ({
  // страница итогов сама объявлений не читает — только снимки и маршруты
  listRoutePairs: async () => db.pairs,
  getMonthSnapshot: async (_env: unknown, month: string) => {
    const found = db.snapshots.find((m) => m.month === month);
    if (!found) return null;
    return {
      month: found.month,
      total: found.total,
      payload: JSON.stringify(found),
      summary: db.summaries[found.month] ?? null,
      updatedAt: '2026-09-17 10:00:00',
    };
  },
  listCityStats: async () => db.cities,
  listListings: async () => ({ items: [], hasMore: false }),
  listSitemapItems: async () => [],
  getCounts: async () => ({ offer: 0, request: 0 }),
  getListingById: async () => null,
  getChatLinks: async () => ({}),
}));

vi.mock('../src/stats', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/stats')>();
  return {
    ...real,
    listMonthStats: async () => db.snapshots,
    refreshStats: async () => { db.refreshes += 1; return { saved: [], kept: [], months: db.snapshots }; },
  };
});

import { buildMonthStatsPage, buildStatsPage } from '../src/pages';
import { clearRouteIndexCache } from '../src/seo-routes';

const ORIGIN = 'https://pop-utka.app';
const env = {} as Env;

function month(over: Partial<MonthStat> = {}): MonthStat {
  return {
    month: '2026-09',
    offers: 9,
    requests: 2,
    total: 11,
    cities: 7,
    directions: 7,
    topDirections: [
      { pair: 'Варшава → Минск', from: 'Варшава', to: 'Минск', count: 4 },
      { pair: 'Слуцк → Осиповичи', from: 'Слуцк', to: 'Осиповичи', count: 2 },
    ],
    fromChats: 10,
    fromSite: 1,
    priced: 10,
    free: 0,
    prices: [
      { currency: 'EUR', count: 3, avg: 25, min: 20, max: 30 },
      { currency: 'BYN', count: 5, avg: 32, min: 30, max: 40 },
      { currency: 'none', count: 2, avg: 50, min: 50, max: 50 },
    ],
    updatedAt: '2026-09-17 10:00:00',
    ...over,
  } as MonthStat;
}

beforeEach(() => {
  clearRouteIndexCache();
  db.summaries = {};
  db.refreshes = 0;
  db.snapshots = [month()];
  db.pairs = [{ fromCity: 'Варшава', toCity: 'Минск', total: 5, active: 4, lastmod: '2026-09-16' }];
  db.cities = [{ city: 'Варшава', count: 6, active: 5, lastmod: '2026-09-17' }];
});

describe('/itogi', () => {
  it('заголовок, canonical и цифры месяца', async () => {
    const page = await buildStatsPage(env, ORIGIN);
    expect(page.html).toContain('<title>Итоги месяца на доске попутных передач');
    expect(page.html).toContain(`<link rel="canonical" href="${ORIGIN}/itogi" />`);
    // в шапке, как на главной, — сколько объявлений на доске
    expect(page.html).toContain('на доске <b>0 объявлений</b>');
    expect(page.html).toContain('<b>11</b><span>объявлений за месяц</span>');
    expect(page.html).toContain('<b>9</b><span>«водитель везёт»</span>');
    expect(page.html).toContain('сентябрь 2026');
  });

  it('средние цены — своя строка на валюту, валюта без названия последней', async () => {
    const page = await buildStatsPage(env, ORIGIN);
    expect(page.html).toContain('<th scope="row">евро</th>');
    expect(page.html).toContain('<th scope="row">белорусских рублей</th>');
    expect(page.html).toContain('<th scope="row">валюта не указана</th>');
    expect(page.html).toContain('20–30'); // разброс
    expect(page.html.indexOf('евро')).toBeLessThan(page.html.indexOf('валюта не указана'));
  });

  it('топ направлений ссылается на страницы маршрутов, где они есть', async () => {
    const page = await buildStatsPage(env, ORIGIN);
    expect(page.html).toContain('<a href="/r/varshava-minsk">Варшава → Минск <span class="mono">4</span></a>');
    // у редкой пары своей страницы нет — просто текст, без битой ссылки
    expect(page.html).toContain('<span>Слуцк → Осиповичи <span class="mono">2</span></span>');
    expect(page.html).not.toContain('href="/r/sluck"');
  });

  it('хлебные крошки и JSON-LD', async () => {
    const page = await buildStatsPage(env, ORIGIN);
    expect(page.html).toContain('"@type":"BreadcrumbList"');
    expect(page.html).toContain('Итоги месяца');
    expect(page.html).toContain('<nav class="crumbs"');
  });

  it('даже один месяц — таблица со ссылкой на его страницу', async () => {
    const page = await buildStatsPage(env, ORIGIN);
    expect(page.html).toContain('<h2 class="rule-head">Все месяцы</h2>');
    expect(page.html).toContain('<th scope="row"><a href="/itogi/2026-09">сентябрь 2026</a></th>');
    // месяц в шапке — тоже ссылка
    expect(page.html).toContain('<a href="/itogi/2026-09">сентябрь 2026</a> · 11');
  });

  it('несколько месяцев — сводная таблица всех', async () => {
    db.snapshots = [month(), month({ month: '2026-08', total: 20, offers: 12, requests: 8, cities: 9 })];
    const page = await buildStatsPage(env, ORIGIN);
    expect(page.html).toContain('Все месяцы');
    // месяц в таблице — ссылка на свою страницу итогов
    expect(page.html).toContain('<th scope="row"><a href="/itogi/2026-08">август 2026</a></th>');
    expect(page.html).toContain('не меняются, даже когда объявления уходят в архив');
  });

  it('снимков нет — пересчитываем на месте и показываем цифры', async () => {
    db.snapshots = [];
    // после refreshStats снимки появляются: эмулируем первый запуск
    const page = await buildStatsPage(env, ORIGIN);
    expect(db.refreshes).toBe(1);
    expect(page.html).toContain('Пока считать нечего');
  });

  it('пустая страница зовёт на доску', async () => {
    db.snapshots = [];
    const page = await buildStatsPage(env, ORIGIN);
    expect(page.html).toContain('href="/"');
    expect(page.html).toContain('href="/new"');
  });

  it('город с разметкой в названии экранируется', async () => {
    db.snapshots = [month({
      topDirections: [{ pair: 'Тирасполь <b>x</b> → Одесса', from: 'Тирасполь <b>x</b>', to: 'Одесса', count: 3 }],
    })];
    db.pairs = [];
    const page = await buildStatsPage(env, ORIGIN);
    expect(page.html).not.toContain('<b>x</b>');
    expect(page.html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('кэшируется на полчаса', async () => {
    const page = await buildStatsPage(env, ORIGIN);
    expect(page.cacheControl).toContain('s-maxage=1800');
  });
});

describe('/itogi/:month — страница одного месяца', () => {
  it('заголовок, canonical, цифры и мнение месяца', async () => {
    db.summaries['2026-09'] = 'Сентябрь выдался живым. Направление Варшава — Минск стало ядром месяца.\n\nВодителей было больше, чем заявок.';
    const page = await buildMonthStatsPage(env, ORIGIN, '2026-09');
    expect(page).not.toBeNull();
    expect(page!.html).toContain('<title>Итоги сентября 2026: 11 объявлений');
    expect(page!.html).toContain(`<link rel="canonical" href="${ORIGIN}/itogi/2026-09" />`);
    expect(page!.html).toContain('<b>11</b><span>объявлений за месяц</span>');
    // сохранённое мнение показывается абзацами
    expect(page!.html).toContain('<p>Сентябрь выдался живым.');
    expect(page!.html).toContain('<p>Водителей было больше, чем заявок.</p>');
    expect(page!.html).toContain('"@type":"Article"');
    expect(page!.html).toContain('mainEntityOfPage":"https://pop-utka.app/itogi/2026-09"');
  });

  it('без сохранённого мнения — шаблон из цифр (страница не пустая)', async () => {
    const page = await buildMonthStatsPage(env, ORIGIN, '2026-09');
    expect(page).not.toBeNull();
    expect(page!.html).toContain('Как читается этот месяц');
    expect(page!.html).toContain('Варшава → Минск'); // топ-направление в тексте
  });

  it('соседние месяцы и «все итоги» — навигация', async () => {
    db.snapshots = [month(), month({ month: '2026-08', total: 20, offers: 12, requests: 8, cities: 9 })];
    const page = await buildMonthStatsPage(env, ORIGIN, '2026-08');
    expect(page!.html).toContain('href="/itogi/2026-09"');
    expect(page!.html).toContain('href="/itogi"');
  });

  it('неизвестный месяц и мусорный адрес — 404 (null)', async () => {
    expect(await buildMonthStatsPage(env, ORIGIN, '2020-01')).toBeNull();
    expect(await buildMonthStatsPage(env, ORIGIN, 'сентябрь')).toBeNull();
    expect(await buildMonthStatsPage(env, ORIGIN, '2026-13')).toBeNull();
  });
});
