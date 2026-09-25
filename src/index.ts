import { Hono } from 'hono';
import type { Env, ListingInput, ListingType } from './types';
import { normalizeCity, parseRecurring } from './parser';
import { addReport, archiveExpired, createListing, createListingSafe, deleteListing, deleteListings, deleteMatchRun, findDuplicate, listForDuplicateSweep, ensureChatLinksTable, findRelated, getChatLinks, isAdminOrigin, isHiddenRequestInput, listDailyStats, listMostViewed, isPersonOrigin, loadStatsSnapshots, pruneStalePending, relatedListings, getCounts, getListingById, getMatchRun, listAdminBoard, listForMatching, listMatchRuns, listListings, listSourceChats, saveMatchRun, updateListing, updateListingStatus, upsertChatLink } from './store';
import { getIp, rateLimit, sanitizeCity, sanitizeText, escapeHtml, hasContactHint, isRussianCity, mskTodayIso, normalizeContacts } from './util';
import { groupDuplicates } from './dedupe';
import { contactKeyOf, filterHiddenPairs, formatMatchDigest, listingSnapshot, loadHiddenContacts, pairListings, setHiddenContacts } from './match';
import { handleTelegramUpdate, notifyAdmins, notifyAdminsConflict, notifyAdminsDigest, notifyAdminsHiddenRequest, notifyAdminsReport } from './telegram';
import { renderOgImage, renderRouteOg } from './og';
import { cacheableStatus, edgeCache, edgeCacheControl, edgeCacheKey, edgeCacheTtl } from './edge-cache';
import {
  buildCitiesIndexPage, buildCityPage, buildItemsSitemap, buildPagesSitemap,
  buildRoutePage, buildRoutesIndexPage, buildRoutesSitemap, buildSitemapXml,
  cityOgSpec, cityPathFor, resolveCity, resolveRoute, resolveRouteAlias, routeOgSpec, routePathFor,
} from './seo-routes';
import { buildHomePage, buildItemPage, buildNotFoundPage, buildStaticPage, buildStatsPage, buildMonthStatsPage, siteOrigin, STATIC_PAGES } from './pages';
import { currentPeriod } from './format';
import { aggregateDaily, listMonthStats, refreshStats, regenerateMonthSummary, statsPostText } from './stats';

const app = new Hono<{ Bindings: Env }>();

/* ---------------------- CORS для Pages -> Worker -------------- */
/* Нужно, когда страница на Pages (pages.dev или свой домен),
   а API и бот на отдельном воркере (workers.dev или поддомен). */

app.use('/api/*', async (c, next) => {
  const origin = c.req.header('Origin') ?? '';
  if (origin) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Vary', 'Origin');
    c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    c.header('Access-Control-Max-Age', '86400');
  }
  if (c.req.method === 'OPTIONS') {
    // Важно: c.body(), а не new Response() — иначе заголовки, установленные
    // через c.header(), не попадут в ответ, и браузер заблокирует запрос (CORS).
    return c.body(null, 204);
  }
  await next();
});

/* ---------------- Edge-кэш публичных страниц ---------------- */
/* caches.default — кэш колокации Cloudflare: главная, каталоги, карточки,
   sitemap и OG-картинки отдаются без похода в D1, 404-е тоже запоминаем
   (отрицательное кэширование — боты любят дёргать несуществующие адреса).
   Правила и TTL — src/edge-cache.ts. Живое и личное (API, админка, фильтры
   доски, OG-диагностика) в кэш не попадает никогда. Заголовок x-poputka-edge
   показывает, откуда ответ: miss — воркер рендерил, hit — отдали из кэша. */
app.use('*', async (c, next) => {
  if (c.req.method !== 'GET') return next();
  const url = new URL(c.req.url);
  const ttl = edgeCacheTtl(url.pathname, url.search !== '');
  if (ttl == null) return next();

  const cache = edgeCache();
  const key = edgeCacheKey(url);
  const hit = await cache.match(key);
  if (hit) {
    const headers = new Headers(hit.headers);
    headers.set('x-poputka-edge', 'hit');
    return new Response(hit.body, { status: hit.status, headers });
  }

  await next();
  const res = c.res;
  // no-store/private (архивные карточки, фильтры) — уважаем обработчик
  if (!cacheableStatus(res.status, res.headers.get('Cache-Control'))) return;

  const headers = new Headers(res.headers);
  headers.set('Cache-Control', edgeCacheControl(url.pathname, res.status, ttl));
  headers.set('x-poputka-edge', 'miss');
  const body = await res.arrayBuffer();
  // Hono при подмене c.res переносит заголовки старого ответа в новый (включая
  // его Cache-Control) — поэтому итоговое значение ставим ещё раз через
  // c.header уже после подмены, иначе победит вариант обработчика
  c.res = new Response(body, { status: res.status, headers });
  try {
    c.header('Cache-Control', headers.get('Cache-Control')!);
  } catch {
    /* заголовки неизменяемые — оставляем как есть */
  }
  c.executionCtx.waitUntil(
    cache.put(key, new Response(body, { status: res.status, headers }))
      .catch((e) => console.error('edge cache put failed', e))
  );
});

/* ---------------------------- Meta ---------------------------- */

app.get('/api/health', (c) => c.json({ ok: true, time: new Date().toISOString() }));

app.get('/api/config', (c) => {
  return c.json({
    siteName: 'Попутная',
    botUsername: c.env.BOT_USERNAME ?? null,
    botLink: c.env.BOT_USERNAME ? `https://t.me/${c.env.BOT_USERNAME}` : null,
  });
});

/* ------------------------- Telegram webhook ------------------- */

