import type { Env, ListFilters, Listing, ListingInput, ListingStatus } from './types';
import type { MatchPair, ListingSnapshot } from './match';
import { listingSnapshot, parseSnapshot } from './match';
import { normalizeContacts } from './util';

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
  // Единая точка нормализации контактов: номер не должен лежать в поле telegram,
  // а один и тот же контакт — в обоих полях (иначе дубли в карточке и битая
  // ссылка t.me/+48… на сайте). Через createListing проходят все источники.
  const { telegram, phone } = normalizeContacts(input.telegram, input.phone);
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
      input.description, phone, telegram,
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
  // Те же правила, что при создании: контакты без дублей и каждый в своём поле
  const { telegram, phone } = normalizeContacts(patch.telegram, patch.phone);
  const res = await env.DB.prepare(
    `UPDATE listings SET
       type = ?, from_city = ?, to_city = ?, departure_date = ?, weight_kg = ?,
       price = ?, description = ?, telegram = ?, phone = ?
     WHERE id = ?`
  ).bind(
    patch.type ?? 'offer', patch.fromCity ?? '', patch.toCity ?? '',
    patch.departureDate ?? null, patch.weightKg ?? null, patch.price ?? null,
    patch.description ?? '', telegram, phone, id
  ).run();
  if ((res.meta.changes ?? 0) === 0) return null;
  const row = (await env.DB.prepare('SELECT * FROM listings WHERE id = ?').bind(id).first()) as
    | Record<string, unknown>
    | null;
  return row ? mapRow(row) : null;
}

/** Разово создать таблицу chat_links, если её нет (тот же DDL, что в миграции 0002).
 *  Идемпотентно: IF NOT EXISTS, существующие данные не затрагиваются. */
export async function ensureChatLinksTable(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS chat_links (
       chat_id TEXT PRIMARY KEY,
       url TEXT NOT NULL,
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`
  ).run();
}

/** Публичные ссылки на чаты-источники (админ задаёт вручную): id чата → ссылка t.me/… */
export async function getChatLinks(env: Env): Promise<Record<string, string>> {
  const res = await env.DB.prepare('SELECT chat_id, url FROM chat_links').all();
  const out: Record<string, string> = {};
  for (const row of (res.results ?? []) as Array<Record<string, unknown>>) {
    if (typeof row.chat_id === 'string' && typeof row.url === 'string' && row.url) out[row.chat_id] = row.url;
  }
  return out;
}

/** Сохранить публичную ссылку на чат (пустая строка — убрать ссылку). */
export async function upsertChatLink(env: Env, chatId: string, url: string): Promise<void> {
  if (!url) {
    await env.DB.prepare('DELETE FROM chat_links WHERE chat_id = ?').bind(chatId).run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO chat_links (chat_id, url, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at`
  ).bind(chatId, url, new Date().toISOString()).run();
}

/** Чаты-источники для админки: сколько из них заявок и какая ссылка задана. */
export async function listSourceChats(
  env: Env
): Promise<Array<{ chatId: string; title: string | null; count: number; url: string | null }>> {
  const res = await env.DB.prepare(
    `SELECT l.source_chat_id AS chatId, MAX(l.source_chat) AS title, COUNT(*) AS cnt, cl.url AS url
     FROM listings l LEFT JOIN chat_links cl ON cl.chat_id = l.source_chat_id
     WHERE l.source_chat_id IS NOT NULL AND l.source_chat_id LIKE '-%'
     GROUP BY l.source_chat_id ORDER BY cnt DESC LIMIT 100`
  ).all();
  return ((res.results ?? []) as Array<Record<string, unknown>>).map((r) => ({
    chatId: typeof r.chatId === 'string' ? r.chatId : '',
    title: typeof r.title === 'string' ? r.title : null,
    count: Number(r.cnt ?? 0),
    url: typeof r.url === 'string' ? r.url : null,
  }));
}

