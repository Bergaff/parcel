/**
 * Серверный рендер и SEO-мелочь: оболочка сайта, строки доски, карточка,
 * слаги, JSON-LD. Здесь же проверка, что SSR-разметка совпадает с клиентской
 * (иначе после гидрации контент «прыгает») и что ничего не экранируется мимо.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { Env, Listing } from '../src/types';
import {
  contactOf, isAppPath, isArchived, renderDetailHtml, renderRowHtml, renderRowsHtml,
  renderShell, setView, sourceLabel, todayLine,
} from '../src/ssr';
import { extractFaq, itemDescription, itemTitle, siteOrigin, STATIC_PAGES } from '../src/pages';
import {
  breadcrumbsLd, citySlug, faqPageLd, headMeta, itemListLd, jsonForScript, jsonLd, routeSlug, translit,
} from '../src/seo';

const read = (name: string) => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
const INDEX_HTML = read('index.html');
const NOT_FOUND_HTML = read('404.html');

/** Минимальное окружение: биндинг ASSETS отдаёт файлы из public/. */
function fakeEnv(extra: Partial<Env> = {}): Env {
  return {
    ASSETS: {
      fetch: async (req: Request | string) => {
        const path = new URL(String(typeof req === 'string' ? req : req.url)).pathname;
        const body = path.endsWith('404.html') ? NOT_FOUND_HTML : INDEX_HTML;
        return new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } });
      },
    },
    SITE_URL: 'https://pop-utka.app',
    ...extra,
  } as unknown as Env;
}

function listing(over: Partial<Listing> = {}): Listing {
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
    sourceChat: 'Переслано от Иван',
    sourceChatId: null,
    sourceMessageId: null,
    createdAt: '2026-09-15T07:10:00.000Z',
    publishedAt: '2026-09-15T07:40:00.000Z',
    views: 12,
    ...over,
  } as Listing;
}

describe('слаги городов и маршрутов', () => {
  it('транслит совпадает с уже проиндексированными адресами', () => {
    // если слаги разъедутся, появятся дубли страниц вместо тех, что уже в индексе
    expect(translit('Варшава')).toBe('varshava');
    expect(translit('Киев')).toBe('kiev');
    expect(translit('Харьков')).toBe('harkov');
    expect(translit('Львов')).toBe('lvov');
    expect(translit('Вильнюс')).toBe('vilnyus');
    // «Кёльн» транслитерируется как keln, а проиндексирован адрес /r/varshava-koln:
    // такие пары берёт на себя список SEO_ROUTES, динамические страницы их не дублируют
    expect(translit('Кёльн')).toBe('keln');
    expect(translit('Париж')).toBe('parizh');
    expect(translit('Белосток')).toBe('belostok');
    expect(translit('Катовице')).toBe('katovitse');
    expect(translit('Черновцы')).toBe('chernovtsy');
    expect(translit('Ивано-Франковск')).toBe('ivano-frankovsk');
    expect(translit('Гданьск')).toBe('gdansk');
  });

  it('пробелы, дефисы и мусор не ломают слаг', () => {
    expect(translit('  Санкт Петербург ')).toBe('sankt-peterburg');
    expect(translit('Ростов-на-Дону')).toBe('rostov-na-donu');
    expect(translit('Мытищи 2')).toBe('mytischi-2');
    expect(citySlug('Минск')).toBe('minsk');
    expect(routeSlug('Варшава', 'Минск')).toBe('varshava-minsk');
  });

  it('латиница проходит как есть', () => {
    expect(translit('Warszawa')).toBe('warszawa');
  });
});