app.post('/api/telegram/:secret', async (c) => {
  const secret = c.req.param('secret');
  if (!c.env.BOT_SECRET || secret !== c.env.BOT_SECRET) {
    return c.json({ ok: false }, 403);
  }
  const update = await c.req.json().catch(() => null);
  if (!update) return c.json({ ok: false }, 400);
  const result = await handleTelegramUpdate(c.env, update);
  // Telegram требует ответить 200 как можно быстрее.
  return c.json({ ok: result.ok });
});

/* ------------------------- Listings API ----------------------- */

/** Расписание регулярного рейса из формы («каждый четверг») — короткая
 *  каноническая подпись или null, если поле пустое/мусорное. */
function sanitizeRecurring(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const label = raw.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 40);
  if (label.length < 3) return null;
  return parseRecurring(label) ?? label;
}

/** Валидация входящего объявления с сайта/внешнего источника. */
function validateListing(body: unknown): { input?: ListingInput; error?: string } {
  const b = (body ?? {}) as Record<string, unknown>;

  const type = b.type;
  if (type !== 'offer' && type !== 'request') return { error: 'type должен быть offer или request' };

  // Города приводим к каноническому написанию (warsawa/Warsaw/Варшаве → Варшава),
  // чтобы одинаковые маршруты с сайта и из чатов совпадали в поиске.
  const fromCity = b.fromCity ? normalizeCity(sanitizeCity(b.fromCity) ?? '') : null;
  const toCity = b.toCity ? normalizeCity(sanitizeCity(b.toCity) ?? '') : null;
  if (!fromCity || !toCity || fromCity.length < 2 || toCity.length < 2) return { error: 'fromCity и toCity обязательны' };

  // Города — только по-русски: аудитория русскоязычная, а при разнобое написаний
  // поиск по доске перестаёт сходиться. Известные латинские написания (Warsaw)
  // normalizeCity уже перевёл в «Варшаву»; незнакомые просим написать кириллицей.
  if (!isRussianCity(fromCity) || !isRussianCity(toCity)) {
    return { error: 'Названия городов пишите по-русски, кириллицей: «Варшава», а не Warsaw' };
  }

  const description = sanitizeText(b.description, 2000, 'description');
  if (!description || description.length < 5) return { error: 'description обязательна (от 5 символов)' };

  let departureDate: string | null = null;
  if (b.departureDate != null && b.departureDate !== '') {
    if (typeof b.departureDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.departureDate)) {
      return { error: 'departureDate в формате YYYY-MM-DD' };
    }
    departureDate = b.departureDate;
  }

  let weightKg: number | null = null;
  if (b.weightKg != null && b.weightKg !== '') {
    weightKg = Number(b.weightKg);
    if (!Number.isFinite(weightKg) || weightKg <= 0 || weightKg > 1000) {
      return { error: 'weightKg должен быть числом от 0 до 1000' };
    }
  }

  const price = (typeof b.price === 'string' && b.price.trim().length > 0)
    ? b.price.trim().slice(0, 40)
    : null;

  // «каждый четверг» — необязательное расписание регулярного рейса
  const recurring = sanitizeRecurring(b.recurring);

  // Контакты раскладываем по полям: номер, вписанный в «Telegram», уедет в phone,
  // юзернейм из phone — в telegram, один и тот же контакт дважды не сохранится
  const { telegram, phone } = normalizeContacts(b.telegram, b.phone);

  return {
    input: {
      type: type as ListingType,
      fromCity,
      toCity,
      departureDate,
      recurring,
      weightKg,
      price,
      description,
      phone,
      telegram,
      status: 'pending', // сайт всегда через модерацию (или AUTO_APPROVE)
      source: 'site',
    },
  };
}

app.get('/api/listings', async (c) => {
  const url = new URL(c.req.url);
  const typeRaw = url.searchParams.get('type');
  const type = typeRaw === 'offer' || typeRaw === 'request' ? typeRaw : undefined;
  // Поиск по доске понимает и латиницу: «warsaw» → «Варшава»
  const fromRaw = url.searchParams.get('from');
  const from = fromRaw ? (normalizeCity(fromRaw).trim() || undefined) : undefined;
  const toRaw = url.searchParams.get('to');
  const to = toRaw ? (normalizeCity(toRaw).trim() || undefined) : undefined;
  const date = url.searchParams.get('date') ?? undefined;
  const q = url.searchParams.get('q') ?? undefined;
  const archive = url.searchParams.get('archive') === '1';
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const { items, hasMore } = await listListings(c.env, { type, from, to, date, q, page, archive });
  const counts = await getCounts(c.env, { from, to, date, q, archive });
  return c.json({ items, hasMore, page, total: counts.offer + counts.request, counts });
});

app.get('/api/listings/:id', async (c) => {
  const id = c.req.param('id');
  const listing = await getListingById(c.env, id, { hitView: true });
  // Архивные ('expired') заявки остаются доступны по ссылке:
  // месяц после даты выезда по ним ещё можно написать автору.
  if (!listing || (listing.status !== 'published' && listing.status !== 'expired')) {
    return c.json({ error: 'not_found' }, 404);
  }
  // Вместе с заявкой отдаём то, из чего сервер собрал карточку: пути для хлебных
  // крошек и похожие заявки. Клиент рисует их сам, когда объявление открыли
  // кликом с доски, — карточка не «беднеет» после перехода.
  const [related, routePath] = await Promise.all([
    relatedListings(c.env, listing),
    routePathFor(c.env, listing.fromCity, listing.toCity),
  ]);
  return c.json({ item: listing, related, routePath, cityPath: cityPathFor(listing.fromCity) });
});