/** Связи заявки: встречные рейсы, тот же маршрут (±3 дня), другие заявки того же контакта. */
export async function findRelated(
  env: Env,
  l: Listing,
  opts: { includePending?: boolean } = {}
): Promise<{ reverse: Listing[]; same: Listing[]; sameContact: Listing[] }> {
  const statuses = opts.includePending
    ? "('published', 'expired', 'pending')"
    : "('published', 'expired')";
  const run = async (sql: string, ...params: (string | number | null)[]): Promise<Listing[]> => {
    const res = await env.DB.prepare(sql).bind(...params).all();
    return ((res.results ?? []) as unknown as Array<Record<string, unknown>>).map(mapRow);
  };
  const reverse = await run(
    `SELECT * FROM listings WHERE status IN ${statuses} AND id <> ? AND from_city = ? AND to_city = ?
     ORDER BY COALESCE(published_at, created_at) DESC LIMIT 5`,
    l.id, l.toCity, l.fromCity
  );
  const same = l.departureDate
    ? await run(
        `SELECT * FROM listings WHERE status IN ${statuses} AND id <> ? AND from_city = ? AND to_city = ?
         AND departure_date IS NOT NULL AND ABS(julianday(departure_date) - julianday(?)) <= 3
         ORDER BY departure_date LIMIT 5`,
        l.id, l.fromCity, l.toCity, l.departureDate)
    : await run(
        `SELECT * FROM listings WHERE status IN ${statuses} AND id <> ? AND from_city = ? AND to_city = ?
         ORDER BY COALESCE(published_at, created_at) DESC LIMIT 5`,
        l.id, l.fromCity, l.toCity);
  const sameContact = await run(
    `SELECT * FROM listings WHERE status IN ${statuses} AND id <> ?
     AND ((telegram IS NOT NULL AND telegram = ?) OR (phone IS NOT NULL AND phone = ?))
     ORDER BY COALESCE(published_at, created_at) DESC LIMIT 5`,
    l.id, l.telegram ?? '', l.phone ?? ''
  );
  return { reverse, same, sameContact };
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
  // Жаловаться можно и на архивную заявку: она месяц висит по ссылке, автору
  // всё ещё пишут. Раньше принимались только 'published' — кнопка на странице
  // архивной заявки отвечала «не получилось отправить жалобу».
  if (!listing || (listing.status !== 'published' && listing.status !== 'expired')) {
    return { ok: false, autoRejected: false, count: 0 };
  }

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

/* ------------------------------------------------------------------ */
/* Подбор пар «водитель ↔ нужно передать» и история прогонов           */
/* ------------------------------------------------------------------ */

export interface MatchRun {
  id: string;
  createdAt: string;
  fromCity: string | null;
  toCity: string | null;
  daysWindow: number;
  includeArchive: boolean;
  partial: boolean;
  offersTotal: number;
  requestsTotal: number;
  pairsFound: number;
  notified: boolean;
  note: string | null;
}

export interface StoredMatchPair {
  id: string;
  runId: string;
  offerId: string;
  requestId: string;
  score: number;
  reason: string | null;
  offer: ListingSnapshot | null;
  request: ListingSnapshot | null;
  createdAt: string;
}

function mapRun(row: Record<string, unknown>): MatchRun {
  return {
    id: String(row.id),
    createdAt: String(row.created_at),
    fromCity: row.from_city ? String(row.from_city) : null,
    toCity: row.to_city ? String(row.to_city) : null,
    daysWindow: Number(row.days_window ?? 3),
    includeArchive: Number(row.include_archive ?? 0) === 1,
    partial: Number(row.partial ?? 0) === 1,
    offersTotal: Number(row.offers_total ?? 0),
    requestsTotal: Number(row.requests_total ?? 0),
    pairsFound: Number(row.pairs_found ?? 0),
    notified: Number(row.notified ?? 0) === 1,
    note: row.note ? String(row.note) : null,
  };
}

function mapPair(row: Record<string, unknown>): StoredMatchPair {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    offerId: String(row.offer_id),
    requestId: String(row.request_id),
    score: Number(row.score ?? 0),
    reason: row.reason ? String(row.reason) : null,
    offer: parseSnapshot(row.offer_json ? String(row.offer_json) : null),
    request: parseSnapshot(row.request_json ? String(row.request_json) : null),
    createdAt: String(row.created_at ?? ''),
  };
}

/** Разово создать таблицы подбора, если их нет (тот же DDL, что в миграции 0005).
 *  Идемпотентно — можно звать перед каждым прогоном. */
