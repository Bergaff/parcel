/**
 * GEO-страницы «что передают» (/peredat, /peredat/:slug, /llms.txt).
 *
 * ИИ-поисковики (ChatGPT, Яндекс Нейро, Perplexity, Google AI Overviews)
 * цитируют страницы с живыми цифрами, FAQ и понятной структурой. Проверяем:
 * цифры страниц — из базы и не врут, пустая категория честно говорит
 * «заявок нет», llms.txt и robots.txt на месте, sitemap и кэш знают адреса.
 */
import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env, Listing } from '../src/types';

const db = vi.hoisted(() => ({
  board: { board: 25, offers: 20, requests: 5, last30: 7, updatedAt: '2026-11-01 09:00:00' } as
    { board: number; offers: number; requests: number; last30: number; updatedAt: string | null },
  routes: [] as Array<{ from: string; to: string; total: number }>,
  carryStats: null as unknown,
  counts: { offer: 30, request: 8 },
  listings: [] as Listing[],
  pairs: [{ fromCity: 'Минск', toCity: 'Варшава', total: 9, active: 9, lastmod: '2026-11-01' }],
  cities: [] as Array<{ city: string; count: number; active: number; lastmod: string }>,
}));

vi.mock('../src/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/store')>()),
  listListings: async () => ({ items: db.listings, hasMore: false }),
  listRoutePairs: async () => db.pairs,
  listCityStats: async () => db.cities,
  listSitemapItems: async () => [],
  getChatLinks: async () => ({}) as Record<string, string>,
  getCounts: async () => db.counts,
  carryCategoryBoard: async () => db.board,
  carryTopRoutes: async () => db.routes,
  carryListings: async () => db.listings,
  listCarryStats: async () => db.carryStats,
  publicListing: (l: Listing) => l,
}));

import {
  buildCarryHubPage, buildCarryPage, buildLlmsTxt, carryOgSpec, carryTitle, carryWordsFor,
} from '../src/seo-carry';
import { CARRY_PAGES, FOOT_CARRY, carryPaths, resolveCarryPage } from '../src/carry-pages';
import { buildPagesSitemap, clearRouteIndexCache } from '../src/seo-routes';
import { CARRY_CATEGORIES } from '../src/store';
import { edgeCacheTtl } from '../src/edge-cache';
import { isTrackablePage, pageKind } from '../src/visit-stats';

const ORIGIN = 'https://pop-utka.app';
const env = { BOT_USERNAME: 'parcel_transfer_bot', SITE_URL: ORIGIN } as unknown as Env;

function listing(over: Partial<Listing> = {}): Listing {
  return {
    id: 'l-1',
    type: 'offer',
    fromCity: 'Минск',
    toCity: 'Варшава',
    departureDate: '2030-05-20',
    weightKg: null,
    price: null,
    description: 'Везу документы в запечатанном конверте',
    phone: null,
    telegram: '@ivan',
    status: 'published',
    source: 'telegram',
    sourceChat: null,
    sourceChatId: null,
    sourceMessageId: null,
    sourceChatUsername: null,
    sourceThreadId: null,
    createdAt: '2026-11-01T07:10:00.000Z',
    publishedAt: '2026-11-01T07:40:00.000Z',
    views: 3,
    ...over,
  } as Listing;
}

beforeEach(() => {
  clearRouteIndexCache();
  db.board = { board: 25, offers: 20, requests: 5, last30: 7, updatedAt: '2026-11-01 09:00:00' };
  db.routes = [
    { from: 'Минск', to: 'Варшава', total: 9 },
    { from: 'Брест', to: 'Тересполь', total: 4 },
  ];
  db.carryStats = {
    total: 38,
    categories: [
      { key: 'docs', label: 'Документы', total: 25, offers: 20, requests: 5, last30: 7 },
      { key: 'parcel', label: 'Посылки и коробки', total: 13, offers: 10, requests: 3, last30: 4 },
    ],
    other: { key: 'other', label: 'Прочее (без ключевых слов)', total: 0, offers: 0, requests: 0, last30: 0 },
    updatedAt: '2026-11-01 09:00:00',
  };
  db.counts = { offer: 30, request: 8 };
  db.listings = [listing()];
});

