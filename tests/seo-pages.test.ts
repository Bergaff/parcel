/**
 * Программные SEO-страницы: маршруты из базы, города, каталоги и sitemap.
 *
 * Проверяем главное: витринные слаги не плодят дублей, страницы динамических
 * пар появляются сами, города склоняются по-русски, sitemap-индекс ссылается
 * на три карты, а пустые страницы (без заявок) в индекс не попадают.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env, Listing } from '../src/types';

const db = vi.hoisted(() => ({
  listings: [] as Array<Partial<Listing> & { id: string; fromCity: string; toCity: string }>,
  pairs: [] as Array<{ fromCity: string; toCity: string; total: number; active: number; lastmod: string }>,
  cities: [] as Array<{ city: string; count: number; active: number; lastmod: string }>,
  items: [] as Array<{ id: string; lastmod: string }>,
}));

vi.mock('../src/store', () => ({
  listListings: async (_env: unknown, filter: { from?: string; to?: string; perPage?: number } = {}) => {
    let items = db.listings.filter((l) =>
      (!filter.from || l.fromCity === filter.from) && (!filter.to || l.toCity === filter.to));
    const perPage = filter.perPage ?? 20;
    const hasMore = items.length > perPage;
    items = items.slice(0, perPage);
    return { items: items as unknown as Listing[], hasMore };
  },
  listRoutePairs: async () => db.pairs,
  listCityStats: async () => db.cities,
  listSitemapItems: async () => db.items,
  getChatLinks: async () => ({}) as Record<string, string>,
}));

import {
  buildCitiesIndexPage, buildCityPage, buildItemsSitemap, buildPagesSitemap, buildRoutePage,
  buildRoutesIndexPage, buildRoutesSitemap, buildSitemapXml, cityPathFor, clearRouteIndexCache,
  footRoutes, knownCities, resolveCity, resolveRoute, resolveRouteAlias, routePathFor, SEO_ROUTES,
} from '../src/seo-routes';
import { citySlug, routeSlug } from '../src/seo';

const ORIGIN = 'https://pop-utka.app';
const env = {} as Env;

function listing(over: Partial<Listing> = {}) {
  return {
    id: 'b5023c82-e043-4863-9fae-ee19a095f211',
    type: 'offer',
    fromCity: 'Варшава',
    toCity: 'Минск',
    departureDate: '2030-05-20',
    weightKg: 8,
    price: '30 BYN',
    description: 'Еду в субботу утром, возьму одну сумку до 10 кг',
    phone: null,
    telegram: '@ivan_waw',
    status: 'published',
    source: 'telegram',
    createdAt: '2026-09-15T07:10:00.000Z',
    publishedAt: '2026-09-15T07:40:00.000Z',
    views: 12,
    ...over,
  } as unknown as Partial<Listing> & { id: string; fromCity: string; toCity: string };
}

beforeEach(() => {
  clearRouteIndexCache();
  db.listings = [
    listing(),
    listing({ id: 'l-2', fromCity: 'Гродно', toCity: 'Варшава', type: 'request', telegram: '@mary' }),
  ];
  db.pairs = [
    { fromCity: 'Варшава', toCity: 'Минск', total: 5, active: 4, lastmod: '2026-09-16' },
    { fromCity: 'Гродно', toCity: 'Варшава', total: 1, active: 1, lastmod: '2026-09-17' },
    // пара, которая совпадает с витриной, но транслит слага другой: дубля быть не должно
    { fromCity: 'Кёльн', toCity: 'Санкт-Петербург', total: 2, active: 1, lastmod: '2026-09-10' },
  ];
  db.cities = [
    { city: 'Варшава', count: 6, active: 5, lastmod: '2026-09-17' },
    { city: 'Гродно', count: 1, active: 1, lastmod: '2026-09-17' },
    { city: 'Минск', count: 4, active: 4, lastmod: '2026-09-16' },
  ];
  db.items = [
    { id: 'b5023c82-e043-4863-9fae-ee19a095f211', lastmod: '2026-09-17' },
    { id: 'l-2', lastmod: '2026-09-15' },
  ];
});

describe('индекс маршрутов', () => {
  it('витринный маршрут находится по своему слагу и получает статистику из базы', async () => {
    const r = await resolveRoute(env, 'varshava-minsk');
    expect(r?.from).toBe('Варшава');
    expect(r?.curated).toBe(true);
    expect(r?.pair?.active).toBe(4);
  });

  it('живая пара из базы получает страницу по транслитному слагу', async () => {
    const r = await resolveRoute(env, 'grodno-varshava');
    expect(r?.from).toBe('Гродно');
    expect(r?.curated).toBe(false);
    expect(r?.pair?.active).toBe(1);
  });

  it('пара из базы, совпадающая с витриной, остаётся витринной страницей', async () => {
    // Варшава → Минск есть и в базе, и в витрине: страница одна, статистика подтянулась
    const r = await resolveRoute(env, 'varshava-minsk');
    expect(r?.curated).toBe(true);
    expect(r?.pair?.active).toBe(4);
    expect(await routePathFor(env, 'Варшава', 'Минск')).toBe('/r/varshava-minsk');
    // а пара, которой в витрине нет, становится живой страницей
    const live = await resolveRoute(env, 'keln-sankt-peterburg');
    expect(live?.curated).toBe(false);
    expect(live?.pair?.active).toBe(1);
  });

  it('если транслит пары не совпадает с витринным слагом, адрес всё равно витринный', async () => {
    db.pairs.push({ fromCity: 'Варшава', toCity: 'Кёльн', total: 3, active: 2, lastmod: '2026-09-14' });
    clearRouteIndexCache();
    // транслит дал бы varshava-keln, но такая страница существовать не должна
    expect(await resolveRoute(env, 'varshava-keln')).toBeNull();
    expect(await routePathFor(env, 'Варшава', 'Кёльн')).toBe('/r/varshava-koln');
    const r = await resolveRoute(env, 'varshava-koln');
    expect(r?.pair?.active).toBe(2);
  });

  it('неизвестный маршрут — null (воркер отдаст 404)', async () => {
    expect(await resolveRoute(env, 'varshava-nesushestvuet')).toBeNull();
  });

  it('routePathFor знает и витрину, и обратные живые пары', async () => {
    expect(await routePathFor(env, 'Варшава', 'Минск')).toBe('/r/varshava-minsk');
    expect(await routePathFor(env, 'Гродно', 'Варшава')).toBe('/r/grodno-varshava');
    expect(await routePathFor(env, 'Минск', 'Варшава')).toBeNull();
  });

  it('транслитный слаг витринной пары — алиас для 301, а не вторая страница', async () => {
    expect(await resolveRouteAlias(env, 'varshava-keln')).toBe('varshava-koln');
    expect(await resolveRouteAlias(env, 'minsk-sankt-peterburg')).toBe('minsk-peterburg');
    expect(await resolveRouteAlias(env, 'varshava-minsk')).toBeNull();
    expect(await resolveRouteAlias(env, 'grodno-varshava')).toBeNull();
  });

  it('город определяется по слагу, путь к странице города', async () => {
    const c = await resolveCity(env, 'varshava');
    expect(c?.city).toBe('Варшава');
    expect(c?.stat?.active).toBe(5);
    expect(cityPathFor('Гродно')).toBe('/gorod/grodno');
    expect(await resolveCity(env, 'netu')).toBeNull();
  });
});

describe('страница маршрута', () => {
  it('витрина: заголовок, canonical, OG-картинка, JSON-LD, крошки', async () => {
    const html = await buildRoutePage(env, 'varshava-minsk', ORIGIN);
    expect(html).not.toBeNull();
    expect(html).toContain('<title>Передать посылку Варшава → Минск');
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/r/varshava-minsk" />`);
    expect(html).toContain(`property="og:image" content="${ORIGIN}/og-route/varshava-minsk.png"`);
    expect(html).toContain('"@type":"BreadcrumbList"');
    expect(html).toContain('"@type":"ItemList"');
    expect(html).toContain('"@type":"FAQPage"');
    expect(html).toContain('<nav class="crumbs"');
    expect(html).toContain('href="/gorod/varshava"');
    // статистика пары попала в подпись под заголовком
    expect(html).toContain('4 заявки на доске');
  });

  it('живые заявки маршрута отрендерены ссылками на карточки', async () => {
    const html = await buildRoutePage(env, 'varshava-minsk', ORIGIN);
    expect(html).toContain(`href="/item/b5023c82-e043-4863-9fae-ee19a095f211"`);
  });

  it('динамический маршрут рендерится так же, как витринный', async () => {
    const html = await buildRoutePage(env, 'grodno-varshava', ORIGIN);
    expect(html).toContain('<title>Передать посылку Гродно → Варшава');
    expect(html).toContain(`href="${ORIGIN}/r/grodno-varshava"`);
    expect(html).toContain('живой маршрут');
  });

  it('нет заявок — страница честно об этом пишет и зовёт разместить', async () => {
    const html = await buildRoutePage(env, 'varshava-lvov', ORIGIN);
    expect(html).toContain('сейчас нет активных заявок');
    expect(html).toContain('href="/new"');
  });

  it('обратный маршрут предлагается ссылкой', async () => {
    const html = await buildRoutePage(env, 'varshava-grodno', ORIGIN);
    expect(html).toContain('href="/r/grodno-varshava"');
  });

  it('нет такого маршрута — null', async () => {
    expect(await buildRoutePage(env, 'fu', ORIGIN)).toBeNull();
  });

  it('город с разметкой в названии экранируется', async () => {
    const dirty = 'Тирасполь <script>alert(1)</script>';
    db.pairs.push({ fromCity: dirty, toCity: 'Одесса', total: 1, active: 1, lastmod: '2026-09-17' });
    db.listings.push(listing({ id: 'l-xss', fromCity: dirty, toCity: 'Одесса' }));
    clearRouteIndexCache();
    const slug = routeSlug(dirty, 'Одесса');
    const r = await resolveRoute(env, slug);
    expect(r).not.toBeNull();
    const html = await buildRoutePage(env, slug, ORIGIN);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('страница города', () => {
  it('склоняет город и показывает направления со счётчиками', async () => {
    const html = await buildCityPage(env, 'varshava', ORIGIN);
    expect(html).not.toBeNull();
    expect(html).toContain('<title>Передачи из Варшавы и в Варшаву');
    expect(html).toContain('<h1 class="page-title">Передачи из Варшавы и в Варшаву</h1>');
    expect(html).toContain('Варшава в Польше');
    expect(html).toContain('Куда едут из Варшавы');
    expect(html).toContain('href="/r/varshava-minsk"');
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/gorod/varshava" />`);
    expect(html).toContain(`property="og:image" content="${ORIGIN}/og-route/varshava.png"`);
    expect(html).toContain('"@type":"BreadcrumbList"');
  });

  it('заявки из города и в город — двумя блоками', async () => {
    const html = await buildCityPage(env, 'varshava', ORIGIN);
    expect(html).toContain('Заявки из Варшавы сейчас');
    expect(html).toContain('Заявки в Варшаву сейчас');
    expect(html).toContain('href="/item/l-2"');
  });

  it('город без заявок остаётся страницей, но без пустых блоков', async () => {
    const html = await buildCityPage(env, 'krakov', ORIGIN);
    expect(html).toContain('Сейчас заявок с этим городом нет');
    expect(html).not.toContain('Заявки из Кракова сейчас');
  });

  it('нет такого города — null', async () => {
    expect(await buildCityPage(env, 'fu', ORIGIN)).toBeNull();
  });
});

describe('каталоги', () => {
  it('/routes перечисляет витрину и живые пары, счётчики рядом', async () => {
    const html = await buildRoutesIndexPage(env, ORIGIN);
    expect(html).toContain('href="/r/varshava-minsk"');
    expect(html).toContain('href="/r/grodno-varshava"');
    expect(html).toContain('href="/gorod/varshava"');
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/routes" />`);
    // пара из витрины не повторяется вторым адресом
    expect(html).not.toContain('href="/r/varshava-keln"');
  });

  it('/gorod группирует города по странам', async () => {
    const html = await buildCitiesIndexPage(env, ORIGIN);
    expect(html).toContain('Польша');
    expect(html).toContain('href="/gorod/varshava"');
    expect(html).toContain('href="/gorod/minsk"');
  });

  it('подвал берёт маршруты без дублей направления', () => {
    const routes = footRoutes(9);
    const keys = routes.map((r) => [r.from, r.to].sort().join('|'));
    expect(new Set(keys).size).toBe(keys.length);
    expect(routes.length).toBeLessThanOrEqual(9);
  });
});

describe('карта сайта', () => {
  it('/sitemap.xml — индекс из трёх карт', async () => {
    const xml = await buildSitemapXml(env, ORIGIN);
    expect(xml).toContain('<sitemapindex');
    expect(xml).toContain(`${ORIGIN}/sitemap-pages.xml`);
    expect(xml).toContain(`${ORIGIN}/sitemap-routes.xml`);
    expect(xml).toContain(`${ORIGIN}/sitemap-items.xml`);
    expect(xml).toContain('<lastmod>2026-09-17</lastmod>');
  });

  it('карта страниц содержит постоянные адреса и не содержит админку', () => {
    const xml = buildPagesSitemap(ORIGIN, '2026-09-17');
    expect(xml).toContain(`${ORIGIN}/routes`);
    expect(xml).toContain(`${ORIGIN}/gorod`);
    expect(xml).toContain(`${ORIGIN}/how`);
    expect(xml).not.toContain('/admin');
  });

  it('карта маршрутов: витрина, живые пары и города с заявками, все с lastmod', async () => {
    const xml = await buildRoutesSitemap(env, ORIGIN);
    expect(xml).toContain(`${ORIGIN}/r/varshava-minsk`);
    expect(xml).toContain(`${ORIGIN}/r/grodno-varshava`);
    expect(xml).toContain('<lastmod>2026-09-16</lastmod>');
    expect(xml).toContain(`${ORIGIN}/gorod/varshava`);
    // город без живых заявок в индекс не пускаем
    expect(xml).not.toContain(`${ORIGIN}/gorod/krakov`);
    expect(xml).not.toContain('keln-peterburg');
  });

  it('карта объявлений берёт только видимые заявки', async () => {
    const xml = await buildItemsSitemap(env, ORIGIN);
    expect(xml).toContain(`${ORIGIN}/item/b5023c82-e043-4863-9fae-ee19a095f211`);
    expect(xml).toContain('<lastmod>2026-09-17</lastmod>');
    expect((xml.match(/<url>/g) ?? []).length).toBe(2);
  });
});

describe('вся витрина рендерится', () => {
  it('каждый маршрут из списка отдаёт страницу с заголовком', async () => {
    const broken: string[] = [];
    for (const r of SEO_ROUTES) {
      const html = await buildRoutePage(env, r.slug, ORIGIN);
      if (!html || !html.includes('<h1 class="page-title">') || html.includes('undefined')) broken.push(r.slug);
    }
    expect(broken).toEqual([]);
  });

  it('каждый известный город отдаёт страницу', async () => {
    const broken: string[] = [];
    for (const city of knownCities()) {
      const slug = citySlug(city);
      const html = await buildCityPage(env, slug, ORIGIN);
      if (!html || !html.includes('<h1 class="page-title">') || html.includes('undefined')) broken.push(`${city} (${slug})`);
    }
    expect(broken).toEqual([]);
  });
});