app.post('/api/listings', async (c) => {
  const ip = getIp(c);
  const rl = await rateLimit(c.env, `post:${ip}`, 10, 3600);
  if (!rl.allowed) return c.json({ error: 'too_many_requests' }, 429);

  const body = await c.req.json().catch(() => null);
  const { input, error } = validateListing(body);
  if (error || !input) return c.json({ error }, 400);

  // Кто подаёт: админ (форма с ключом админки в этом же браузере) или
  // посторонний человек. Для человека дубль не сливаем: возможно, это владелец
  // рейса подал сам, а копию раньше принёс админ из чата — заявку человека
  // создаём отдельной, конфликт показываем модератору и в Telegram.
  const auth = c.req.header('Authorization') ?? '';
  const isAdminSubmit = !!c.env.ADMIN_API_TOKEN && auth === `Bearer ${c.env.ADMIN_API_TOKEN}`;
  input.byAdmin = isAdminSubmit;
  input.fromPerson = !isAdminSubmit;
  // Водитель («могу передать») без контакта — отбойник: заявка бесполезна,
  // писать водителю некуда. Контакт в описании (телефон или @юзернейм) считаем
  // за контакт — модератор перенесёт его в поле. Отклоняем сразу, до создания.
  if (input.type === 'offer' && !input.telegram && !input.phone && !hasContactHint(input.description)) {
    return c.json(
      { error: 'В заявке водителя нужен контакт: telegram или телефон — в поле контакта или прямо в описании. Иначе пассажирам не с кем связаться.' },
      400
    );
  }

  // «Ищу попутчика» с сайта без контакта: публикуем сразу, но прячем с доски —
  // человек уже никогда не вернётся за статусом, а владелец напишет ему сам.
  // На доске такие не показываются, только в подборе (см. isHiddenRequestInput).
  const autoHidden = isHiddenRequestInput(input);
  if (autoHidden) {
    input.status = 'published';
    input.hidden = true;
  } else {
    input.status = c.env.AUTO_APPROVE === '1' ? 'published' : 'pending';
  }
  const res = await createListingSafe(c.env, input, { force: !isAdminSubmit });
  const listing = res.listing;

  if (!res.created) {
    return c.json({
      item: listing,
      duplicate: true,
      message: listing.status === 'published'
        ? 'Такое объявление уже есть на доске — второе создавать не стали, ваше снова вверху списка.'
        : 'Такое объявление уже отправлено на модерацию — вторую заявку создавать не стали.',
    });
  }

  // Если объявление ушло на модерацию, тут же шлём его администратору в Telegram
  // с кнопками «Одобрить / Отклонить» (см. notifyAdmins в src/telegram.ts).
  if (listing.status === 'pending') {
    const similar = res.duplicateOf
      ? { id: res.duplicateOf.id, why: res.why, selfSubmitted: !isAdminSubmit }
      : null;
    c.executionCtx.waitUntil(
      notifyAdmins(c.env, listing, similar).catch((e) => console.error('notifyAdmins failed', e))
    );
  } else if (res.duplicateOf && !isAdminSubmit) {
    // автопубликация: карточки модерации нет, но о конфликте всё равно скажем
    c.executionCtx.waitUntil(
      notifyAdminsConflict(c.env, listing, res.duplicateOf, res.why)
        .catch((e) => console.error('notifyAdminsConflict failed', e))
    );
  }

  if (autoHidden) {
    // владельцу — сразу в Telegram: он пишет людям сам
    c.executionCtx.waitUntil(
      notifyAdminsHiddenRequest(c.env, listing).catch((e) => console.error('notifyAdminsHiddenRequest failed', e))
    );
    return c.json(
      {
        item: listing,
        hidden: true,
        message: 'Заявка принята: подбираем попутчика по вашему маршруту. Как найдём — объявление появится на доске.',
      },
      201
    );
  }

  return c.json(
    {
      item: listing,
      message: (input.status === 'published'
        ? 'Объявление опубликовано.'
        : 'Объявление отправлено на модерацию и появится после проверки.')
        + (res.duplicateOf && !isAdminSubmit
          ? ' Похожая заявка уже была — модератор посмотрит и решит, какую оставить.'
          : ''),
    },
    input.status === 'published' ? 201 : 202
  );
});

app.post('/api/listings/:id/report', async (c) => {
  const id = c.req.param('id');
  const ip = getIp(c);
  const rl = await rateLimit(c.env, `report:${ip}`, 5, 3600);
  if (!rl.allowed) return c.json({ error: 'too_many_requests' }, 429);
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null;
  const res = await addReport(c.env, id, reason, ip);
  if (!res.ok) return c.json({ error: 'not_found' }, 404);

  // Каждая жалоба — сразу в Telegram администраторам, с кнопкой «Скрыть».
  const listing = await getListingById(c.env, id);
  if (listing) {
    c.executionCtx.waitUntil(
      notifyAdminsReport(c.env, listing, reason, res.count)
        .catch((e) => console.error('notifyAdminsReport failed', e))
    );
  }

  return c.json({ ok: true, message: res.autoRejected ? 'Объявление скрыто модерацией.' : 'Жалоба принята, спасибо.' });
});

/* ---------------------- Страницы сайта (SSR) ---------------------- */
/* Доска — SPA, но отдаёт её воркер уже с контентом в HTML: строки на главной,
   карточка объявления, текстовые разделы. Без этого поисковик видит пустой
   <div id="list"> и страницы за «#», которых для него не существует. */

