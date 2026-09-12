import type { Env, ListFilters, Listing, ListingInput, ListingStatus } from './types';

function mapRow(row: Record<string, unknown>): Listing {
  return {
    id: String(row.id),
    type: row.type as Listing['type'],
    fromCity: String(row.from_city),
    toCity: String(row.to_city),
    departureDate: row.departure_date ? String(row.departure_date) : null,
    weightKg: row.weight_kg === null || row.weight_kg === undefined ? null : Number(row.weight_kg),
    price: row.price ? String(row.price) : null,
    description: String(row.description),
    phone: row.phone ? String(row.phone) : null,
    telegram: row.telegram ? String(row.telegram) : null,
    status: row.status as ListingStatus,
    source: row.source as Listing['source'],
    sourceChat: row.source_chat ? String(row.source_chat) : null,
    sourceChatId: row.source_chat_id ? String(row.source_chat_id) : null,
    sourceMessageId: row.source_message_id ? Number(row.source_message_id) : null,
    createdAt: String(row.created_at),
    publishedAt: row.published_at ? String(row.published_at) : null,
    views: Number(row.views ?? 0),
  };
}

export async function createListing(env: Env, input: ListingInput): Promise<Listing> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const publishedAt = input.status === 'published' ? now : null;
  await env.DB.prepare(
    `INSERT INTO listings
      (id, type, from_city, to_city, departure_date, weight_kg, price, description,
       phone, telegram, status, source, source_chat, source_chat_id, source_message_id,
       created_at, published_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id, input.type, input.fromCity, input.toCity,
      input.departureDate ?? null, input.weightKg ?? null, input.price ?? null,
      input.description, input.phone ?? null, input.telegram ?? null,
      input.status, input.source, input.sourceChat ?? null, input.sourceChatId ?? null,
      input.sourceMessageId ?? null, now, publishedAt
    )
    .run();
  const row = (await env.DB.prepare('SELECT * FROM listings WHERE id = ?').bind(id).first()) as
    | Record<string, unknown>
    | null;
  if (!row) throw new Error('Failed to create listing');
  return mapRow(row);
}

export async function listListings(
  env: Env,
  f: ListFilters
): Promise<{ items: Listing[]; hasMore: boolean }> {
  const { sql, params } = buildWhere(f);
  let fullSql = `SELECT * FROM listings${sql}`;
  if (f.type) { fullSql += ' AND type = ?'; params.push(f.type); }

  const page = Math.max(1, f.page ?? 1);
  const perPage = Math.min(50, Math.max(1, f.perPage ?? 20));
  fullSql += ' ORDER BY COALESCE(published_at, created_at) DESC LIMIT ? OFFSET ?';
  params.push(perPage + 1, (page - 1) * perPage);

  const res = await env.DB.prepare(fullSql).bind(...params).all();
  const rows = (res.results ?? []) as unknown as Array<Record<string, unknown>>;
  const hasMore = rows.length > perPage;
  return { items: rows.slice(0, perPage).map(mapRow), hasMore };
}

export async function getListingById(env: Env, id: string, opts: { hitView?: boolean } = {}): Promise<Listing | null> {
  if (opts.hitView) {
    await env.DB.prepare('UPDATE listings SET views = views + 1 WHERE id = ?').bind(id).run();
  }
  const row = (await env.DB.prepare('SELECT * FROM listings WHERE id = ?').bind(id).first()) as
    | Record<string, unknown>
    | null;
  return row ? mapRow(row) : null;
}

export async function updateListingStatus(env: Env, id: string, status: ListingStatus): Promise<boolean> {
  const publishedAt = status === 'published' ? new Date().toISOString() : null;
  const res = await env.DB.prepare(
    'UPDATE listings SET status = ?, published_at = COALESCE(?, published_at) WHERE id = ?'
  ).bind(status, publishedAt, id).run();
  return (res.meta.changes ?? 0) > 0;
}

export async function listPending(env: Env, limit = 50): Promise<Listing[]> {
  const res = await env.DB.prepare(
    'SELECT * FROM listings WHERE status = ? ORDER BY created_at DESC LIMIT ?'
  ).bind('pending', limit).all();
  return ((res.results ?? []) as unknown as Array<Record<string, unknown>>).map(mapRow);
}

/**
 * Заявки по городу (куда ИЛИ откуда), без учёта регистра.
 * Кроме действующих показывает и архив — заявки с прошедшей датой,
 * которые ещё не удалились (30 дней после даты выезда). Активные — выше.
 */
export async function searchByCity(env: Env, city: string, limit = 30): Promise<Listing[]> {
  const pattern = globCi(city);
  const res = await env.DB.prepare(
    `SELECT * FROM listings
     WHERE status IN ('published', 'expired')
       AND (from_city GLOB ? OR to_city GLOB ?)
       AND (departure_date IS NULL OR departure_date >= date('now', '+3 hours', '-30 days'))
     ORDER BY (CASE WHEN status = 'expired' OR departure_date < date('now', '+3 hours') THEN 1 ELSE 0 END),
              COALESCE(published_at, created_at) DESC
     LIMIT ?`
  ).bind(pattern, pattern, limit).all();
  return ((res.results ?? []) as unknown as Array<Record<string, unknown>>).map(mapRow);
}

/**
 * Архивация по расписанию (cron, раз в сутки):
 * 1) опубликованные заявки с прошедшей датой выезда → статус 'expired' (архив):
 *    они пропадают с доски, но месяц ещё доступны по ссылке и в /поиск;
 * 2) заявки старше 30 дней с даты выезда — удаляются насовсем (вместе с жалобами, ON DELETE CASCADE).
 */
export async function archiveExpired(env: Env): Promise<{ archived: number; deleted: number }> {
  const upd = await env.DB.prepare(
    `UPDATE listings SET status = 'expired'
     WHERE status = 'published'
       AND departure_date IS NOT NULL
       AND departure_date < date('now', '+3 hours')`
  ).run();
  const del = await env.DB.prepare(
    `DELETE FROM listings
     WHERE departure_date IS NOT NULL
       AND departure_date < date('now', '+3 hours', '-30 days')`
  ).run();
  return { archived: upd.meta.changes ?? 0, deleted: del.meta.changes ?? 0 };
}

/** Заявка по префиксу id (от 4 символов): «a1b2» из «№ A1B2» на сайте,
 *  короткий id из сообщения бота (#a1b2c3d4) или полный uuid из ссылки. */
export async function findByIdPrefix(env: Env, prefix: string): Promise<Listing[]> {
  const clean = prefix.toLowerCase().replace(/[^0-9a-f-]/g, '');
  if (clean.length < 4 || clean.length > 36) return [];
  const res = await env.DB.prepare('SELECT * FROM listings WHERE id LIKE ?').bind(`${clean}%`).all();
  return ((res.results ?? []) as unknown as Array<Record<string, unknown>>).map(mapRow);
}

/** Заявки на доске (действующие + архив) — для админ-панели сайта. */
export async function listAdminBoard(env: Env, limit = 200): Promise<Listing[]> {
  const res = await env.DB.prepare(
    `SELECT * FROM listings WHERE status IN ('published', 'expired')
     ORDER BY COALESCE(published_at, created_at) DESC LIMIT ?`
  ).bind(limit).all();
  return ((res.results ?? []) as unknown as Array<Record<string, unknown>>).map(mapRow);
}

/** Редактирование заявки в админ-панели: обновляет поля и возвращает обновлённую заявку. */
export async function updateListing(
  env: Env,
  id: string,
  patch: Partial<Pick<ListingInput,
    'type' | 'fromCity' | 'toCity' | 'departureDate' | 'weightKg' | 'price' | 'description' | 'telegram' | 'phone'>>
): Promise<Listing | null> {
  const res = await env.DB.prepare(
    `UPDATE listings SET
       type = ?, from_city = ?, to_city = ?, departure_date = ?, weight_kg = ?,
       price = ?, description = ?, telegram = ?, phone = ?
     WHERE id = ?`
  ).bind(
    patch.type ?? 'offer', patch.fromCity ?? '', patch.toCity ?? '',
    patch.departureDate ?? null, patch.weightKg ?? null, patch.price ?? null,
    patch.description ?? '', patch.telegram ?? null, patch.phone ?? null, id
  ).run();
  if ((res.meta.changes ?? 0) === 0) return null;
  const row = (await env.DB.prepare('SELECT * FROM listings WHERE id = ?').bind(id).first()) as
    | Record<string, unknown>
    | null;
  return row ? mapRow(row) : null;
}

/** Полное удаление заявки (админ-панель): вместе с жалобами и отметками обработанных сообщений. */
export async function deleteListing(env: Env, id: string): Promise<boolean> {
  const res = await env.DB.batch([
    env.DB.prepare('DELETE FROM reports WHERE listing_id = ?').bind(id),
    env.DB.prepare('DELETE FROM tg_seen WHERE listing_id = ?').bind(id),
    env.DB.prepare('DELETE FROM listings WHERE id = ?').bind(id),
  ]);
  return Number(res[2]?.meta.changes ?? 0) > 0;
}

export async function addReport(env: Env, listingId: string, reason: string | null, ip: string | null): Promise<{ ok: boolean; autoRejected: boolean; count: number }> {
  const listing = await getListingById(env, listingId);
  if (!listing || listing.status !== 'published') return { ok: false, autoRejected: false, count: 0 };

  await env.DB.prepare(
    'INSERT INTO reports (id, listing_id, reason, reporter_ip, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(crypto.randomUUID(), listingId, reason, ip, new Date().toISOString()).run();

  const countRes = await env.DB.prepare('SELECT COUNT(*) AS n FROM reports WHERE listing_id = ?').bind(listingId).first();
  const count = Number((countRes as { n?: number } | null)?.n ?? 0);
  let autoRejected = false;
  if (count >= 3) {
    await updateListingStatus(env, listingId, 'rejected');
    autoRejected = true;
  }
  return { ok: true, autoRejected, count };
}

export async function markSeen(env: Env, chatId: string, messageId: number): Promise<boolean> {
  const res = await env.DB.prepare(
    'INSERT OR IGNORE INTO tg_seen (chat_id, message_id, seen_at) VALUES (?, ?, ?)'
  ).bind(chatId, messageId, new Date().toISOString()).run();
  return (res.meta.changes ?? 0) > 0;
}

export async function getSeenListing(env: Env, chatId: string, messageId: number): Promise<string | null> {
  const row = (await env.DB.prepare(
    'SELECT listing_id FROM tg_seen WHERE chat_id = ? AND message_id = ?'
  ).bind(chatId, messageId).first()) as { listing_id?: string } | null;
  return row?.listing_id ? row.listing_id : null;
}

export async function setSeenListing(env: Env, chatId: string, messageId: number, listingId: string): Promise<void> {
  await env.DB.prepare(
    'UPDATE tg_seen SET listing_id = ? WHERE chat_id = ? AND message_id = ?'
  ).bind(listingId, chatId, messageId).run();
}

function escapeLike(s: string): string {
  return s.replace(/([%_\\])/g, '\\$1');
}

/** Паттерн для GLOB без учёта регистра (SQLite LIKE не сворачивает регистр кириллицы):
 *  каждая буква превращается в класс [аА], спецсимволы GLOB (* ? [ ]) экранируются. */
function globCi(q: string): string {
  let out = '';
  for (const ch of q) {
    const lo = ch.toLowerCase();
    const up = ch.toUpperCase();
    if (ch === ']' ) out += '[]]';
    else if (ch === '*' || ch === '?' || ch === '[') out += `[${ch}]`;
    else if (lo !== up) out += `[${lo}${up}]`;
    else out += ch;
  }
  return `*${out}*`;
}

interface WhereClause { sql: string; params: (string | number)[] }

function buildWhere(f: ListFilters): WhereClause {
  let sql: string;
  const params: (string | number)[] = [];
  if (f.archive) {
    // Архив (вкладка на доске): помеченные cron'ом ('expired')
    // и ещё не помеченные просроченные ('published' с прошедшей датой).
    sql = " WHERE (status = 'expired' OR (status = 'published' AND departure_date IS NOT NULL AND departure_date < date('now', '+3 hours')))";
  } else {
    sql = ' WHERE status = ?';
    params.push(f.status ?? 'published');
    // Доска показывает только актуальные заявки: дата выезда не прошла
    // (или не указана). Просроченные живут в архиве — см. archiveExpired.
    if ((f.status ?? 'published') === 'published') {
      sql += " AND (departure_date IS NULL OR departure_date >= date('now', '+3 hours'))";
    }
  }
  if (f.from) { sql += ' AND from_city GLOB ?'; params.push(globCi(f.from)); }
  if (f.to) { sql += ' AND to_city GLOB ?'; params.push(globCi(f.to)); }
  if (f.date) { sql += ' AND departure_date = ?'; params.push(f.date); }
  if (f.q) {
    const pattern = globCi(f.q);
    sql += ' AND (description GLOB ? OR from_city GLOB ? OR to_city GLOB ?)';
    params.push(pattern, pattern, pattern);
  }
  return { sql, params };
}

/** Количество объявлений по типам с учётом фильтров поиска (без учёта вкладки-типа). */
export async function getCounts(env: Env, f: ListFilters): Promise<{ offer: number; request: number }> {
  const { sql, params } = buildWhere(f);
  const res = await env.DB.prepare(
    `SELECT type, COUNT(*) AS n FROM listings${sql} GROUP BY type`
  ).bind(...params).all();
  let offer = 0;
  let request = 0;
  for (const row of (res.results ?? []) as unknown as Array<{ type?: string; n?: number }>) {
    if (row.type === 'offer') offer = Number(row.n ?? 0);
    if (row.type === 'request') request = Number(row.n ?? 0);
  }
  return { offer, request };
}