describe('JSON-LD и meta-теги', () => {
  it('JSON для <script> не может закрыть тег', () => {
    expect(jsonForScript({ a: '</script><script>alert(1)</script>' })).not.toContain('</script>');
    expect(jsonForScript({ a: '<b>' })).toContain('\\u003c');
  });

  it('хлебные крошки и списки собираются по схеме schema.org', () => {
    const bc = breadcrumbsLd('https://pop-utka.app', [
      { name: 'Доска', path: '/' },
      { name: 'Варшава → Минск', path: '/r/varshava-minsk' },
      { name: '№ b5023c82' },
    ]) as { '@type': string; itemListElement: Array<Record<string, unknown>> };
    expect(bc['@type']).toBe('BreadcrumbList');
    expect(bc.itemListElement).toHaveLength(3);
    expect(bc.itemListElement[0]).toMatchObject({ position: 1, name: 'Доска', item: 'https://pop-utka.app/' });
    expect(bc.itemListElement[2]!.item).toBeUndefined(); // последний элемент без ссылки

    const list = itemListLd('https://x', 'Заявки', [{ path: '/item/1', name: 'Варшава → Минск' }]);
    expect(list).toMatchObject({ '@type': 'ItemList', name: 'Заявки' });
    expect(itemListLd('https://x', 'пусто', [])).toBeNull();

    const faq = faqPageLd([['Это бесплатно?', 'Да.']]) as Record<string, unknown>;
    expect(faq['@type']).toBe('FAQPage');
    expect(faqPageLd([])).toBeNull();
  });

  it('jsonLd отдаёт готовый блок script', () => {
    expect(jsonLd({ '@type': 'WebSite' })).toBe('<script type="application/ld+json">{"@type":"WebSite"}</script>');
  });

  it('headMeta: og-размеры, alt, локаль и robots', () => {
    const head = headMeta({
      title: 'Заголовок', description: 'Описание', canonical: 'https://x/item/1', origin: 'https://x',
      robots: 'noindex, follow', image: 'https://x/og/1.png', imageAlt: 'Карточка',
    });
    expect(head).toContain('<meta name="robots" content="noindex, follow" />');
    expect(head).toContain('<link rel="canonical" href="https://x/item/1" />');
    expect(head).toContain('og:image:width');
    expect(head).toContain('og:image:alt" content="Карточка"');
    expect(head).toContain('og:locale" content="ru_RU"');
    expect(head).toContain('twitter:card" content="summary_large_image"');
  });

  it('атрибуты экранируются', () => {
    const head = headMeta({
      title: 'Он сказал "привет" <b>', description: 'a & b', canonical: 'https://x/', origin: 'https://x',
    });
    expect(head).toContain('&quot;привет&quot;');
    expect(head).not.toContain('<b>');
  });
});

describe('оболочка сайта (renderShell)', () => {
  it('видна только нужная секция', () => {
    const html = setView(INDEX_HTML, 'item');
    expect(html).toContain('<section id="view-item" class="wrap">');
    expect(html).toContain('<section id="view-list" class="wrap board" hidden>');
    expect(html).toMatch(/<section id="view-how"[^>]*hidden>/);
  });

  it('подставляет title, description, canonical, robots и JSON-LD', async () => {
    const html = await renderShell(fakeEnv(), {
      view: 'item',
      title: 'Варшава → Минск · водитель везёт | попутка.',
      description: 'выезд 20 сен · 10 кг',
      canonical: 'https://pop-utka.app/item/1',
      origin: 'https://pop-utka.app',
      robots: 'noindex, follow',
      jsonLd: [{ '@type': 'BreadcrumbList' }, null],
    });
    expect(html).toContain('<title>Варшава → Минск · водитель везёт | попутка.</title>');
    expect(html).toContain('name="description" content="выезд 20 сен · 10 кг"');
    expect(html).toContain('rel="canonical" href="https://pop-utka.app/item/1"');
    expect(html).toContain('name="robots" content="noindex, follow"');
    expect(html).toContain('application/ld+json');
    // старый SEO-блок главной не остаётся: canonical один
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
    expect(html.match(/<title>/g)).toHaveLength(1);
  });

  it('вставляет строки доски и данные для кэша клиента', async () => {
    const items = [listing(), listing({ id: 'cccc1111-2222-3333-4444-555555555555', type: 'request' })];
    const html = await renderShell(fakeEnv(), {
      view: 'list',
      title: 'доска', description: 'd', canonical: 'https://pop-utka.app/', origin: 'https://pop-utka.app',
      listHtml: renderRowsHtml(items), listData: items, total: 2, counts: { offer: 1, request: 1 },
    });
    expect(html).toContain('<div id="list" class="rows" aria-live="polite" data-ssr="1">');
    expect(html).toMatch(/<b id="total-count">2 объявления<\/b>/);
    expect(html).toContain('id="c-offer">(1)</span>');
    expect(html).toContain('window.__SSR__');
    expect(html).toContain('"items":[');
    // дата в шапке заполнена (без JS не будет пустого места)
    expect(html).toMatch(/<span id="today">[А-Я][а-я]+, \d{1,2} [а-я]{3}<\/span>/);
  });

  it('данные в __SSR__ не ломают разметку', async () => {
    const html = await renderShell(fakeEnv(), {
      view: 'item', title: 't', description: 'd', canonical: 'https://x/', origin: 'https://x',
      detailData: listing({ description: '</script><script>alert(1)</script>' }),
      detailHtml: '<p>x</p>',
    });
    const ssr = /window\.__SSR__ = ([^;]*);/.exec(html)?.[1] ?? '';
    expect(ssr).not.toContain('</script>');
    expect(JSON.parse(ssr.replace(/\\u003c/g, '<'))).toMatchObject({ view: 'item' });
  });

  it('серверная карточка помечена: клиент её не перерисовывает', async () => {
    const item = listing();
    const html = await renderShell(fakeEnv(), {
      view: 'item', title: 't', description: 'd', canonical: 'https://x/', origin: 'https://x',
      detailData: item,
      detailHtml: renderDetailHtml(item, { origin: 'https://x' }),
    });
    // data-ssr + data-id: пока открыто то же объявление, app.js оставляет
    // серверный HTML (в нём крошки и «похожие», которых клиент не рисует)
    expect(html).toContain(`<article id="item-detail" data-ssr="1" data-id="${item.id}">`);
    expect(html).toContain('class="crumbs"');
  });

  it('сегодняшняя дата — по МСК', () => {
    expect(todayLine(new Date('2026-09-17T22:00:00Z'))).toBe('Пятница, 18 сен'); // за полночью по МСК
    expect(todayLine(new Date('2026-09-17T06:00:00Z'))).toBe('Четверг, 17 сен');
  });
});