app.get('/', async (c) => {
  const origin = siteOrigin(c.env, c.req.url);
  const page = await buildHomePage(c.env, origin, new URL(c.req.url));
  c.header('Cache-Control', page.cacheControl ?? 'no-store');
  return c.html(page.html);
});

/* «Как это работает», бот, условия, приватность, форма, админка */
for (const path of Object.keys(STATIC_PAGES)) {
  app.get(path, async (c) => {
    const origin = siteOrigin(c.env, c.req.url);
    const page = await buildStaticPage(c.env, origin, path);
    if (!page) return c.notFound();
    c.header('Cache-Control', page.cacheControl ?? 'no-store');
    return c.html(page.html);
  });
}

/* Карточка объявления: контент целиком в HTML (раньше — пустышка с мгновенным
   location.replace на #/item/…), свои title/description/canonical, OG-картинка
   и JSON-LD. Снятые и непубликованные заявки — честный 404 вместо 302 на главную
   (soft-404 и утечка ссылочного веса). Просмотр засчитывает API-запрос клиента. */
app.get('/item/:id', async (c) => {
  const origin = siteOrigin(c.env, c.req.url);
  const page = await buildItemPage(c.env, origin, c.req.param('id'), {
    routePath: (from, to) => routePathFor(c.env, from, to),
    cityPath: (city) => cityPathFor(city),
  });
  if (!page) {
    const nf = await buildNotFoundPage(c.env, origin, 'Объявление снято с доски или удалено: заявки живут месяц после даты выезда, а потом удаляются.');
    c.status(404);
    c.header('Cache-Control', nf.cacheControl ?? 'no-store');
    return c.html(nf.html);
  }
  c.header('Cache-Control', page.cacheControl ?? 'no-store');
  return c.html(page.html);
});

/* Неизвестный адрес: своя страница 404 со ссылками на доску и маршруты,
   для API — JSON. Дефолтная заглушка Cloudflare человеку ничего не предлагает. */
app.notFound(async (c) => {
  if (c.req.path.startsWith('/api/')) return c.json({ error: 'not_found' }, 404);
  const origin = siteOrigin(c.env, c.req.url);
  const page = await buildNotFoundPage(c.env, origin);
  c.status(404);
  c.header('Cache-Control', page.cacheControl ?? 'no-store');
  return c.html(page.html);
});

/* ---------------- SEO-страницы: маршруты и города ---------------- */
/* Страницы под запросы «передать посылку Варшава → Львов»: текст + живые
   заявки по маршруту. Кроме витрины (src/seo-routes.ts) сюда попадают любые
   пары городов, где есть хотя бы одна активная заявка, и страницы городов. */
app.get('/r/:slug', async (c) => {
  const origin = siteOrigin(c.env, c.req.url);
  const slug = c.req.param('slug');
  const html = await buildRoutePage(c.env, slug, origin);
  if (!html) {
    // транслитный слаг витринной пары («varshava-keln») — постоянный редирект,
    // иначе у одного направления два адреса и вес делится пополам
    const canonical = await resolveRouteAlias(c.env, slug);
    if (canonical) return c.redirect(`/r/${canonical}`, 301);
    return c.notFound();
  }
  c.header('Cache-Control', 'public, max-age=0, s-maxage=600');
  return c.html(html);
});

app.get('/routes', async (c) => {
  const html = await buildRoutesIndexPage(c.env, siteOrigin(c.env, c.req.url));
  c.header('Cache-Control', 'public, max-age=0, s-maxage=3600');
  return c.html(html);
});

app.get('/gorod', async (c) => {
  const html = await buildCitiesIndexPage(c.env, siteOrigin(c.env, c.req.url));
  c.header('Cache-Control', 'public, max-age=0, s-maxage=3600');
  return c.html(html);
});

/* Публичная страница итогов: цифры по месяцам и средние цены по валютам. */
app.get('/itogi', async (c) => {
  const page = await buildStatsPage(c.env, siteOrigin(c.env, c.req.url));
  c.header('Cache-Control', page.cacheControl ?? 'no-store');
  return c.html(page.html);
});

/* Итоги одного месяца /itogi/2026-09: цифры + аналитическая заметка.
   Каждый месяц — отдельная страница: набираем контент по запросам
   про статистику направлений, страница не устаревает никогда. */
app.get('/itogi/:month', async (c) => {
  const origin = siteOrigin(c.env, c.req.url);
  const page = await buildMonthStatsPage(c.env, origin, c.req.param('month'));
  if (!page) {
    const nf = await buildNotFoundPage(c.env, origin, 'Итогов за этот месяц нет: на доске тогда не было опубликованных объявлений.');
    c.status(404);
    c.header('Cache-Control', nf.cacheControl ?? 'no-store');
    return c.html(nf.html);
  }
  c.header('Cache-Control', page.cacheControl ?? 'no-store');
  return c.html(page.html);
});

app.get('/gorod/:slug', async (c) => {
  const origin = siteOrigin(c.env, c.req.url);
  const html = await buildCityPage(c.env, c.req.param('slug'), origin);
  if (!html) return c.notFound();
  c.header('Cache-Control', 'public, max-age=0, s-maxage=600');
  return c.html(html);
});

/* Карта сайта: /sitemap.xml — индекс из трёх файлов (страницы, маршруты,
   объявления). Разбивка нужна, потому что объявления меняются каждый час,
   а витрина маршрутов — раз в день. */
app.get('/sitemap.xml', async (c) => {
  const xml = await buildSitemapXml(c.env, siteOrigin(c.env, c.req.url));
  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=0, s-maxage=3600' },
  });
});