export async function ensureMatchTables(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS match_runs (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      from_city TEXT,
      to_city TEXT,
      days_window INTEGER NOT NULL DEFAULT 3,
      include_archive INTEGER NOT NULL DEFAULT 0,
      partial INTEGER NOT NULL DEFAULT 0,
      offers_total INTEGER NOT NULL DEFAULT 0,
      requests_total INTEGER NOT NULL DEFAULT 0,
      pairs_found INTEGER NOT NULL DEFAULT 0,
      notified INTEGER NOT NULL DEFAULT 0,
      note TEXT
    )`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_match_runs_created ON match_runs (created_at DESC)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS match_pairs (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES match_runs(id) ON DELETE CASCADE,
      offer_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      reason TEXT,
      offer_json TEXT NOT NULL,
      request_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_match_pairs_run ON match_pairs (run_id)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_match_pairs_offer ON match_pairs (offer_id)'),
  ]);
}

/** Заявки для подбора: опубликованные (и, если попросят, архив). Города и даты
 *  дальше фильтрует src/match.ts — тут только статус и актуальность. */
export async function listForMatching(
  env: Env,
  opts: { includeArchive?: boolean; limit?: number } = {}
): Promise<Listing[]> {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 400));
  const statuses = opts.includeArchive ? "('published', 'expired')" : "('published')";
  // Без архива берём только будущие даты: заявка со вчерашним выездом уже не полезна
  const fresh = opts.includeArchive
    ? ''
    : "AND (departure_date IS NULL OR departure_date >= date('now', '+3 hours'))";
  const res = await env.DB.prepare(
    `SELECT * FROM listings WHERE status IN ${statuses} ${fresh}
     ORDER BY (departure_date IS NULL), departure_date ASC, COALESCE(published_at, created_at) DESC
     LIMIT ?`
  ).bind(limit).all();
  return ((res.results ?? []) as unknown as Array<Record<string, unknown>>).map(mapRow);
}

/** Сохранить прогон подбора вместе с парами (история). */
export async function saveMatchRun(
  env: Env,
  input: {
    fromCity: string | null;
    toCity: string | null;
    daysWindow: number;
    includeArchive: boolean;
    partial: boolean;
    offersTotal: number;
    requestsTotal: number;
    notified: boolean;
    note?: string | null;
  },
  pairs: MatchPair[]
): Promise<MatchRun> {
  await ensureMatchTables(env);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const statements = [
    env.DB.prepare(
      `INSERT INTO match_runs
        (id, created_at, from_city, to_city, days_window, include_archive, partial,
         offers_total, requests_total, pairs_found, notified, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, createdAt, input.fromCity, input.toCity, input.daysWindow,
      input.includeArchive ? 1 : 0, input.partial ? 1 : 0,
      input.offersTotal, input.requestsTotal, pairs.length,
      input.notified ? 1 : 0, input.note ?? null
    ),
  ];
  for (const p of pairs) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO match_pairs
          (id, run_id, offer_id, request_id, score, reason, offer_json, request_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        crypto.randomUUID(), id, p.offer.id, p.request.id, p.score,
        p.reasons.join('; ').slice(0, 400),
        JSON.stringify(listingSnapshot(p.offer)), JSON.stringify(listingSnapshot(p.request)), createdAt
      )
    );
  }
  // D1 batch ограничен по числу запросов — режем на порции
  for (let i = 0; i < statements.length; i += 50) {
    await env.DB.batch(statements.slice(i, i + 50));
  }
  return {
    id, createdAt,
    fromCity: input.fromCity, toCity: input.toCity, daysWindow: input.daysWindow,
    includeArchive: input.includeArchive, partial: input.partial,
    offersTotal: input.offersTotal, requestsTotal: input.requestsTotal,
    pairsFound: pairs.length, notified: input.notified, note: input.note ?? null,
  };
}

export async function listMatchRuns(env: Env, limit = 30): Promise<MatchRun[]> {
  await ensureMatchTables(env);
  const res = await env.DB.prepare(
    'SELECT * FROM match_runs ORDER BY created_at DESC LIMIT ?'
  ).bind(Math.min(100, Math.max(1, limit))).all();
  return ((res.results ?? []) as unknown as Array<Record<string, unknown>>).map(mapRun);
}

export async function getMatchRun(
  env: Env,
  id: string
): Promise<{ run: MatchRun; pairs: StoredMatchPair[] } | null> {
  await ensureMatchTables(env);
  const row = (await env.DB.prepare('SELECT * FROM match_runs WHERE id = ?').bind(id).first()) as
    | Record<string, unknown> | null;
  if (!row) return null;
  const pairsRes = await env.DB.prepare(
    'SELECT * FROM match_pairs WHERE run_id = ? ORDER BY score DESC, created_at ASC LIMIT 200'
  ).bind(id).all();
  const pairs = ((pairsRes.results ?? []) as unknown as Array<Record<string, unknown>>).map(mapPair);
  return { run: mapRun(row), pairs };
}

export async function deleteMatchRun(env: Env, id: string): Promise<boolean> {
  const res = await env.DB.batch([
    env.DB.prepare('DELETE FROM match_pairs WHERE run_id = ?').bind(id),
    env.DB.prepare('DELETE FROM match_runs WHERE id = ?').bind(id),
  ]);
  return Number(res[1]?.meta.changes ?? 0) > 0;
}