describe('строка доски в SSR', () => {
  it('ссылка ведёт на настоящий адрес карточки', () => {
    const row = renderRowHtml(listing());
    expect(row).toContain('<a class="row-link" href="/item/b5023c82-e043-4863-9fae-ee19a095f211"');
    expect(row).toContain('aria-label="Варшава → Минск: открыть объявление"');
    expect(row).toContain('водитель везёт');
    expect(row).toContain('выезд 20 мая');
    expect(row).toContain('8 кг');
    expect(row).toContain('30 BYN');
    expect(row).toContain('href="https://t.me/ivan_waw"');
    expect(row).toContain('Переслано от Иван');
    expect(row).toContain('№ B502');
  });

  it('архив помечен, запрос — своим штампом', () => {
    expect(renderRowHtml(listing({ status: 'expired' }))).toContain('stamp-expired">архив');
    expect(renderRowHtml(listing({ type: 'request' }))).toContain('ищу передачу');
  });

  it('телефон становится ссылкой tel:, контакт не дублируется', () => {
    const row = renderRowHtml(listing({ telegram: '+48579264254', phone: '+48579264254' }));
    expect(row).toContain('href="tel:+48579264254"');
    expect(row).toContain('позвонить');
    expect(row).not.toContain('t.me/+48');
  });

  it('без контакта — подпись «контакт в карточке»', () => {
    expect(renderRowHtml(listing({ telegram: null, phone: null }))).toContain('контакт в карточке');
  });

  it('HTML в описании экранируется', () => {
    const row = renderRowHtml(listing({ description: '<img src=x onerror=alert(1)>' }));
    expect(row).not.toContain('<img');
    expect(row).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('«открыть» добавляется только когда просят (страницы маршрутов)', () => {
    expect(renderRowHtml(listing())).not.toContain('>открыть</a>');
    expect(renderRowHtml(listing(), { openLink: true })).toContain('href="/item/b5023c82-e043-4863-9fae-ee19a095f211">открыть</a>');
  });

  it('источник: чат со ссылкой для супергрупп, иначе текст', () => {
    expect(sourceLabel(listing({ sourceChat: 'Переслано от Иван' }))).toBe('Переслано от Иван');
    expect(sourceLabel(listing({ sourceChat: 'Варшава Минск чат' }))).toBe('из чата «Варшава Минск чат»');
    expect(sourceLabel(listing({ source: 'site', sourceChat: null }))).toBe('с сайта');
    const row = renderRowHtml(listing({ sourceChatId: '-1001234567890', sourceMessageId: 42, sourceChat: null }));
    expect(row).toContain('href="https://t.me/c/1234567890/42"');
  });
});

describe('карточка в SSR', () => {
  it('хлебные крошки, данные и действия', () => {
    const html = renderDetailHtml(listing(), {
      origin: 'https://pop-utka.app',
      routePath: '/r/varshava-minsk',
      related: [listing({ id: 'cccc1111-2222-3333-4444-555555555555' })],
    });
    expect(html).toContain('<nav class="crumbs"');
    expect(html).toContain('href="/r/varshava-minsk">Варшава → Минск</a>');
    expect(html).toContain('№ b5023c82');
    expect(html).toContain('<h1 class="d-route">Варшава <span class="r-arrow">→</span> Минск</h1>');
    expect(html).toContain('Еду в субботу утром');
    expect(html).toContain('data-report="b5023c82');
    expect(html).toContain('data-copy="b5023c82');
    expect(html).toContain('Ещё по этому маршруту');
    expect(html).toContain('написать @ivan_waw');
  });

  it('архив: предупреждение вместо призыва договариваться', () => {
    const html = renderDetailHtml(listing({ status: 'expired' }), { origin: 'https://x' });
    expect(html).toContain('заявка в архиве');
    expect(html).toContain('stamp-expired');
  });

  it('без страницы маршрута крошки короче', () => {
    const html = renderDetailHtml(listing(), { origin: 'https://x' });
    expect(html).not.toContain('/r/');
    expect(html).toContain('<a href="/">Доска</a>');
  });
});

describe('маршруты SPA и разделы', () => {
  it('isAppPath отделяет SPA от серверных страниц', () => {
    for (const p of ['/', '/new', '/how', '/bot', '/terms', '/privacy', '/admin', '/item/abc', '/item/abc/']) {
      expect(isAppPath(p), p).toBe(true);
    }
    for (const p of ['/r/varshava-minsk', '/routes', '/gorod/minsk', '/itogi', '/api/listings', '/styles.css', '/og/x.png']) {
      expect(isAppPath(p), p).toBe(false);
    }
  });

  it('все разделы описаны и админка закрыта от индекса', () => {
    expect(Object.keys(STATIC_PAGES).sort()).toEqual(['/admin', '/bot', '/how', '/new', '/privacy', '/terms']);
    expect(STATIC_PAGES['/admin']!.robots).toBe('noindex, nofollow');
    for (const [path, page] of Object.entries(STATIC_PAGES)) {
      expect(page.title, path).toBeTruthy();
      expect(page.description.length, path).toBeGreaterThan(60);
    }
  });

  it('вопросы-ответы берутся из настоящей разметки раздела', () => {
    const faq = extractFaq(INDEX_HTML, 'how');
    expect(faq.length).toBeGreaterThanOrEqual(3);
    expect(faq[0]![0]).toContain('бесплатно');
    expect(faq[0]![1]).toContain('Да.');
    expect(extractFaq(INDEX_HTML, 'admin')).toEqual([]);
  });

  it('origin — из SITE_URL, иначе из запроса', () => {
    expect(siteOrigin(fakeEnv(), 'http://127.0.0.1:8788/')).toBe('https://pop-utka.app');
    expect(siteOrigin(fakeEnv({ SITE_URL: undefined }), 'http://127.0.0.1:8788/how')).toBe('http://127.0.0.1:8788');
    expect(siteOrigin(fakeEnv({ SITE_URL: 'https://x/' }), 'http://y/')).toBe('https://x');
  });
});

describe('заголовки карточки', () => {
  it('title и description для поиска и превью', () => {
    const l = listing();
    expect(itemTitle(l, false)).toBe('Варшава → Минск · водитель везёт | попутка.');
    expect(itemTitle(l, true)).toContain('· архив');
    expect(itemTitle(listing({ type: 'request' }), false)).toContain('нужно передать');
    const d = itemDescription(l);
    expect(d).toContain('выезд 20 мая');
    expect(d).toContain('10 кг');
    expect(d).toContain('Еду в субботу утром');
    expect(itemDescription(listing({ departureDate: null, weightKg: null, price: null }))).not.toContain('выезд');
  });

  it('длинные описания режутся до 180 символов', () => {
    expect(itemDescription(listing({ description: 'а'.repeat(400) })).length).toBeLessThan(240);
  });
});

describe('архив и контакты', () => {
  it('заявка с прошедшей датой — архив, даже если статус published', () => {
    expect(isArchived(listing({ departureDate: '2020-01-01' }))).toBe(true);
    expect(isArchived(listing({ status: 'expired' }))).toBe(true);
    expect(isArchived(listing({ departureDate: '2099-01-01' }))).toBe(false);
    expect(isArchived(listing({ departureDate: null }))).toBe(false);
  });

  it('контакт нормализуется так же, как на клиенте', () => {
    expect(contactOf(listing())).toMatchObject({ kind: 'telegram', href: 'https://t.me/ivan_waw', label: '@ivan_waw' });
    expect(contactOf(listing({ telegram: null, phone: '+375 29 123 45 67' }))).toMatchObject({ kind: 'phone' });
    expect(contactOf(listing({ telegram: null, phone: null }))).toBeNull();
  });
});

describe('страница 404', () => {
  it('есть в public/ и не индексируется', () => {
    expect(NOT_FOUND_HTML).toContain('name="robots" content="noindex, follow"');
    expect(NOT_FOUND_HTML).toContain('href="/routes"');
    expect(NOT_FOUND_HTML).toContain('href="/gorod/varshava"');
    expect(NOT_FOUND_HTML).toContain('<!--404_MESSAGE-->');
    expect(NOT_FOUND_HTML).not.toContain('href="#/');
  });
});