app.get('/sitemap-pages.xml', async (c) => {
  // страницы месяцев итогов появляются по одному на каждый месяц
  const months = await listMonthStats(c.env).catch(() => []);
  const xml = buildPagesSitemap(siteOrigin(c.env, c.req.url), mskTodayIso(), months);
  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=0, s-maxage=3600' },
  });
});

app.get('/sitemap-routes.xml', async (c) => {
  const xml = await buildRoutesSitemap(c.env, siteOrigin(c.env, c.req.url));
  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=0, s-maxage=1800' },
  });
});

app.get('/sitemap-items.xml', async (c) => {
  const xml = await buildItemsSitemap(c.env, siteOrigin(c.env, c.req.url));
  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=0, s-maxage=1800' },
  });
});

/* OG-картинка маршрута или города: /og-route/varshava-minsk.png */
app.get('/og-route/:slug', async (c) => {
  const slug = (c.req.param('slug') ?? '').replace(/\.png$/, '');
  const route = await resolveRoute(c.env, slug);
  const city = route ? null : await resolveCity(c.env, slug);
  if (!route && !city) return c.redirect('/og-cover.png');
  try {
    const png = route
      ? await renderRouteOg(routeOgSpec(route), c.env)
      : await renderRouteOg(cityOgSpec(city!.city, city!.stat), c.env);
    return new Response(png.buffer as ArrayBuffer, {
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
    });
  } catch (e) {
    console.error('og route render failed', e);
    return c.redirect('/og-cover.png');
  }
});

/* Динамическая OG-картинка объявления: 1200×630, рисуется на воркере
   (resvg-wasm + шрифты через биндинг ASSETS). При любой ошибке — статичная обложка. */