describe('страница категории /peredat/:slug', () => {
  it('живые цифры из базы: заявки, направления, свежесть, FAQ', async () => {
    const html = await buildCarryPage(env, 'dokumenty', ORIGIN);
    expect(html).not.toBeNull();
    const h = html!;
    expect(h).toContain('Передать документы попуткой');
    expect(h).toContain('25 живых заявок');
    expect(h).toContain('про документы');
    expect(h).toContain('20 водителей везут');
    expect(h).toContain('Новых за 30 дней — 7');
    expect(h).toContain('данные доски:');
    // направления: живая пара ведёт на страницу маршрута, остальное — текст
    expect(h).toContain('/r/minsk-varshava');
    expect(h).toContain('Брест');
    expect(h).toContain('· 9 заявок');
    // живые заявки категории — строки доски со ссылками на карточки
    expect(h).toContain('/item/l-1');
    // GEO-механика: каноник, OG категории, FAQ и крошки в JSON-LD
    expect(h).toContain('<link rel="canonical" href="https://pop-utka.app/peredat/dokumenty"');
    expect(h).toContain('/og-carry/dokumenty.png');
    expect(h).toContain('FAQPage');
    expect(h).toContain('BreadcrumbList');
    expect(h).toContain('Сколько стоит передать документы с попуткой?');
    // цена честная: договариваются напрямую, цифр от себя нет
    expect(h).toContain('Цену договаривают напрямую с водителем');
    expect(h).not.toContain('руб.');
  });

  it('пустая категория: честно «заявок нет», без выдуманных цифр', async () => {
    db.board = { board: 0, offers: 0, requests: 0, last30: 0, updatedAt: null };
    db.routes = [];
    db.listings = [];
    const h = (await buildCarryPage(env, 'kluchi', ORIGIN))!;
    expect(h).toContain('Сейчас на доске нет живых заявок про ключи');
    expect(h).toContain('разместите просьбу');
    expect(h).not.toContain('/item/');
  });

  it('неизвестный слаг — null (роутер отдаст честный 404)', async () => {
    expect(await buildCarryPage(env, 'kotiki', ORIGIN)).toBeNull();
    expect(await buildCarryPage(env, '', ORIGIN)).toBeNull();
  });

  it('категория «животные» — перевозка, а не передача: свой h1 и советы', async () => {
    const h = (await buildCarryPage(env, 'zhivotnye', ORIGIN))!;
    expect(h).toContain('Перевезти животное попуткой');
    expect(h).toContain('ветпаспорт');
    expect(h).toContain('переноска обязательна');
  });
});

describe('хаб /peredat', () => {
  it('категории с живыми цифрами, свежие заявки, FAQ и ItemList', async () => {
    const h = await buildCarryHubPage(env, ORIGIN);
    expect(h).toContain('Что передают попуткой');
    expect(h).toContain('38 объявлений');
    expect(h).toContain('30 «водитель везёт»');
    expect(h).toContain('/peredat/dokumenty');
    expect(h).toContain('Документы');
    expect(h).toContain('25 заявок · 20 везут / 5 ищут');
    expect(h).toContain('/item/l-1');
    expect(h).toContain('FAQPage');
    expect(h).toContain('документы (25)');
    expect(h).toContain('<link rel="canonical" href="https://pop-utka.app/peredat"');
  });
});

