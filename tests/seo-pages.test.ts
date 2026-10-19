/**
 * Программные SEO-страницы: маршруты из базы, города, каталоги и sitemap.
 *
 * Проверяем главное: витринные слаги не плодят дублей, страницы динамических
 * пар появляются сами, города склоняются по-русски, sitemap-индекс ссылается
 * на три карты, а пустые страницы (без заявок) в индекс не попадают.
 */
import { readFileSync } from 'node:fs';

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
  getCounts: async () => ({ offer: 3, request: 2 }),
}));

import {
  buildCitiesIndexPage, buildCityPage, buildItemsSitemap, buildPagesSitemap, buildRoutePage,
  buildRoutesIndexPage, buildRoutesSitemap, buildSitemapXml, cityPathFor, clearRouteIndexCache,
  footRoutes, knownCities, resolveCity, resolveRoute, resolveRouteAlias, routeDescription,
  routeAltSlugs, routePathFor, routeTitle, SEO_ROUTES, tripBlock, tripFaq,
} from '../src/seo-routes';
import { cityAliasSlug, cityAltNamesText } from '../src/seo-routes';
import { normalizeCity } from '../src/parser';
import { buildHomePage } from '../src/pages';
import { citySlug, routeSlug } from '../src/seo';
import { SITE_VERSION } from '../src/version';

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

/* Заголовок и описание страницы маршрута — под бюджет Google. Повод:
   /r/vrotslav-minsk держала позицию 2,56 при 94 показах и давала 4 клика
   (CTR 4,4%): старый шаблон был 71–73 символа и обрезался на «…заявки води…». */
describe('заголовок и описание маршрута', () => {
  it('влезают в бюджет Google у всех витринных маршрутов', () => {
    const over: string[] = [];
    for (const r of SEO_ROUTES) {
      for (const active of [0, 1, 4, 27]) {
        const t = routeTitle(r.from, r.to, active);
        const d = routeDescription(r.from, r.to, active);
        if (t.length > 60) over.push(`title ${r.slug} (${active}): ${t.length} — ${t}`);
        if (d.length > 160) over.push(`desc ${r.slug} (${active}): ${d.length} — ${d}`);
        if (!t.includes(`${r.from} → ${r.to}`)) over.push(`title без пары ${r.slug}`);
        if (!d.includes(`${r.from} → ${r.to}`)) over.push(`desc без пары ${r.slug}`);
      }
    }
    expect(over).toEqual([]);
  });

  it('есть живые заявки — число в заголовке, а не общие слова', () => {
    expect(routeTitle('Вроцлав', 'Минск', 12)).toBe('Передать посылку Вроцлав → Минск — 12 заявок | попутка.');
    expect(routeTitle('Минск', 'Москва', 1)).toBe('Передать посылку Минск → Москва — 1 заявка | попутка.');
    // длинные названия: вариант покороче, но число заявок сохраняется
    expect(routeTitle('Санкт-Петербург', 'Ереван', 3)).toBe('Посылка Санкт-Петербург → Ереван — 3 заявки | попутка.');
  });

  it('заявок нет — честно «с попуткой», без вранья про количество', () => {
    expect(routeTitle('Вроцлав', 'Минск', 0)).toBe('Передать посылку Вроцлав → Минск с попуткой | попутка.');
    expect(routeDescription('Вроцлав', 'Минск', 0)).toContain('заявок нет');
    expect(routeDescription('Вроцлав', 'Минск', 0)).toContain('разместите просьбу');
  });

  it('описание начинается с фактов: число заявок, даты, цена, контакт', () => {
    const d = routeDescription('Варшава', 'Минск', 4);
    expect(d.startsWith('4 живые заявки Варшава → Минск:')).toBe(true);
    expect(d).toContain('контакт водителя');
    expect(d).toContain('без посредников и комиссий');
  });

  it('страница маршрута рендерится с новым заголовком', async () => {
    const html = await buildRoutePage(env, 'varshava-minsk', ORIGIN);
    // active=4 в моке: число заявок попало в <title>
    expect(html).toContain('<title>Передать посылку Варшава → Минск — 4 заявки | попутка.</title>');
    expect(html).toContain('name="description" content="4 живые заявки Варшава → Минск:');
  });
});