app.get('/og/:id', async (c) => {
  const id = c.req.param('id').replace(/\.png$/, '');
  const listing = await getListingById(c.env, id);
  if (!listing || (listing.status !== 'published' && listing.status !== 'expired')) return c.redirect('/og-cover.png');
  try {
    const png = await renderOgImage(listing, c.env);
    return new Response(png.buffer as ArrayBuffer, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch (e) {
    console.error('og render failed', e);
    return c.redirect('/og-cover.png');
  }
});

/* Диагностика OG-рендера: возвращает JSON вместо картинки — видно настоящую ошибку. */
app.get('/og-debug/:id', async (c) => {
  const id = c.req.param('id');
  const listing = await getListingById(c.env, id);
  if (!listing || (listing.status !== 'published' && listing.status !== 'expired')) return c.json({ ok: false, error: 'not_found' }, 404);
  try {
    const png = await renderOgImage(listing, c.env);
    return c.json({ ok: true, bytes: png.byteLength });
  } catch (e) {
    return c.json({ ok: false, error: String(e) });
  }
});

/* --------------------- Админка (API-ключ) ---------------------- */

app.use('/api/admin/*', async (c, next) => {
  const auth = c.req.header('Authorization') ?? '';
  if (!c.env.ADMIN_API_TOKEN || auth !== `Bearer ${c.env.ADMIN_API_TOKEN}`) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  await next();
});

app.get('/api/admin/pending', async (c) => {
  const { items } = await listListings(c.env, { status: 'pending', perPage: 100 });
  return c.json({ items });
});

app.post('/api/admin/listings/:id/status', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { status?: string };
  if (!['published', 'rejected', 'expired'].includes(body.status ?? '')) {
    return c.json({ error: 'status должен быть published, rejected или expired' }, 400);
  }
  const id = c.req.param('id');
  const ok = await updateListingStatus(c.env, id, body.status as 'published' | 'rejected' | 'expired');
  if (!ok) return c.json({ error: 'not_found' }, 404);

  // Публикуем — проверим, нет ли уже такой заявки на доске (дубль одобрили по забывчивости)
  let duplicate: { id: string; why: string } | null = null;
  if (body.status === 'published') {
    const listing = await getListingById(c.env, id);
    if (listing) {
      const dup = await findDuplicate(c.env, listing).catch(() => null);
      if (dup && dup.listing.id !== id && dup.listing.status === 'published') {
        duplicate = { id: dup.listing.id, why: dup.why };
      }
    }
  }
  return c.json({ ok: true, duplicate });
});

/* Список заявок для админ-панели: tab=pending (очередь модерации)
   или tab=board (всё, что на доске, включая архив). */
/** Пометка «похоже на дубль» для очереди модерации. */
type DuplicateBadge = {
  id: string;
  kind: 'duplicate' | 'similar';
  why: string;
  status: string;
  fromCity: string;
  toCity: string;
  departureDate: string | null;
};

app.get('/api/admin/listings', async (c) => {
  const isBoard = c.req.query('tab') === 'board';
  // Перед показом очереди выметаем заявки с прошедшей датой выезда:
  // модерировать «везу 5 числа» 10-го числа бессмысленно. Регулярные рейсы
  // остаются — их расписание живёт дальше конкретной даты.
  let pruned = 0;
  if (!isBoard) {
    pruned = await pruneStalePending(c.env).catch((e) => {
      console.error('prune stale pending failed', e);
      return 0;
    });
  }
  const items = isBoard
    ? await listAdminBoard(c.env, 200)
    : await listListings(c.env, { status: 'pending', perPage: 100 }).then((r) => r.items);
  // происхождение заявки — штампы «от админа» / «с сайта» / «из чата» /
  // «от другого человека» в карточке
  const withOrigin = items.map((l) => ({
    ...l,
    byAdmin: isAdminOrigin(c.env, l),
    fromPerson: isPersonOrigin(c.env, l),
  }));

  // В очереди модерации помечаем повторы: одно и то же объявление пересылают
  // каждый день, и админ не должен держать в голове, что уже одобрил.
  if (isBoard) return c.json({ items: withOrigin });
  const annotated: Array<Record<string, unknown>> = [];
  for (const l of withOrigin.slice(0, 40)) {
    let badge: DuplicateBadge | null = null;
    try {
      const dup = await findDuplicate(c.env, l);
      if (dup && dup.listing.id !== l.id) {
        badge = {
          id: dup.listing.id, kind: dup.kind, why: dup.why, status: dup.listing.status,
          fromCity: dup.listing.fromCity, toCity: dup.listing.toCity,
          departureDate: dup.listing.departureDate ?? null,
        };
      }
    } catch (e) {
      console.error('duplicate check failed', e);
    }
    annotated.push({ ...l, duplicate: badge });
  }
  return c.json({ items: [...annotated, ...withOrigin.slice(40)], pruned });
});

/* «Заменить старую»: заявку подал сам человек (владелец), а похожая уже висит
   (её раньше принёс админ из чата) — удаляем старую, новую публикуем. */
app.post('/api/admin/listings/:id/replace', async (c) => {
  const id = c.req.param('id');
  const b = (await c.req.json().catch(() => ({}))) as { deleteId?: string };
  const deleteId = typeof b.deleteId === 'string' ? b.deleteId : null;
  if (!deleteId) return c.json({ error: 'deleteId обязателен — какую заявку удалить' }, 400);
  if (deleteId === id) return c.json({ error: 'нельзя заменить заявку самой собой' }, 400);
  const target = await getListingById(c.env, id);
  if (!target) return c.json({ error: 'not_found' }, 404);
  const deleted = await deleteListing(c.env, deleteId);
  await updateListingStatus(c.env, id, 'published');
  const item = await getListingById(c.env, id);
  return c.json({ ok: true, deleted, item });
});

/* Редактирование заявки — админ-панель сайта. */
app.put('/api/admin/listings/:id', async (c) => {
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return c.json({ error: 'bad_request' }, 400);

  const type = b.type === 'offer' || b.type === 'request' ? b.type : null;
  if (!type) return c.json({ error: 'type должен быть offer или request' }, 400);

  // Те же правила, что и при создании: города по-русски (знакомую латиницу переводим)
  const fromCity = b.fromCity ? normalizeCity(sanitizeCity(b.fromCity) ?? '') : null;
  const toCity = b.toCity ? normalizeCity(sanitizeCity(b.toCity) ?? '') : null;
  if (!fromCity || !toCity || !isRussianCity(fromCity) || !isRussianCity(toCity)) {
    return c.json({ error: 'Города пишите по-русски, кириллицей' }, 400);
  }

  let departureDate: string | null = null;
  if (typeof b.departureDate === 'string' && b.departureDate !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.departureDate)) {
      return c.json({ error: 'departureDate в формате YYYY-MM-DD' }, 400);
    }
    departureDate = b.departureDate;
  }

  let weightKg: number | null = null;
  if (b.weightKg != null && b.weightKg !== '') {
    weightKg = Number(b.weightKg);
    if (!Number.isFinite(weightKg) || weightKg <= 0 || weightKg > 1000) {
      return c.json({ error: 'weightKg должен быть числом от 0 до 1000' }, 400);
    }
  }

  const price = (typeof b.price === 'string' && b.price.trim().length > 0)
    ? b.price.trim().slice(0, 40)
    : null;

  const description = sanitizeText(b.description, 2000, 'description');
  if (!description || description.length < 5) return c.json({ error: 'description обязательна (от 5 символов)' }, 400);

  // Контакты раскладываем по полям: номер, вписанный в «Telegram», уедет в phone,
  // юзернейм из phone — в telegram, один и тот же контакт дважды не сохранится
  const { telegram, phone } = normalizeContacts(b.telegram, b.phone);

  const item = await updateListing(c.env, c.req.param('id'), {
    type, fromCity, toCity, departureDate, recurring: sanitizeRecurring(b.recurring), weightKg, price, description, telegram, phone,
  });
  if (!item) return c.json({ error: 'not_found' }, 404);
  // Без контакта сохранить можно (у пересылок от людей со скрытым профилем контакта
  // и не было) — но предупреждаем: заявку с пустым контактом публиковать смысла нет.
  return c.json({ ok: true, item, warning: telegram || phone ? null : 'no_contact' });
});