describe('llms.txt — сводка сайта для ИИ-поисковиков', () => {
  it('markdown по стандарту: заголовок, цитата, цифры, ссылки', async () => {
    const txt = await buildLlmsTxt(env, ORIGIN);
    expect(txt.startsWith('# попутка.')).toBe(true);
    expect(txt).toContain('> Личная доска попутных передач');
    expect(txt).toContain('Данные доски на 2026-11-01: 38 активных объявлений');
    expect(txt).toContain('- [Документы](https://pop-utka.app/peredat/dokumenty): 25 заявок на доске (20 везут / 5 ищут)');
    expect(txt).toContain('https://pop-utka.app/r/varshava-minsk');
    expect(txt).toContain('@parcel_transfer_bot');
    expect(txt).toContain('https://pop-utka.app/new');
  });
});

describe('robots.txt пускает ИИ-ботов', () => {
  it('краулеры LLM разрешены, админка закрыта, llms.txt упомянут', () => {
    const robots = readFileSync(new URL('../public/robots.txt', import.meta.url), 'utf8');
    for (const bot of ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'PerplexityBot',
      'Google-Extended', 'Applebot-Extended', 'Bytespider', 'DuckAssistBot']) {
      expect(robots, bot).toContain(`User-agent: ${bot}`);
    }
    expect(robots).toContain('llms.txt');
    expect(robots).toContain('Disallow: /api/');
    expect(robots).toContain('Allow: /');
    expect(robots).toContain('Sitemap: https://pop-utka.app/sitemap.xml');
  });
});

describe('каталог категорий и интеграция', () => {
  it('у каждой страницы есть категория с словами, слаги уникальны', () => {
    const slugs = new Set(CARRY_PAGES.map((p) => p.slug));
    expect(slugs.size).toBe(CARRY_PAGES.length);
    for (const p of CARRY_PAGES) {
      const cat = CARRY_CATEGORIES.find((c) => c.key === p.key);
      expect(cat, `нет категории для ${p.slug}`).toBeDefined();
      expect(carryWordsFor(p.key).length).toBeGreaterThan(0);
      expect(resolveCarryPage(p.slug)?.key).toBe(p.key);
    }
    expect(resolveCarryPage('net-takogo')).toBeNull();
    expect(FOOT_CARRY).toHaveLength(6);
    for (const f of FOOT_CARRY) expect(resolveCarryPage(f.slug)).not.toBeNull();
  });

  it('sitemap-страниц включает хаб и все категории', () => {
    const paths = carryPaths();
    expect(paths).toHaveLength(13);
    expect(paths[0]).toBe('/peredat');
    const xml = buildPagesSitemap(ORIGIN, '2026-11-05', [], paths);
    expect(xml).toContain('<loc>https://pop-utka.app/peredat</loc>');
    expect(xml).toContain('<loc>https://pop-utka.app/peredat/dokumenty</loc>');
    expect(xml).toContain('<loc>https://pop-utka.app/peredat/posylki</loc>');
  });

  it('просмотры считаются, кэш и метка страницы настроены', () => {
    expect(isTrackablePage('/peredat')).toBe(true);
    expect(isTrackablePage('/peredat/dokumenty')).toBe(true);
    expect(isTrackablePage('/llms.txt')).toBe(false); // боты — не посетители
    expect(pageKind('/peredat/dokumenty')).toBe('Что передают');
    expect(edgeCacheTtl('/peredat', false)).toBe(1800);
    expect(edgeCacheTtl('/peredat/kluchi', false)).toBe(1800);
    expect(edgeCacheTtl('/llms.txt', false)).toBe(3600);
    expect(edgeCacheTtl('/og-carry/dokumenty.png', false)).toBe(86400);
  });

  it('заголовок и OG-карточка: цифра живая, бренд на месте, длина в норме', () => {
    const page = resolveCarryPage('dokumenty')!;
    const t = carryTitle(page, 25);
    expect(t).toContain('25 заявок на доске');
    expect(t.endsWith('| попутка.')).toBe(true);
    expect(t.length).toBeLessThanOrEqual(70);
    expect(carryTitle(page, 0)).not.toContain('0 заявок');
    const spec = carryOgSpec(page, db.board);
    expect(spec.from).toBe('Документы');
    expect(spec.badge).toBe('25 заявок на доске');
  });
});