/* Блок «Сколько ехать» — ответ на запросы «расстояние/сколько ехать/как
   добраться» и «кузницу», по которым Google нас показывал, а ответа на
   странице не было. */
describe('блок «Сколько ехать» на странице маршрута', () => {
  it('километраж, время и пункты пропуска — в теле и в FAQ', async () => {
    const html = await buildRoutePage(env, 'varshava-minsk', ORIGIN);
    expect(html).toContain('<h2 class="rule-head">Сколько ехать Варшава → Минск</h2>');
    expect(html).toContain('По трассе примерно 590 км — около 8 ч за рулём');
    expect(html).toContain('Брузги — Кузница');
    expect(html).toContain('уточняйте перед выездом');
    // тот же факт — вопросом в «Частых вопросах» и в разметке FAQPage
    expect(html).toContain('Сколько ехать Варшава → Минск?');
    expect(html).toContain('"@type":"FAQPage"');
  });

  it('внутри Шенгена границы нет — и на странице её не выдумываем', async () => {
    const html = await buildRoutePage(env, 'varshava-berlin', ORIGIN);
    expect(html).toContain('Сколько ехать Варшава → Берлин');
    expect(html).toContain('примерно 575 км');
    expect(html).not.toContain('пункты пропуска на нём');
    expect(html).not.toContain('пересекает границу');
  });

  it('граница без списка переходов названа, но без обещаний', async () => {
    const html = await buildRoutePage(env, 'minsk-moskva', ORIGIN);
    expect(html).toContain('примерно 720 км');
    expect(html).toContain('пересекает границу Беларусь — Россия');
    expect(html).not.toContain('пункты пропуска на нём');
  });

  it('неизвестный город — блока нет, а страница живая', () => {
    expect(tripBlock('Минск', 'Нету-Такого')).toBe('');
    expect(tripFaq('Минск', 'Нету-Такого')).toBeNull();
  });

  it('текст блока: приблизительно, с числом и часами', () => {
    const html = tripBlock('Вроцлав', 'Минск');
    expect(html).toContain('примерно 1150 км');
    expect(html).toContain('ч за рулём');
    expect(tripFaq('Вроцлав', 'Минск')![1]).toContain('1150 км');
  });
});

/* Местные названия городов: запросы «попутники львів мостиска» (позиция 51),
   «попутчики киев» (53), «попутники львів володимир» (57) из Search Console. */