/* Полное удаление заявки (вместе с жалобами) — админ-панель сайта. */
app.post('/api/admin/listings/:id/delete', async (c) => {
  const ok = await deleteListing(c.env, c.req.param('id'));
  if (!ok) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

/* Публичные ссылки на чаты-источники: для кликабельных подписей на доске. */
app.get('/api/chat-links', async (c) => {
  try {
    return c.json({ links: await getChatLinks(c.env) });
  } catch {
    return c.json({ links: {} }); // таблицы ещё нет — работаем без ссылок
  }
});

/* Чаты-источники: названия, счётчики заявок, заданные вручную ссылки.
 *  Если таблицы chat_links ещё нет (миграцию не applied) — флаг needsSetup,
 *  и админка предложит создать её одним кликом. */
app.get('/api/admin/source-chats', async (c) => {
  try {
    return c.json({ chats: await listSourceChats(c.env) });
  } catch (e) {
    if (String(e).includes('no such table')) return c.json({ chats: [], needsSetup: true });
    throw e;
  }
});

/* Разово создать таблицу chat_links (идемпотентно; данные объявлений не трогает). */
app.post('/api/admin/ensure-chat-links', async (c) => {
  await ensureChatLinksTable(c.env);
  return c.json({ ok: true });
});

/* Задать/убрать публичную ссылку на чат (пустой url — убрать). */
app.put('/api/admin/chat-links', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { chatId?: unknown; url?: unknown } | null;
  const chatId = typeof body?.chatId === 'string' ? body.chatId.trim() : '';
  const url = typeof body?.url === 'string' ? body.url.trim() : '';
  if (!chatId) return c.json({ error: 'chat_id required' }, 400);
  if (url && !/^https:\/\/t\.me\//.test(url)) {
    return c.json({ error: 'only https://t.me/... links are allowed' }, 400);
  }
  await upsertChatLink(c.env, chatId, url);
  return c.json({ ok: true });
});

/* Связи заявки (встречные, тот же маршрут, тот же контакт) — админ-панель. */
app.get('/api/admin/listings/:id/related', async (c) => {
  const listing = await getListingById(c.env, c.req.param('id'));
  if (!listing) return c.json({ error: 'not_found' }, 404);
  const rel = await findRelated(c.env, listing, { includePending: true });
  return c.json(rel);
});

/* Ручной запуск архивации — то же самое cron делает раз в сутки:
   просроченные заявки уходят в архив, старше 30 дней — удаляются,
   регулярные рейсы получают свежую дату ближайшего заезда. */
app.post('/api/admin/archive', async (c) => {
  const res = await archiveExpired(c.env);
  return c.json({ ok: true, archived: res.archived, deleted: res.deleted, rolled: res.rolled, pruned: res.pruned });
});

/* ------------------------------------------------------------------ */
/* Повторы: дубликаты, которые уже накопились на доске                   */
/* ------------------------------------------------------------------ */

/**
 * GET /api/admin/duplicates — группы одинаковых заявок: какую оставить
 * и какие копии удалить. Защита от дублей не создаёт новые, но до неё
 * одно и то же объявление успевали одобрить по несколько раз.
 */
app.get('/api/admin/duplicates', async (c) => {
  const includeArchive = c.req.query('archive') === '1';
  const listings = await listForDuplicateSweep(c.env, { includeArchive });
  const groups = groupDuplicates(listings).slice(0, 40);
  return c.json({
    total: listings.length,
    extraCount: groups.reduce((n, g) => n + g.duplicates.length, 0),
    groups: groups.map((g) => ({ why: g.why, keep: g.keep, duplicates: g.duplicates })),
  });
});

/** POST /api/admin/duplicates/clean — удалить перечисленные копии ({ ids: [...] }). */
app.post('/api/admin/duplicates/clean', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((v): v is string => typeof v === 'string').slice(0, 50)
    : [];
  if (ids.length === 0) return c.json({ error: 'нужен список id' }, 400);
  const deleted = await deleteListings(c.env, ids);
  return c.json({ ok: true, deleted });
});

/* ------------------------------------------------------------------ */
/* Подбор пар «водитель везёт» ↔ «нужно передать» + история прогонов     */
/* ------------------------------------------------------------------ */

/**
 * POST /api/admin/match — та самая кнопка в админке: сравнить все заявки
 * (или заявки выбранных городов) и найти пары «водитель ↔ нужно передать».
 * Каждый прогон сохраняется в историю (match_runs / match_pairs).
 *
 * body: { fromCity?, toCity?, days?, includeArchive?, partial?, notify?, note? }
 */
app.post('/api/admin/match', async (c) => {
  const env = c.env;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const truthy = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true';
  const fromCity = sanitizeCity(String(body.fromCity ?? ''));
  const toCity = sanitizeCity(String(body.toCity ?? ''));
  const days = Math.min(30, Math.max(1, Number(body.days ?? 3) || 3));
  const includeArchive = truthy(body.includeArchive);
  const partial = truthy(body.partial);
  const notify = truthy(body.notify);
  const note = sanitizeText(String(body.note ?? ''), 300) || null;

  const listings = await listForMatching(env, { includeArchive });
  const { pairs: allPairs, stats } = pairListings(listings, {
    fromCity: fromCity || null,
    toCity: toCity || null,
    days,
    includeArchive,
    partial,
    limit: 50,
  });
  // Скрытые контакты (неактуальный юзернейм) не показываем: пары с ними
  // убираем до дайджеста и сохранения — и в новых прогонах их не будет тоже.
  const hiddenKeys = new Set((await loadHiddenContacts(env)).map((x) => x.key));
  const { pairs, hiddenCount } = filterHiddenPairs(allPairs, hiddenKeys);

  if (notify) {
    const digest = formatMatchDigest({
      fromCity: fromCity || null, toCity: toCity || null, days, pairs, stats, siteUrl: env.SITE_URL,
    });
    await notifyAdminsDigest(env, digest).catch(() => undefined);
  }

  const run = await saveMatchRun(env, {
    fromCity: fromCity || null,
    toCity: toCity || null,
    daysWindow: days,
    includeArchive,
    partial,
    offersTotal: stats.offers,
    requestsTotal: stats.requests,
    notified: notify,
    note,
  }, pairs);

  return c.json({
    run,
    stats,
    hiddenPairs: hiddenCount,
    pairs: pairs.map((p) => ({
      score: p.score,
      reasons: p.reasons,
      offer: listingSnapshot(p.offer),
      request: listingSnapshot(p.request),
    })),
  });
});

/** GET /api/admin/match — история прогонов подбора. */
app.get('/api/admin/match', async (c) => {
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 30));
  return c.json({ runs: await listMatchRuns(c.env, limit) });
});

