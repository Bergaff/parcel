/**
 * Edge-кэш (caches.default): публичные страницы сайта кладём на узлы Cloudflare.
 *
 * Зачем: воркер отвечает быстро, но каждый запрос страницы — это походы в D1
 * (список заявок, счётчики, чаты-источники) и рендер HTML. Ответы Cloudflare
 * по умолчанию не кэширует: HTML без расширения мимо кэша CDN, а `s-maxage`
 * без «Cache Everything» (правило на весь домен рискованное) не работает.
 * Cache API — точечный и честный вариант: кладём сами только те адреса,
 * которые для всех одинаковые.
 *
 * Отрицательное кэширование: 404 (несуществующая карточка, опечатка в слаге
 * маршрута) тоже кладём в кэш — боты и люди любят дёргать несуществующие
 * адреса по много раз, незачем на каждый ходить в D1.
 *
 * Что НЕ кэшируем (см. edgeCacheTtl):
 *  - всё с query-параметрами: фильтры доски динамические и noindex;
 *  - /admin и /api/*: личное и живое;
 *  - ответы с no-store (архивные карточки, фильтры) — уважаем handler.
 */

/**
 * Кэш колокации: caches.default. В WebWorker-типах этого свойства нет
 * (оно из runtime-типов Cloudflare), поэтому достаём с аккуратным кастом.
 * Работает только на кастомном домене/маршруте — на workers.dev молча пуст.
 */
export function edgeCache(): Cache {
  return (caches as unknown as { default: Cache }).default;
}

/** TTL кэша для 200-ответов, секунды. null — адрес не кэшируем. */
export function edgeCacheTtl(pathname: string, hasQuery: boolean): number | null {
  if (hasQuery) return null;
  if (pathname === '/') return 60;
  if (pathname === '/routes' || pathname === '/gorod') return 3600;
  if (pathname === '/itogi') return 1800;
  if (pathname.startsWith('/itogi/')) return 3600;
  if (pathname.startsWith('/r/')) return 600;
  if (pathname.startsWith('/gorod/')) return 600;
  if (pathname.startsWith('/item/')) return 300;
  if (pathname.startsWith('/og/') || pathname.startsWith('/og-route/')) return 86400;
  if (
    pathname === '/how' || pathname === '/bot' || pathname === '/new' ||
    pathname === '/terms' || pathname === '/privacy'
  ) return 3600;
  if (pathname === '/sitemap.xml' || pathname === '/sitemap-pages.xml') return 3600;
  if (pathname === '/sitemap-routes.xml' || pathname === '/sitemap-items.xml') return 1800;
  return null; // /admin, /api/*, /og-debug и всё прочее — мимо кэша
}

/**
 * TTL для 404-ответа (отрицательное кэширование).
 * Карточки — коротко: заявку может одобрить модератор, и ссылка заработает;
 * несуществующие маршруты/города — 15 минут, как обычное отрицательное кэширование.
 */
export function negativeTtl(pathname: string): number {
  if (pathname.startsWith('/item/')) return 300;
  return 900;
}

/**
 * Ключ кэша: origin + путь, без query. Страницы от query не зависят
 * (зависящие мы в кэш не пускаем), а лишние параметры (utm, ?x=) плодили бы
 * записи в кэше на каждый спам-запрос.
 */
export function edgeCacheKey(url: URL): Request {
  return new Request(url.origin + url.pathname, { method: 'GET' });
}

/** Можно ли класть этот ответ в кэш: 200/404 и без no-store/private. */
export function cacheableStatus(status: number, cacheControl: string | null): boolean {
  if (status !== 200 && status !== 404) return false;
  const cc = (cacheControl ?? '').toLowerCase();
  return !cc.includes('no-store') && !cc.includes('private') && !cc.includes('no-cache');
}

/** Заголовок Cache-Control для ответа, который кладём в кэш. */
export function edgeCacheControl(pathname: string, status: number, ttl: number): string {
  const s = status === 404 ? negativeTtl(pathname) : ttl;
  return `public, max-age=0, s-maxage=${s}`;
}
