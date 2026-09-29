/**
 * SEO-видимость: чистые функции разбора ответов Common Crawl, Wayback CDX
 * и SerpApi — без сети, на фикстурах.
 */
import { describe, expect, it } from 'vitest';

import {
  findOwnPosition,
  hostnameOf,
  isOwnHost,
  parseCdxRows,
  parseCcIndex,
  serpApiUrl,
  siteDomain,
} from '../src/seo-watch';

describe('домен сайта', () => {
  it('siteDomain: из SITE_URL, без www и слэшей', () => {
    expect(siteDomain('https://pop-utka.app/')).toBe('pop-utka.app');
    expect(siteDomain('https://www.pop-utka.app')).toBe('pop-utka.app');
    expect(siteDomain('pop-utka.app/x')).toBe('pop-utka.app');
    expect(siteDomain(undefined)).toBe('');
  });

  it('isOwnHost: точное совпадение и поддомены, чужие — нет', () => {
    expect(isOwnHost('pop-utka.app', 'pop-utka.app')).toBe(true);
    expect(isOwnHost('www.pop-utka.app', 'pop-utka.app')).toBe(true);
    expect(isOwnHost('m.pop-utka.app', 'pop-utka.app')).toBe(true);
    expect(isOwnHost('not-pop-utka.app', 'pop-utka.app')).toBe(false);
    expect(isOwnHost('', 'pop-utka.app')).toBe(false);
  });

  it('hostnameOf переживает мусор', () => {
    expect(hostnameOf('https://pop-utka.app/item/abc')).toBe('pop-utka.app');
    expect(hostnameOf('не ссылка')).toBe('');
    expect(hostnameOf(null)).toBe('');
  });
});

describe('Common Crawl: разбор индекса', () => {
  it('NDJSON: уникальные URL, дубли и битые строки не путают счёт', () => {
    const text = [
      JSON.stringify({ url: 'https://pop-utka.app/', status: '200' }),
      JSON.stringify({ url: 'https://pop-utka.app/', status: '200' }), // тот же URL второй захват
      JSON.stringify({ url: 'https://pop-utka.app/r/varshava-minsk', status: '200' }),
      '{битая строка',
      '',
      JSON.stringify({ url: 'https://pop-utka.app/gorod/brest', status: '301' }),
    ].join('\n');
    const { captures, urls } = parseCcIndex(text);
    expect(captures).toBe(4); // битая и пустая строки не считаются
    expect(urls).toEqual([
      'https://pop-utka.app/',
      'https://pop-utka.app/gorod/brest',
      'https://pop-utka.app/r/varshava-minsk',
    ]);
  });

  it('пустой ответ — ноль страниц', () => {
    expect(parseCcIndex('')).toEqual({ captures: 0, urls: [] });
  });
});

describe('Wayback CDX: разбор', () => {
  it('строки снимков, заголовок отбрасывается, свежая дата находится', () => {
    const rows = [
      ['timestamp', 'original'], // заголовок output=json
      ['20260901120000', 'https://pop-utka.app/'],
      ['20260920183000', 'https://pop-utka.app/routes'],
      ['мусор', 'https://pop-utka.app/'],
      ['20260905090000', 'https://pop-utka.app/'],
    ];
    const { urls, lastSnapshot } = parseCdxRows(rows);
    expect(urls).toEqual(['https://pop-utka.app/', 'https://pop-utka.app/routes']);
    expect(lastSnapshot).toBe('2026-09-20');
  });

  it('не массив — пустой результат', () => {
    expect(parseCdxRows(null)).toEqual({ urls: [], lastSnapshot: null });
    expect(parseCdxRows({ error: 'x' })).toEqual({ urls: [], lastSnapshot: null });
  });
});

describe('SerpApi: позиция своего сайта', () => {
  const domain = 'pop-utka.app';

  it('наш сайт в органике — позиция и ссылка', () => {
    const organic = [
      { position: 1, link: 'https://bla.example/x' },
      { position: 2, link: 'https://foo.example/y' },
      { position: 3, link: 'https://pop-utka.app/' },
    ];
    expect(findOwnPosition(organic, domain)).toEqual({
      position: 3,
      url: 'https://pop-utka.app/',
      top: ['bla.example', 'foo.example', 'pop-utka.app'],
    });
  });

  it('yandex-стиль (поле url, без position) и www-поддомен', () => {
    const organic = [
      { url: 'https://www.example.by/a' },
      { url: 'https://www.pop-utka.app/r/varshava-minsk' },
    ];
    expect(findOwnPosition(organic, domain).position).toBe(2);
  });

  it('нет в топе — null, но топ-5 конкурентов собираем', () => {
    const organic = [1, 2, 3, 4, 5, 6].map((i) => ({ link: `https://site${i}.example/` }));
    const m = findOwnPosition(organic, domain);
    expect(m.position).toBeNull();
    expect(m.url).toBeNull();
    expect(m.top).toHaveLength(5);
  });
});

describe('SerpApi: URL запроса', () => {
  it('google: ru, Беларусь, топ-20', () => {
    const u = serpApiUrl('google', 'передать посылку варшава минск', 'KEY');
    expect(u).toContain('engine=google');
    expect(u).toContain('hl=ru');
    expect(u).toContain('gl=by');
    expect(u).toContain('num=20');
    expect(u).toContain(encodeURIComponent('передать посылку варшава минск'));
    expect(u).toContain('api_key=KEY');
  });

  it('yandex: Минск (lr=157)', () => {
    const u = serpApiUrl('yandex', 'попутка', 'KEY');
    expect(u).toContain('engine=yandex');
    expect(u).toContain('lr=157');
  });
});