/* ---------------------- Итоги месяца (статистика) ---------------------- */
/* Объявления удаляются кроном через 30 дней после выезда, поэтому считаем не
   по живым строкам, а по снимкам stats_months. Тексты постов собирает
   src/stats.ts — админ копирует готовый текст и ничего не дописывает руками. */

/**
 * Снимки месяцев + готовый текст поста на каждый месяц.
 * Тексты считаем сразу для всех: админка переключает месяцы без лишних запросов.
 */
async function statsPayload(env: Env, origin: string) {
  const months = await listMonthStats(env);
  const snapshots = await loadStatsSnapshots(env);
  const summaryByMonth = new Map(snapshots.map((s) => [s.month, s.summary]));
  const current = currentPeriod();
  const withPosts = months.map((m) => ({
    ...m,
    post: statsPostText(m, { site: origin, month: m.month === current ? 'current' : 'past' }),
    path: `/itogi/${m.month}`,
    summary: summaryByMonth.get(m.month) ?? null,
  }));
  const headline = withPosts.find((m) => m.month === current) ?? withPosts[0] ?? null;
  // поток заявок (пришло/одобрено/отклонено) и самые просматриваемые
  const days = (await listDailyStats(env, 90)).slice().reverse(); // старые → новые
  const topViewed = await listMostViewed(env, 10).catch(() => []);
  return {
    months: withPosts,
    currentMonth: current,
    post: headline?.post ?? null,
    updatedAt: months[0]?.updatedAt ?? null,
    flow: {
      days,
      weeks: aggregateDaily(days, 'week'),
      months: aggregateDaily(days, 'month'),
    },
    topViewed: topViewed.map((l) => ({
      id: l.id,
      fromCity: l.fromCity,
      toCity: l.toCity,
      views: l.views,
      status: l.status,
      departureDate: l.departureDate,
      createdAt: l.createdAt,
      path: `/item/${l.id}`,
    })),
  };
}

app.get('/api/admin/stats', async (c) => {
  const payload = await statsPayload(c.env, siteOrigin(c.env, c.req.url));
  return c.json(payload);
});

app.post('/api/admin/stats/refresh', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { force?: boolean };
  const res = await refreshStats(c.env, { force: body.force === true });
  const payload = await statsPayload(c.env, siteOrigin(c.env, c.req.url));
  return c.json({ ...payload, saved: res.saved, kept: res.kept, summaries: res.summaries });
});

/* Перегенерировать аналитическую заметку месяца (кнопка на вкладке «итоги»):
   сначала DeepSeek, не задан или не справился — шаблон из цифр. */
app.post('/api/admin/stats/summary', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { month?: string } | null;
  const month = body?.month ?? '';
  if (!/^\d{4}-\d{2}$/.test(month)) return c.json({ error: 'month в формате YYYY-MM' }, 400);
  const res = await regenerateMonthSummary(c.env, month);
  if (!res) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true, month, ai: res.ai, summary: res.summary });
});

/** Скрытые в подборе контакты: юзернейм неактуален — его пары не показываем,
 *  но заявки не удаляем. */
app.get('/api/admin/match/hidden', async (c) => {
  return c.json({ hidden: await loadHiddenContacts(c.env) });
});

app.post('/api/admin/match/hide', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { contact?: unknown; hide?: unknown };
  const contact = typeof b.contact === 'string' ? b.contact.trim() : '';
  if (!contact) return c.json({ error: 'contact обязателен' }, 400);
  const key = contactKeyOf(contact);
  if (!key) return c.json({ error: 'не похоже на контакт' }, 400);
  const hide = b.hide !== false;
  const list = await loadHiddenContacts(c.env);
  const next = hide
    ? (list.some((x) => x.key === key) ? list : [...list, { key, label: contact }])
    : list.filter((x) => x.key !== key);
  await setHiddenContacts(c.env, next);
  return c.json({ ok: true, key, hidden: next });
});

/** GET /api/admin/match/:id — прогон с парами. Пары хранятся снимками заявок,
 *  поэтому история читается даже после того, как крон почистит архив. */
app.get('/api/admin/match/:id', async (c) => {
  const found = await getMatchRun(c.env, c.req.param('id'));
  if (!found) return c.json({ error: 'not_found' }, 404);
  // скрытые контакты действуют и на историю: старые прогоны читаются без
  // неактуальных юзернеймов
  const hiddenKeys = new Set((await loadHiddenContacts(c.env)).map((x) => x.key));
  const { pairs, hiddenCount } = filterHiddenPairs(found.pairs ?? [], hiddenKeys);
  return c.json({ ...found, pairs, hiddenPairs: hiddenCount });
});

/** DELETE /api/admin/match/:id — удалить прогон из истории. */
app.delete('/api/admin/match/:id', async (c) => {
  const ok = await deleteMatchRun(c.env, c.req.param('id'));
  if (!ok) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

/* Cron: раз в сутки архивируем просроченные заявки и подчищаем старый архив.
   Расписание — [triggers] в wrangler.toml; ручной запуск — POST /api/admin/archive. */
const worker = {
  fetch: app.fetch,
  scheduled: async (_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> => {
    // Снимок итогов сохраняем ДО чистки архива: удалённые объявления
    // не должны «съедать» цифры месяца, который уже закрыт.
    try {
      const stats = await refreshStats(env);
      console.log('refreshStats:', JSON.stringify({ saved: stats.saved, kept: stats.kept.length, summaries: stats.summaries }));
    } catch (e) {
      console.error('refreshStats failed', e);
    }
    const res = await archiveExpired(env);
    console.log('archiveExpired:', JSON.stringify(res));
  },
};

export default worker;
