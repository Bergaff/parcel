import { Hono } from 'hono';
import type { Env, ListingInput, ListingType } from './types';
import { normalizeCity } from './parser';
import { addReport, archiveExpired, createListing, deleteListing, getCounts, getListingById, listAdminBoard, listListings, updateListing, updateListingStatus } from './store';
import { getIp, rateLimit, sanitizeCity, sanitizeContact, sanitizeText, escapeHtml, isRussianCity, mskTodayIso } from './util';
import { handleTelegramUpdate, notifyAdmins, notifyAdminsReport } from './telegram';
import { renderOgImage } from './og';

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

  const telegram = typeof b.telegram === 'string' && b.telegram.trim()
    ? sanitizeContact(b.telegram.trim())
    : null;
  const phone = typeof b.phone === 'string' && b.phone.trim()
    ? sanitizeContact(b.phone.trim())
    : null;

  return {
    input: {
      type: type as ListingType,
      fromCity,
      toCity,
      departureDate,
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
  return c.json({ item: listing });
});

app.post('/api/listings', async (c) => {
  const ip = getIp(c);
  const rl = await rateLimit(c.env, `post:${ip}`, 10, 3600);
  if (!rl.allowed) return c.json({ error: 'too_many_requests' }, 429);

  const body = await c.req.json().catch(() => null);
  const { input, error } = validateListing(body);
  if (error || !input) return c.json({ error }, 400);

  input.status = c.env.AUTO_APPROVE === '1' ? 'published' : 'pending';
  const listing = await createListing(c.env, input);

  // Если объявление ушло на модерацию, тут же шлём его администратору в Telegram
  // с кнопками «Одобрить / Отклонить» (см. notifyAdmins в src/telegram.ts).
  if (listing.status === 'pending') {
    c.executionCtx.waitUntil(
      notifyAdmins(c.env, listing).catch((e) => console.error('notifyAdmins failed', e))
    );
  }

  return c.json(
    {
      item: listing,
      message: input.status === 'published'
        ? 'Объявление опубликовано.'
        : 'Объявление отправлено на модерацию и появится после проверки.',
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

/* ---------------- Страница объявления для превью (OG) ---------------- */
/* Мессенджеры (Telegram, WhatsApp, VK и др.) не исполняют JS и не видят
   hash-роутинг SPA, поэтому для ссылок вида /item/:id отдаём статичный HTML
   с og-разметкой из базы. Живому человеку страница мгновенно делает
   redirect на SPA #/item/:id — см. wrangler.toml: run_worker_first. */

app.get('/item/:id', async (c) => {
  const id = c.req.param('id');
  const listing = await getListingById(c.env, id);
  const origin = new URL(c.req.url).origin;

  if (!listing || (listing.status !== 'published' && listing.status !== 'expired')) {
    return c.redirect('/');
  }
  // Отметка «архив» для заявок с прошедшей датой — видна и в превью-ссылке
  const archived =
    listing.status === 'expired' ||
    (listing.departureDate != null && listing.departureDate < mskTodayIso());

  const typeLabel = listing.type === 'offer' ? 'водитель везёт' : 'нужно передать';
  const title = `${listing.fromCity} → ${listing.toCity} · ${typeLabel}${archived ? ' · архив' : ''}`;
  const bits = [
    listing.departureDate ? `выезд ${listing.departureDate}` : null,
    listing.weightKg != null ? `${String(listing.weightKg).replace('.', ',')} кг` : null,
    listing.price,
  ].filter(Boolean).join(' · ');
  const description = [bits, listing.description.slice(0, 180)].filter(Boolean).join('. ');
  const image = `${origin}/og/${encodeURIComponent(listing.id)}.png`;

  return c.html(`<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(title)} — попутка.</title>
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="попутка." />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:url" content="${origin}/item/${encodeURIComponent(listing.id)}" />
  <meta property="og:image" content="${image}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
  <meta name="twitter:image" content="${image}" />
  <script>location.replace('/#/item/${encodeURIComponent(listing.id)}');</script>
</head>
<body style="font-family:Georgia,serif;background:#f2eee5;color:#201d17;margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh">
  <div style="max-width:560px;padding:40px;text-align:center">
    <div style="font-size:44px;font-weight:700">${escapeHtml(listing.fromCity)} <span style="color:#a43a10">→</span> ${escapeHtml(listing.toCity)}</div>
    <p style="color:#6f675a">${escapeHtml(description)}</p>
    <p style="font-size:14px"><a href="/#/item/${encodeURIComponent(listing.id)}" style="color:#201d17">открыть на доске попутка. →</a></p>
  </div>
</body>
</html>`);
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
  const ok = await updateListingStatus(c.env, c.req.param('id'), body.status as 'published' | 'rejected' | 'expired');
  if (!ok) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

/* Список заявок для админ-панели: tab=pending (очередь модерации)
   или tab=board (всё, что на доске, включая архив). */
app.get('/api/admin/listings', async (c) => {
  const items = c.req.query('tab') === 'board'
    ? await listAdminBoard(c.env, 200)
    : await listListings(c.env, { status: 'pending', perPage: 100 }).then((r) => r.items);
  return c.json({ items });
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

  const telegram = typeof b.telegram === 'string' && b.telegram.trim()
    ? sanitizeContact(b.telegram.trim())
    : null;
  const phone = typeof b.phone === 'string' && b.phone.trim()
    ? sanitizeContact(b.phone.trim())
    : null;
  if (!telegram && !phone) return c.json({ error: 'Нужен хотя бы один контакт: telegram или телефон' }, 400);

  const item = await updateListing(c.env, c.req.param('id'), {
    type, fromCity, toCity, departureDate, weightKg, price, description, telegram, phone,
  });
  if (!item) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true, item });
});

/* Полное удаление заявки (вместе с жалобами) — админ-панель сайта. */
app.post('/api/admin/listings/:id/delete', async (c) => {
  const ok = await deleteListing(c.env, c.req.param('id'));
  if (!ok) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

/* Ручной запуск архивации — то же самое cron делает раз в сутки:
   просроченные заявки уходят в архив, старше 30 дней — удаляются. */
app.post('/api/admin/archive', async (c) => {
  const res = await archiveExpired(c.env);
  return c.json({ ok: true, archived: res.archived, deleted: res.deleted });
});

/* Cron: раз в сутки архивируем просроченные заявки и подчищаем старый архив.
   Расписание — [triggers] в wrangler.toml; ручной запуск — POST /api/admin/archive. */
const worker = {
  fetch: app.fetch,
  scheduled: async (_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> => {
    const res = await archiveExpired(env);
    console.log('archiveExpired:', JSON.stringify(res));
  },
};

export default worker;
