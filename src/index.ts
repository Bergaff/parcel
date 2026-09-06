import { Hono } from 'hono';
import type { Env, ListingInput, ListingType } from './types';
import { addReport, createListing, getCounts, getListingById, listListings, updateListingStatus } from './store';
import { getIp, rateLimit, sanitizeCity, sanitizeContact, sanitizeText } from './util';
import { handleTelegramUpdate } from './telegram';

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
    return new Response(null, { status: 204 });
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

  const fromCity = sanitizeCity(b.fromCity);
  const toCity = sanitizeCity(b.toCity);
  if (!fromCity || !toCity) return { error: 'fromCity и toCity обязательны' };

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
  const from = url.searchParams.get('from') ?? undefined;
  const to = url.searchParams.get('to') ?? undefined;
  const date = url.searchParams.get('date') ?? undefined;
  const q = url.searchParams.get('q') ?? undefined;
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const { items, hasMore } = await listListings(c.env, { type, from, to, date, q, page });
  const counts = await getCounts(c.env, { from, to, date, q });
  return c.json({ items, hasMore, page, total: counts.offer + counts.request, counts });
});

app.get('/api/listings/:id', async (c) => {
  const id = c.req.param('id');
  const listing = await getListingById(c.env, id, { hitView: true });
  if (!listing || listing.status !== 'published') return c.json({ error: 'not_found' }, 404);
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
  return c.json({ ok: true, message: res.autoRejected ? 'Объявление скрыто модерацией.' : 'Жалоба принята, спасибо.' });
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
  if (!['published', 'rejected'].includes(body.status ?? '')) {
    return c.json({ error: 'status должен быть published или rejected' }, 400);
  }
  const ok = await updateListingStatus(c.env, c.req.param('id'), body.status as 'published' | 'rejected');
  if (!ok) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

export default app;
