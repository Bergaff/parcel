/**
 * Edge-кэш публичных страниц: правила TTL, отрицательное кэширование 404
 * и построение ключа. Само чтение/запись caches.default проверяет смоук
 * локального воркера (второй запрос обязан прийти с x-poputka-edge: hit).
 */
import { describe, expect, it } from 'vitest';

import {
  cacheableStatus, edgeCacheControl, edgeCacheKey, edgeCacheTtl, negativeTtl,
} from '../src/edge-cache';

describe('что попадает в edge-кэш', () => {
  it('публичные страницы кэшируются, живое и личное — нет', () => {
    expect(edgeCacheTtl('/', false)).toBe(60);
    expect(edgeCacheTtl('/routes', false)).toBe(3600);
    expect(edgeCacheTtl('/gorod', false)).toBe(3600);
    expect(edgeCacheTtl('/r/varshava-minsk', false)).toBe(600);
    expect(edgeCacheTtl('/gorod/grodno', false)).toBe(600);
    expect(edgeCacheTtl('/item/abc', false)).toBe(300);
    expect(edgeCacheTtl('/itogi', false)).toBe(1800);
    expect(edgeCacheTtl('/itogi/2026-09', false)).toBe(3600);
    expect(edgeCacheTtl('/how', false)).toBe(3600);
    expect(edgeCacheTtl('/bot', false)).toBe(3600);
    expect(edgeCacheTtl('/new', false)).toBe(3600);
    expect(edgeCacheTtl('/terms', false)).toBe(3600);
    expect(edgeCacheTtl('/privacy', false)).toBe(3600);
    expect(edgeCacheTtl('/sitemap.xml', false)).toBe(3600);
    expect(edgeCacheTtl('/sitemap-items.xml', false)).toBe(1800);
    expect(edgeCacheTtl('/og/abc.png', false)).toBe(86400);
    expect(edgeCacheTtl('/og-route/varshava-minsk.png', false)).toBe(86400);

    // личное, живое и диагностическое — мимо кэша
    expect(edgeCacheTtl('/admin', false)).toBeNull();
    expect(edgeCacheTtl('/api/listings', false)).toBeNull();
    expect(edgeCacheTtl('/og-debug/abc', false)).toBeNull();
    expect(edgeCacheTtl('/styles.css', false)).toBeNull();
  });

  it('страница с query-параметрами не кэшируется (фильтры доски)', () => {
    expect(edgeCacheTtl('/', true)).toBeNull();
    expect(edgeCacheTtl('/?from=Варшава&to=Минск', true)).toBeNull();
    expect(edgeCacheTtl('/r/varshava-minsk', true)).toBeNull();
  });
});

describe('отрицательное кэширование 404', () => {
  it('несуществующие маршруты помнят 15 минут, карточки — 5', () => {
    expect(negativeTtl('/r/netu')).toBe(900);
    expect(negativeTtl('/gorod/netu')).toBe(900);
    expect(negativeTtl('/itogi/2099-01')).toBe(900);
    // карточка может появиться после модерации — 404 держим недолго
    expect(negativeTtl('/item/eeee0000')).toBe(300);
  });

  it('Cache-Control для 404 берёт отрицательный TTL, для 200 — обычный', () => {
    expect(edgeCacheControl('/r/netu', 404, 600)).toBe('public, max-age=0, s-maxage=900');
    expect(edgeCacheControl('/item/x', 404, 300)).toBe('public, max-age=0, s-maxage=300');
    expect(edgeCacheControl('/r/varshava-minsk', 200, 600)).toBe('public, max-age=0, s-maxage=600');
  });
});

describe('ключ кэша', () => {
  it('без query: utm-хвосты не плодят записи в кэше', () => {
    const key = edgeCacheKey(new URL('https://pop-utka.app/r/varshava-minsk?utm_source=telegram'));
    expect(key.url).toBe('https://pop-utka.app/r/varshava-minsk');
    expect(key.method).toBe('GET');
  });

  it('метод GET — иначе Cache API не примет', () => {
    expect(edgeCacheKey(new URL('https://pop-utka.app/')).method).toBe('GET');
  });
});

describe('какие ответы можно класть', () => {
  it('только 200 и 404, и только без запрета кэширования', () => {
    expect(cacheableStatus(200, 'public, max-age=0, s-maxage=600')).toBe(true);
    expect(cacheableStatus(404, 'public, max-age=0, s-maxage=900')).toBe(true);
    expect(cacheableStatus(200, 'no-store')).toBe(false);
    expect(cacheableStatus(200, 'private, max-age=60')).toBe(false);
    expect(cacheableStatus(200, 'no-cache, s-maxage=600')).toBe(false);
    expect(cacheableStatus(301, 'public, max-age=3600')).toBe(false);
    expect(cacheableStatus(500, 'public')).toBe(false);
  });
});