describe('местные названия городов', () => {
  it('украинское/белорусское написание приводит к каноническому городу', () => {
    expect(normalizeCity('Київ')).toBe('Киев');
    expect(normalizeCity('Львів')).toBe('Львов');
    expect(normalizeCity('Мінск')).toBe('Минск');
    expect(normalizeCity('Гродна')).toBe('Гродно');
    expect(normalizeCity('Мостиська')).toBe('Мостиска');
  });

  it('слаг местного названия ведёт на каноническую страницу (301)', () => {
    expect(cityAliasSlug('kyiv')).toBe('kiev'); // англ. Kyiv
    expect(cityAliasSlug('kiiv')).toBe('kiev'); // укр. Київ транслитом
    expect(cityAliasSlug('lviv')).toBe('lvov'); // укр. Львів и англ. Lviv
    expect(cityAliasSlug('grodna')).toBe('grodno'); // бел. Гродна
    expect(cityAliasSlug('warszawa')).toBe('varshava');
    expect(cityAliasSlug('warsaw')).toBe('varshava');
    expect(cityAliasSlug('wroclaw')).toBe('vrotslav');
  });

  it('канонический слаг и неизвестный — без редиректа', () => {
    expect(cityAliasSlug('kiev')).toBeNull();
    expect(cityAliasSlug('minsk')).toBeNull(); // «Мінск» и «Minsk» транслитом и так minsk
    expect(cityAliasSlug('gdansk')).toBeNull(); // «Gdansk» = канонический слаг
    expect(cityAliasSlug('netu')).toBeNull();
    expect(cityAliasSlug('moskva')).toBeNull();
  });

  it('редирект не ведёт на чужую страницу города', () => {
    // «Praha» — это Прага, а не чей-то ещё слаг; collisions быть не должно
    expect(cityAliasSlug('praha')).toBe('praga');
    expect(cityAliasSlug('vena')).toBeNull();
  });

  it('местные написания видны на странице города', async () => {
    const html = await buildCityPage(env, 'kiev', ORIGIN);
    expect(html).toContain('другие названия: Київ (укр.)');
    const lvov = await buildCityPage(env, 'lvov', ORIGIN);
    expect(lvov).toContain('Львів (укр.)');
    expect(lvov).toContain('Lwów (польск.)');
  });

  it('нет местного названия — строки нет', () => {
    expect(cityAltNamesText('Забайкальск')).toBeNull();
  });

  it('слаги маршрутов из местных написаний — алиасы витринных страниц', () => {
    expect(routeAltSlugs('Киев', 'Львов')).toContain('kyiv-lviv');
    expect(routeAltSlugs('Варшава', 'Минск')).toContain('warszawa-minsk');
    // канонического слага в списке нет — он и так страница
    expect(routeAltSlugs('Киев', 'Львов')).not.toContain('kiev-lvov');
  });

  it('алиас маршрута резолвится в витринный слаг', async () => {
    expect(await resolveRouteAlias(env, 'kyiv-lviv')).toBe('kiev-lvov');
    expect(await resolveRouteAlias(env, 'warszawa-minsk')).toBe('varshava-minsk');
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
    // фавикон — реальными файлами (см. tests/ssr.test.ts), не только на главной
    expect(html).toContain(`<link rel="icon" href="/favicon.ico?v=${SITE_VERSION}"`);
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
    // «Попутки Варшава» — как город ищут в поиске («попутка гродно», «попутки гродно»)
    expect(html).toContain('<title>Попутки Варшава: передать посылку из Варшавы и в Варшаву');
    expect(html).toContain('<h1 class="page-title">Попутки Варшава: передать посылку из Варшавы и в Варшаву</h1>');
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

  it('в шапке каталогов — сколько объявлений на доске и вкладка «Бот»', async () => {
    const withBot = { BOT_USERNAME: 'parcel_transfer_bot' } as Env;
    const routes = await buildRoutesIndexPage(withBot, ORIGIN);
    expect(routes).toContain('на доске <b>5 объявлений</b>');
    expect(routes).toContain('<a href="/bot">Бот</a>');
    // навигация — отдельной строкой под шапкой, как на главной (мобильный перенос)
    expect(routes).toContain('<nav class="topnav wrap">');
    // без настроенного бота вкладки нет — как на главной до подтверждения конфига
    const cities = await buildCitiesIndexPage(env, ORIGIN);
    expect(cities).toContain('на доске <b>5 объявлений</b>');
    expect(cities).not.toContain('href="/bot"');
  });

  it('подвал берёт маршруты без дублей направления', () => {
    const routes = footRoutes(9);
    const keys = routes.map((r) => [r.from, r.to].sort().join('|'));
    expect(new Set(keys).size).toBe(keys.length);
    expect(routes.length).toBeLessThanOrEqual(9);
  });

  it('витрина выросла на направления из поисковых запросов', () => {
    const slugs = new Set(SEO_ROUTES.map((r) => r.slug));
    // «попутка гродно», «в гродно на попутке» — Гродно ищут чаще всего
    expect(slugs.has('grodno-minsk')).toBe(true);
    expect(slugs.has('grodno-vilnyus')).toBe(true);
    // «возьму попутно посылки из праги в москву», «найти попутку в минск»
    expect(slugs.has('praga-moskva')).toBe(true);
    expect(slugs.has('moskva-praga')).toBe(true);
    expect(slugs.has('moskva-minsk')).toBe(true);
    // «попутка передачка груза москва забайкальска» (дальнобой)
    expect(slugs.has('moskva-zabaykalsk')).toBe(true);
  });

  it('на витринных страницах есть перелинковка на популярные маршруты и города', async () => {
    const html = await buildRoutePage(env, 'varshava-minsk', ORIGIN);
    expect(html).toContain('Популярные маршруты:');
    expect(html).toContain('href="/r/grodno-minsk"');
    expect(html).toContain('href="/gorod/grodno"');
    expect(html).toContain('href="/gorod/moskva"');
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

  it('страницы месяцев итогов попадают в карту — по одной на месяц', () => {
    const xml = buildPagesSitemap(ORIGIN, '2026-09-17', [
      { month: '2026-09', updatedAt: '2026-10-01 00:10:00' },
      { month: '2026-08', updatedAt: '2026-09-01 00:10:00' },
    ]);
    expect(xml).toContain(`<loc>${ORIGIN}/itogi/2026-09</loc>`);
    expect(xml).toContain(`<loc>${ORIGIN}/itogi/2026-08</loc>`);
    expect(xml).toContain('<lastmod>2026-10-01</lastmod>');
    // без месяцев карта не ломается
    expect(buildPagesSitemap(ORIGIN, '2026-09-17')).toContain(`<loc>${ORIGIN}/itogi</loc>`);
    expect(buildPagesSitemap(ORIGIN, '2026-09-17')).toContain(`<loc>${ORIGIN}/telegram</loc>`);
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

  it('на SEO-странице работает маячок живого браузера (app.js тут нет)', async () => {
    const html = await buildRoutePage(env, 'varshava-minsk', ORIGIN);
    expect(html).toContain("/api/visit-confirm");
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

describe('каноник фильтрованной главной', () => {
  /** buildHomePage рендерит оболочку через ASSETS — даём ей public/index.html. */
  function envWithAssets(): Env {
    const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    return {
      ASSETS: { fetch: async () => new Response(index, { status: 200 }) },
    } as unknown as Env;
  }

  it('пара городов со страницей маршрута: canonical на /r/<слаг> — как выбирает Google', async () => {
    const html = (await buildHomePage(envWithAssets(), ORIGIN, new URL(`${ORIGIN}/?from=Варшава&to=Минск`))).html;
    expect(html).toContain(`rel="canonical" href="${ORIGIN}/r/varshava-minsk"`);
    expect(html).toContain('name="robots" content="noindex, follow"');
  });

  it('фильтр без пары (тип, дата): canonical на главную', async () => {
    const html = (await buildHomePage(envWithAssets(), ORIGIN, new URL(`${ORIGIN}/?type=offer&date=2030-05-20`))).html;
    expect(html).toContain(`rel="canonical" href="${ORIGIN}/"`);
    expect(html).toContain('name="robots" content="noindex, follow"');
  });

  it('пара без страницы маршрута: canonical на главную', async () => {
    db.pairs = [];
    const html = (await buildHomePage(envWithAssets(), ORIGIN, new URL(`${ORIGIN}/?from=Париж&to=Лиссабон`))).html;
    expect(html).toContain(`rel="canonical" href="${ORIGIN}/"`);
  });

  it('главная без фильтров: canonical на саму себя', async () => {
    const html = (await buildHomePage(envWithAssets(), ORIGIN, new URL(`${ORIGIN}/`))).html;
    expect(html).toContain(`rel="canonical" href="${ORIGIN}/"`);
    expect(html).not.toContain('name="robots"');
  });
});
