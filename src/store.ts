import type { Env, ListFilters, Listing, ListingInput, ListingStatus } from './types';
import type { MatchPair, ListingSnapshot } from './match';
import { listingSnapshot, parseSnapshot } from './match';
import type { DedupeSubject, DuplicateHit, DuplicateKind } from './dedupe';
import { pickDuplicate } from './dedupe';
import { admins, normalizeContacts } from './util';
import { nextRecurringDate } from './parser';

function mapRow(row: Record<string, unknown>): Listing {
  return {
    id: String(row.id),
    type: row.type as Listing['type'],
    fromCity: String(row.from_city),
    toCity: String(row.to_city),
    departureDate: row.departure_date ? String(row.departure_date) : null,
    recurring: row.recurring ? String(row.recurring) : null,
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
    byAdmin: Number(row.by_admin ?? 0) === 1,
    fromPerson: Number(row.by_admin ?? 0) === 2,
    hidden: Number(row.hidden ?? 0) === 1,
    createdAt: String(row.created_at),
    publishedAt: row.published_at ? String(row.published_at) : null,
    views: Number(row.views ?? 0),
  };
}

export async function createListing(env: Env, input: ListingInput): Promise<Listing> {
  // Колонки *_lc и recurring должны существовать до записи: на проде миграцию
  // могут применить позже деплоя, а без них INSERT упадёт.
  await ensureSearchColumns(env);
  await ensureRecurringColumn(env);
  await ensureByAdminColumn(env);
  await ensureHiddenColumn(env);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const publishedAt = input.status === 'published' ? now : null;
  // Единая точка нормализации контактов: номер не должен лежать в поле telegram,
  // а один и тот же контакт — в обоих полях (иначе дубли в карточке и битая
  // ссылка t.me/+48… на сайте). Через createListing проходят все источники.
  const { telegram, phone } = normalizeContacts(input.telegram, input.phone);
  await env.DB.prepare(
    `INSERT INTO listings
      (id, type, from_city, to_city, departure_date, recurring, weight_kg, price, description,
       phone, telegram, status, source, source_chat, source_chat_id, source_message_id,
       by_admin, hidden, created_at, published_at, from_city_lc, to_city_lc, description_lc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id, input.type, input.fromCity, input.toCity,
      input.departureDate ?? null, input.recurring ?? null, input.weightKg ?? null, input.price ?? null,
      input.description, phone, telegram,
      input.status, input.source, input.sourceChat ?? null, input.sourceChatId ?? null,
      input.sourceMessageId ?? null,
      // 1 — подал админ, 2 — посторонний человек сам (личка бота, форма без ключа),
      // 0 — взято из чата или старая строка до появления колонки
      input.byAdmin ? 1 : input.fromPerson ? 2 : 0,
      input.hidden ? 1 : 0, now, publishedAt,
      // поиск не зависит от регистра: нижний регистр кладём рядом с текстом
      input.fromCity.toLowerCase(), input.toCity.toLowerCase(), (input.description ?? '').toLowerCase()
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
  // buildWhere упоминает recurring при фильтре «published» (регулярные рейсы
  // показываем и с прошедшей датой) — на свежей базе колонку создаёт воркер,
  // поэтому чтение тоже обязано её гарантировать, а не только запись.
  await ensureRecurringColumn(env);
  if (f.from || f.to || f.q) await ensureSearchColumns(env);
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

/** Соседние заявки того же маршрута (кроме этой) — блок «Ещё по этому маршруту».
 *  Один и тот же набор нужен и серверной карточке (src/pages.ts), и API, по
 *  которому клиент дорисовывает карточку: иначе при переходе кликом с доски
 *  блок похожих пропадает. */
export async function relatedListings(env: Env, l: Listing, limit = 5): Promise<Listing[]> {
  const { items } = await listListings(env, {
    from: l.fromCity, to: l.toCity, perPage: limit + 1,
  });
  return items.filter((x) => x.id !== l.id).slice(0, limit);
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
 * Удалить из очереди модерации заявки с уже прошедшей датой выезда.
 * Модерация смотрит на «сегодня», а не на дату подачи: заявка «везу 5 числа»
 * 10-го числа бесполезна — публиковать её на доску смысла нет. Регулярные
 * рейсы (recurring) не трогаем: их расписание живёт дальше даты заезда.
 * Возвращает число удалённых.
 */
export async function pruneStalePending(env: Env): Promise<number> {
  await ensureRecurringColumn(env);
  const res = await env.DB.prepare(
    `DELETE FROM listings
     WHERE status = 'pending' AND recurring IS NULL
       AND departure_date IS NOT NULL AND departure_date < date('now', '+3 hours')`
  ).run();
  return res.meta.changes ?? 0;
}

/**
 * Заявки по городу (куда ИЛИ откуда), без учёта регистра.
 * Кроме действующих показывает и архив — заявки с прошедшей датой,
 * которые ещё не удалились (30 дней после даты выезда). Активные — выше.
 */
export async function searchByCity(env: Env, city: string, limit = 30): Promise<Listing[]> {
  // ORDER BY ниже смотрит в recurring — гарантируем и его
  await ensureRecurringColumn(env);
  await ensureSearchColumns(env);
  await ensureHiddenColumn(env);
  const pattern = likeContains(city);
  const res = await env.DB.prepare(
    `SELECT * FROM listings
     WHERE status IN ('published', 'expired')
       AND (hidden IS NULL OR hidden != 1)
       AND (from_city_lc LIKE ? ESCAPE '\\' OR to_city_lc LIKE ? ESCAPE '\\')
       AND (departure_date IS NULL OR departure_date >= date('now', '+3 hours', '-30 days'))
     ORDER BY (CASE WHEN status = 'expired' OR (recurring IS NULL AND departure_date < date('now', '+3 hours')) THEN 1 ELSE 0 END),
              COALESCE(published_at, created_at) DESC
     LIMIT ?`
  ).bind(pattern, pattern, limit).all();
  return ((res.results ?? []) as unknown as Array<Record<string, unknown>>).map(mapRow);
}

/**
 * Архивация по расписанию (cron, раз в сутки):
 * 1) регулярные рейсы («каждый четверг») не архивируются — дата выезда
 *    катится на ближайший заезд по расписанию. Водитель возит постоянно,
 *    заявка не «на один раз» и не должна пропадать в пятницу утром.
 *    Живёт, пока её освежают (пересылки, touchListing); 45 дней тишины —
 *    расписание считается закончившимся, заявка уходит в архив;
 * 2) опубликованные заявки с прошедшей датой выезда → статус 'expired' (архив):
 *    они пропадают с доски, но месяц ещё доступны по ссылке и в /поиск;
 * 3) заявки старше 30 дней с даты выезда — удаляются насовсем (вместе с жалобами, ON DELETE CASCADE);
 * 4) регулярные рейсы без обновлений 45 дней — удаляются (расписание умерло).
 */
export async function archiveExpired(env: Env, now: Date = new Date()): Promise<{ archived: number; deleted: number; rolled: number; pruned: number }> {
  await ensureRecurringColumn(env);
  await ensureHiddenColumn(env);

  // 1) Катим дату регулярных рейсов на ближайший заезд — только живые
  //    (освежённые за последние 45 дней), мёртвые трогать не нужно.
  //    Катим с догоном: если cron простаивал, за один прогон догоняем сегодня.
  const todayIso = new Date(now.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  let rolled = 0;
  const stale = await env.DB.prepare(
    `SELECT id, recurring, departure_date FROM listings
     WHERE status = 'published' AND recurring IS NOT NULL
       AND departure_date IS NOT NULL AND departure_date < date('now', '+3 hours')
       AND COALESCE(published_at, created_at) > datetime('now', '-45 days')
     LIMIT 200`
  ).all();
  for (const row of (stale.results ?? []) as unknown as Array<Record<string, unknown>>) {
    const from = String(row.departure_date);
    let next = from;
    for (let i = 0; i < 8 && next < todayIso; i++) {
      const step = nextRecurringDate(String(row.recurring), next);
      if (!step || step === next) break;
      next = step;
    }
    if (next !== from && next >= todayIso) {
      await env.DB.prepare('UPDATE listings SET departure_date = ? WHERE id = ?')
        .bind(next, String(row.id)).run();
      rolled++;
    }
  }

  // 2) Разовые заявки с прошедшей датой → архив (регулярные не трогаем:
  //    живым уже катнут дату, мёртвые уйдут пунктом 4)
  const upd = await env.DB.prepare(
    `UPDATE listings SET status = 'expired'
     WHERE status = 'published'
       AND departure_date IS NOT NULL
       AND recurring IS NULL
       AND departure_date < date('now', '+3 hours')`
  ).run();

  // 3) Архив старше 30 дней с даты выезда — удаляем
  const del = await env.DB.prepare(
    `DELETE FROM listings
     WHERE departure_date IS NOT NULL
       AND recurring IS NULL
       AND departure_date < date('now', '+3 hours', '-30 days')`
  ).run();

  // 4) Мёртвые регулярные: 45 дней никто не пересылал и не освежал
  const prune = await env.DB.prepare(
    `DELETE FROM listings
     WHERE recurring IS NOT NULL
       AND COALESCE(published_at, created_at) < datetime('now', '-45 days')`
  ).run();

  // 5) Скрытые заявки без даты выезда (сайт, без контакта): дата в форме
  //    необязательна, поэтому живём по возрасту — 30 дней на доске-невидимке,
  //    потом архив, ещё через 30 — удаление. С датой разбираются пункты 2–3.
  const updHidden = await env.DB.prepare(
    `UPDATE listings SET status = 'expired'
     WHERE hidden = 1 AND status = 'published'
       AND departure_date IS NULL
       AND created_at < datetime('now', '-30 days')`
  ).run();
  const delHidden = await env.DB.prepare(
    `DELETE FROM listings
     WHERE hidden = 1 AND status = 'expired'
       AND departure_date IS NULL
       AND created_at < datetime('now', '-60 days')`
  ).run();

  return {
    archived: (upd.meta.changes ?? 0) + (updHidden.meta.changes ?? 0),
    deleted: (del.meta.changes ?? 0) + (delHidden.meta.changes ?? 0),
    rolled,
    pruned: prune.meta.changes ?? 0,
  };
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
    'type' | 'fromCity' | 'toCity' | 'departureDate' | 'recurring' | 'weightKg' | 'price' | 'description' | 'telegram' | 'phone'>>
): Promise<Listing | null> {
  await ensureSearchColumns(env);
  await ensureRecurringColumn(env);
  // Те же правила, что при создании: контакты без дублей и каждый в своём поле
  const { telegram, phone } = normalizeContacts(patch.telegram, patch.phone);
  const res = await env.DB.prepare(
    `UPDATE listings SET
       type = ?, from_city = ?, to_city = ?, departure_date = ?, recurring = ?, weight_kg = ?,
       price = ?, description = ?, telegram = ?, phone = ?,
       from_city_lc = ?, to_city_lc = ?, description_lc = ?
     WHERE id = ?`
  ).bind(
    patch.type ?? 'offer', patch.fromCity ?? '', patch.toCity ?? '',
    patch.departureDate ?? null, patch.recurring ?? null, patch.weightKg ?? null, patch.price ?? null,
    patch.description ?? '', telegram, phone,
    (patch.fromCity ?? '').toLowerCase(), (patch.toCity ?? '').toLowerCase(),
    (patch.description ?? '').toLowerCase(), id
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

/**
 * Поиск по городам и тексту без учёта регистра.
 *
 * Раньше здесь был GLOB-шаблон «*[Аа][Мм][Сс]…» — по классу на каждую букву.
 * SQLite отвергает такие шаблоны целиком: «LIKE or GLOB pattern too complex»,
 * лимит 10 спецэлементов. То есть доска падала в 500 на любом городе от девяти
 * букв (Амстердам, Санкт-Петербург, Ивано-Франковск) и на любом поисковом
 * запросе от девяти символов («лекарства», «документы»). Встроенный lower()
 * в SQLite знает только ASCII, поэтому нижний регистр храним в колонках *_lc:
 * их заполняет JS при записи и один раз — SQL при миграции.
 */
const CYR_UPPER = 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯІЇЄҐ';

/**
 * SQL-выражение «нижний регистр, включая кириллицу»: цепочка REPLACE.
 * Дорого на каждую строку, поэтому используется только в разовом заполнении
 * колонок (миграция), а не в запросах.
 */
export function sqlLowerCyr(expr: string): string {
  let out = expr;
  for (const ch of CYR_UPPER) out = `REPLACE(${out}, '${ch}', '${ch.toLowerCase()}')`;
  return out;
}

/** Шаблон «содержит» для LIKE: спецсимволы экранированы, регистр свёрнут. */
export function likeContains(q: string): string {
  const esc = q.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`);
  return `%${esc}%`;
}

const LC_COLUMNS = ['from_city_lc', 'to_city_lc', 'description_lc'] as const;

let searchColumnsReady: Promise<void> | null = null;
let recurringColumnReady: Promise<void> | null = null;
let byAdminColumnReady: Promise<void> | null = null;
let hiddenColumnReady: Promise<void> | null = null;

/** Сбросить отметку «колонки готовы» (тесты и смена базы). */
export function resetSearchColumnsCache(): void {
  searchColumnsReady = null;
  recurringColumnReady = null;
  byAdminColumnReady = null;
  hiddenColumnReady = null;
  statsSummaryReady = null;
}

/**
 * Колонки *_lc на месте и заполнены. Вызывается перед любым поиском:
 * на проде миграцию могут применить позже деплоя, а без колонок запрос
 * упадёт. Повторно не выполняется — ни в этом isolate, ни по данным.
 */
export function ensureSearchColumns(env: Env): Promise<void> {
  if (!searchColumnsReady) {
    searchColumnsReady = (async () => {
      const info = await env.DB.prepare(`PRAGMA table_info(listings)`).all();
      const names = new Set(
        ((info.results ?? []) as unknown as Array<Record<string, unknown>>).map((r) => String(r.name))
      );
      for (const col of LC_COLUMNS) {
        if (!names.has(col)) await env.DB.prepare(`ALTER TABLE listings ADD COLUMN ${col} TEXT`).run();
      }
      await env.DB.prepare(
        `CREATE INDEX IF NOT EXISTS idx_listings_from_lc ON listings(from_city_lc)`
      ).run();
      await env.DB.prepare(
        `CREATE INDEX IF NOT EXISTS idx_listings_to_lc ON listings(to_city_lc)`
      ).run();
      await env.DB.prepare(
        `UPDATE listings SET
           from_city_lc = ${sqlLowerCyr(`COALESCE(from_city, '')`)},
           to_city_lc = ${sqlLowerCyr(`COALESCE(to_city, '')`)},
           description_lc = ${sqlLowerCyr(`COALESCE(description, '')`)}
         WHERE from_city_lc IS NULL OR to_city_lc IS NULL OR description_lc IS NULL`
      ).run();
    })();
    searchColumnsReady.catch(() => { searchColumnsReady = null; });
  }
  return searchColumnsReady;
}

/**
 * Колонка recurring (регулярные рейсы, «каждый четверг») на месте — тот же
 * сценарий, что у *_lc: миграцию на проде могут применить позже деплоя,
 * а INSERT/UPDATE без колонки упадут и заявка не сохранится.
 */
export function ensureRecurringColumn(env: Env): Promise<void> {
  if (!recurringColumnReady) {
    recurringColumnReady = (async () => {
      const info = await env.DB.prepare(`PRAGMA table_info(listings)`).all();
      const names = new Set(
        ((info.results ?? []) as unknown as Array<Record<string, unknown>>).map((r) => String(r.name))
      );
      if (!names.has('recurring')) {
        await env.DB.prepare(`ALTER TABLE listings ADD COLUMN recurring TEXT`).run();
        // Бэкфилл ниже читает description_lc, а на свежей базе *_lc может
        // ещё не быть (их добавляет ensureSearchColumns) — просим заранее,
        // иначе ALTER recurring проходит, а UPDATE падает.
        await ensureSearchColumns(env);
        // Одноразовый бэкфилл: только что добавленная колонка везде NULL, а в
        // описаниях регулярные рейсы уже писали («возим каждый четверг»).
        // description_lc — честный нижний регистр для кириллицы: встроенный
        // lower() в SQLite знает только ASCII, «Каждый» он не понижает.
        await env.DB.prepare(
          `UPDATE listings SET recurring = CASE
             WHEN COALESCE(description_lc, lower(description)) LIKE '%ежедневн%'
               OR COALESCE(description_lc, lower(description)) LIKE '%каждый день%' THEN 'ежедневно'
             WHEN COALESCE(description_lc, lower(description)) LIKE '%по будням%'
               OR COALESCE(description_lc, lower(description)) LIKE '%пн-пт%'
               OR COALESCE(description_lc, lower(description)) LIKE '%пн - пт%' THEN 'по будням'
             WHEN COALESCE(description_lc, lower(description)) LIKE '%кажд%воскресен%'
               OR COALESCE(description_lc, lower(description)) LIKE '%по воскресень%' THEN 'каждое воскресенье'
             WHEN COALESCE(description_lc, lower(description)) LIKE '%кажд%понедельн%'
               OR COALESCE(description_lc, lower(description)) LIKE '%по понедельн%' THEN 'каждый понедельник'
             WHEN COALESCE(description_lc, lower(description)) LIKE '%кажд%вторник%'
               OR COALESCE(description_lc, lower(description)) LIKE '%по вторник%' THEN 'каждый вторник'
             WHEN COALESCE(description_lc, lower(description)) LIKE '%кажд%сред%'
               OR COALESCE(description_lc, lower(description)) LIKE '%по средам%' THEN 'каждую среду'
             WHEN COALESCE(description_lc, lower(description)) LIKE '%кажд%четверг%'
               OR COALESCE(description_lc, lower(description)) LIKE '%по четверг%' THEN 'каждый четверг'
             WHEN COALESCE(description_lc, lower(description)) LIKE '%кажд%пятниц%'
               OR COALESCE(description_lc, lower(description)) LIKE '%по пятниц%' THEN 'каждую пятницу'
             WHEN COALESCE(description_lc, lower(description)) LIKE '%кажд%суббот%'
               OR COALESCE(description_lc, lower(description)) LIKE '%по суббот%' THEN 'каждую субботу'
             WHEN COALESCE(description_lc, lower(description)) LIKE '%кажд%недел%'
               OR COALESCE(description_lc, lower(description)) LIKE '%раз в недел%'
               OR COALESCE(description_lc, lower(description)) LIKE '%еженедел%' THEN 'раз в неделю'
             ELSE recurring
           END
           WHERE recurring IS NULL
             AND (COALESCE(description_lc, lower(description)) LIKE '%кажд%'
               OR COALESCE(description_lc, lower(description)) LIKE '%ежедн%'
               OR COALESCE(description_lc, lower(description)) LIKE '%еженедел%'
               OR COALESCE(description_lc, lower(description)) LIKE '%по будням%'
               OR COALESCE(description_lc, lower(description)) LIKE '%раз в недел%'
               OR COALESCE(description_lc, lower(description)) LIKE '%по понедельн%'
               OR COALESCE(description_lc, lower(description)) LIKE '%по вторник%'
               OR COALESCE(description_lc, lower(description)) LIKE '%по средам%'
               OR COALESCE(description_lc, lower(description)) LIKE '%по четверг%'
               OR COALESCE(description_lc, lower(description)) LIKE '%по пятниц%'
               OR COALESCE(description_lc, lower(description)) LIKE '%по суббот%'
               OR COALESCE(description_lc, lower(description)) LIKE '%по воскресень%')`
        ).run();
      }
    })();
    recurringColumnReady.catch(() => { recurringColumnReady = null; });
  }
  return recurringColumnReady;
}

/**
 * Колонка by_admin («заявку подал администратор») — тот же сценарий, что у
 * recurring: ALTER делает сам воркер, миграция не нужна. Отделяет заявки,
 * которые принёс сам админ (свой Telegram боту, форма с ключом админки),
 * от заявок посторонних людей с сайта: дедупликация для них работает
 * по-разному, и в очереди модерации происхождение видно штампом.
 */
export function ensureByAdminColumn(env: Env): Promise<void> {
  if (!byAdminColumnReady) {
    byAdminColumnReady = (async () => {
      const info = await env.DB.prepare(`PRAGMA table_info(listings)`).all();
      const names = new Set(
        ((info.results ?? []) as unknown as Array<Record<string, unknown>>).map((r) => String(r.name))
      );
      if (!names.has('by_admin')) {
        await env.DB.prepare(`ALTER TABLE listings ADD COLUMN by_admin INTEGER DEFAULT 0`).run();
      }
    })();
    byAdminColumnReady.catch(() => { byAdminColumnReady = null; });
  }
  return byAdminColumnReady;
}

/**
 * Заявка от администратора? Колонке по умолчанию доверяем, а старые строки
 * (заявки админа из Telegram до появления колонки) узнаём по sourceChatId —
 * личные сообщения боту от админских ID.
 */
export function isAdminOrigin(env: Env, l: Listing): boolean {
  if (l.byAdmin) return true;
  return l.source === 'telegram'
    && !!l.sourceChatId
    && admins(env).includes(l.sourceChatId);
}

/**
 * Колонка hidden («скрыта с публичной доски») — тот же сценарий, что у
 * recurring и by_admin: ALTER делает сам воркер, миграция не нужна.
 */
export function ensureHiddenColumn(env: Env): Promise<void> {
  if (!hiddenColumnReady) {
    hiddenColumnReady = (async () => {
      const info = await env.DB.prepare(`PRAGMA table_info(listings)`).all();
      const names = new Set(
        ((info.results ?? []) as unknown as Array<Record<string, unknown>>).map((r) => String(r.name))
      );
      if (!names.has('hidden')) {
        await env.DB.prepare(`ALTER TABLE listings ADD COLUMN hidden INTEGER DEFAULT 0`).run();
      }
    })();
    hiddenColumnReady.catch(() => { hiddenColumnReady = null; });
  }
  return hiddenColumnReady;
}

/**
 * Заявка «ищу попутчика» с сайта без контакта: публикуем автоматически, но
 * прячем с доски — видна только в подборе. Владелец сайта пишет людям сам,
 * а заявка живёт ограниченный срок и удаляется cron'ом.
 * Не касается админских заявок и заявок из Telegram/чатов — те идут как обычно.
 */
export function isHiddenRequestInput(input: ListingInput): boolean {
  return input.type === 'request'
    && !input.telegram
    && !input.phone
    && input.source === 'site'
    && input.fromPerson === true;
}

/**
 * Заявку подал посторонний человек сам: написал боту в личку или отправил
 * форму на сайте без ключа админки. Заявки из чатов (парсер) сюда не входят —
 * там человек нам ничего не подавал. Старые строки до колонки узнаём по
 * sourceChat «Личное сообщение боту».
 */
export function isPersonOrigin(env: Env, l: Listing): boolean {
  if (l.fromPerson) return true;
  if (isAdminOrigin(env, l)) return false;
  return !!l.sourceChat && l.sourceChat.startsWith('Личное сообщение боту');
}

interface WhereClause { sql: string; params: (string | number)[] }

function buildWhere(f: ListFilters): WhereClause {
  let sql: string;
  const params: (string | number)[] = [];
  if (f.archive) {
    // Архив (вкладка на доске): помеченные cron'ом ('expired')
    // и ещё не помеченные просроченные ('published' с прошедшей датой).
    // Регулярные рейсы в архив не попадают: cron катит их дату вперёд.
    // Скрытые (без контакта, только для подбора) в публичном архиве не показываем
    sql = " WHERE (status = 'expired' OR (status = 'published' AND recurring IS NULL AND departure_date IS NOT NULL AND departure_date < date('now', '+3 hours'))) AND (hidden IS NULL OR hidden != 1)";
  } else {
    sql = ' WHERE status = ?';
    params.push(f.status ?? 'published');
    // Доска показывает только актуальные заявки: дата выезда не прошла
    // (или не указана). Просроченные живут в архиве — см. archiveExpired.
    // Регулярные показываем и с прошедшей датой: расписание ещё живо,
    // ближайший заезд cron посчитает.
    if ((f.status ?? 'published') === 'published') {
      sql += " AND (departure_date IS NULL OR departure_date >= date('now', '+3 hours') OR recurring IS NOT NULL)";
      // скрытые заявки — не для публичной доски (видны в подборе и админке)
      sql += ' AND (hidden IS NULL OR hidden != 1)';
    }
  }
  if (f.from) { sql += ` AND from_city_lc LIKE ? ESCAPE '\\'`; params.push(likeContains(f.from)); }
  if (f.to) { sql += ` AND to_city_lc LIKE ? ESCAPE '\\'`; params.push(likeContains(f.to)); }
  if (f.date) { sql += ' AND departure_date = ?'; params.push(f.date); }
  if (f.q) {
    const pattern = likeContains(f.q);
    sql += ` AND (description_lc LIKE ? ESCAPE '\\' OR from_city_lc LIKE ? ESCAPE '\\' OR to_city_lc LIKE ? ESCAPE '\\')`;
    params.push(pattern, pattern, pattern);
  }
  return { sql, params };
}

/** Количество объявлений по типам с учётом фильтров поиска (без учёта вкладки-типа). */
export async function getCounts(env: Env, f: ListFilters): Promise<{ offer: number; request: number }> {
  // тот же buildWhere, что у listListings: recurring нужен всегда
  await ensureRecurringColumn(env);
  if (f.from || f.to || f.q) await ensureSearchColumns(env);
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
/**
 * Заявки для подбора пар. Включает и скрытые (hidden) — в этом весь смысл:
 * заявка без контакта невидима на доске, но в подборе владелец её видит.
 */
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

/* ------------------------------------------------------------------ */
/* Дубликаты: одно и то же объявление, присланное несколько раз         */
/* ------------------------------------------------------------------ */

/**
 * Кандидаты в дубликаты: тот же тип и дата выезда рядом (±1 день), статус
 * живой (на модерации, на доске или в архиве). Маршрут, контакты и текст
 * сравнивает src/dedupe.ts — там города нормализуются, а телефоны сверяются
 * по последним цифрам, поэтому в SQL эти условия не унести.
 */
export async function findDuplicateCandidates(env: Env, input: DedupeSubject): Promise<Listing[]> {
  const date = input.departureDate ?? null;
  const res = await env.DB.prepare(
    `SELECT * FROM listings
      WHERE status IN ('pending', 'published', 'expired')
        AND type = ?
        AND (? IS NULL OR departure_date IS NULL
             OR ABS(julianday(departure_date) - julianday(?)) <= 1)
      ORDER BY (status = 'published') DESC, COALESCE(published_at, created_at) DESC
      LIMIT 200`
  ).bind(input.type, date, date).all();
  return ((res.results ?? []) as unknown as Array<Record<string, unknown>>).map(mapRow);
}

/**
 * Есть ли уже такая заявка: 'duplicate' — уверенно та же (не создаём вторую),
 * 'similar' — похожая (создаём, но модератора предупредим).
 */
export async function findDuplicate(
  env: Env,
  input: DedupeSubject
): Promise<DuplicateHit<Listing> | null> {
  const candidates = await findDuplicateCandidates(env, input);
  return pickDuplicate(candidates, input);
}

/**
 * Освежить существующую заявку вместо создания дубля: published поднимается
 * наверх доски (повторное «еду 20 сентября» снова свежее), pending остаётся
 * в очереди модерации, архив не трогаем — его вернул туда модератор или дата.
 */
export async function touchListing(env: Env, id: string): Promise<Listing | null> {
  const listing = await getListingById(env, id);
  if (!listing) return null;
  if (listing.status === 'published') {
    await env.DB.prepare(
      "UPDATE listings SET published_at = datetime('now') WHERE id = ?"
    ).bind(id).run();
  }
  return getListingById(env, id);
}

/**
 * Создать заявку, но не плодить дубликаты: если такая уже есть — вернуть её
 * (и освежить, если она на доске). Через неё идут все источники: пересылки,
 * сообщения в чатах, мастер /post и форма на сайте.
 */
export async function createListingSafe(
  env: Env,
  input: ListingInput,
  opts: { force?: boolean } = {}
): Promise<{
  listing: Listing;
  created: boolean;
  duplicateOf: Listing | null;
  kind: DuplicateKind | null;
  why: string;
}> {
  const hit = await findDuplicate(env, input);
  // force — заявку создаём в любом случае (например, /post человек заполнил сам),
  // но сведения о дубле возвращаем: модератор увидит предупреждение.
  if (hit && hit.kind === 'duplicate' && !opts.force) {
    const refreshed = await touchListing(env, hit.listing.id);
    const listing = refreshed ?? hit.listing;
    return { listing, created: false, duplicateOf: listing, kind: 'duplicate', why: hit.why };
  }
  const listing = await createListing(env, input);
  return {
    listing,
    created: true,
    duplicateOf: hit ? hit.listing : null,
    kind: hit ? hit.kind : null,
    why: hit ? hit.why : '',
  };
}

/* ------------------------------------------------------------------ */
/* Разбор накопившихся дублей                                          */
/* ------------------------------------------------------------------ */

/** Все живые заявки — для поиска дублей, которые накопились до защиты. */
export async function listForDuplicateSweep(
  env: Env,
  opts: { includeArchive?: boolean; limit?: number } = {}
): Promise<Listing[]> {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 500));
  const statuses = opts.includeArchive
    ? "('pending', 'published', 'expired')"
    : "('pending', 'published')";
  const res = await env.DB.prepare(
    `SELECT * FROM listings WHERE status IN ${statuses}
     ORDER BY COALESCE(published_at, created_at) DESC LIMIT ?`
  ).bind(limit).all();
  return ((res.results ?? []) as unknown as Array<Record<string, unknown>>).map(mapRow);
}

/** Удалить несколько заявок разом (чистка дублей). */
export async function deleteListings(env: Env, ids: string[]): Promise<number> {
  let deleted = 0;
  for (const id of ids) {
    if (await deleteListing(env, id)) deleted++;
  }
  return deleted;
}

/* ------------------------------------------------------------------ */
/* Для SEO-страниц: пары городов, города, ссылки для sitemap            */
/* ------------------------------------------------------------------ */

/**
 * Что вообще видно на сайте: опубликованные заявки с не прошедшей датой
 * и архив (месяц после даты выезда, потом cron удаляет). Регулярные рейсы
 * («каждый четверг») видны всегда, пока cron катит их дату вперёд.
 * Тот же набор, что показывают доска и /api/listings — иначе страницы
 * маршрутов появлялись бы и исчезали каждый день.
 */
const VISIBLE_WHERE = `(
    (status = 'published' AND (departure_date IS NULL OR departure_date >= date('now', '+3 hours') OR recurring IS NOT NULL))
    OR (status = 'expired' AND departure_date IS NOT NULL AND departure_date >= date('now', '+3 hours', '-30 days'))
  ) AND (hidden IS NULL OR hidden != 1)`;

/** Активная заявка: на доске прямо сейчас (не архив). */
const ACTIVE_EXPR = `CASE WHEN status = 'published' AND (departure_date IS NULL OR departure_date >= date('now', '+3 hours') OR recurring IS NOT NULL) THEN 1 ELSE 0 END`;

export interface RoutePair {
  fromCity: string;
  toCity: string;
  /** сколько заявок видно на сайте (активные + архив месяца) */
  total: number;
  /** сколько из них на доске прямо сейчас */
  active: number;
  /** когда последний раз публиковали — для lastmod в sitemap */
  lastmod: string;
}

/**
 * Пары городов, которые реально встречаются в заявках.
 * Страница маршрута создаётся, только если есть хотя бы одна активная заявка:
 * пустые страницы — это тонкий контент, который поисковик не любит.
 */
export async function listRoutePairs(env: Env, limit = 500): Promise<RoutePair[]> {
  const res = await env.DB.prepare(
    `SELECT from_city, to_city,
            COUNT(*) AS total,
            SUM(${ACTIVE_EXPR}) AS active,
            MAX(COALESCE(published_at, created_at)) AS lastmod
       FROM listings
      WHERE ${VISIBLE_WHERE}
      GROUP BY from_city, to_city
     HAVING active >= 1
      ORDER BY active DESC, total DESC, from_city
      LIMIT ?`
  ).bind(Math.min(1000, Math.max(1, limit))).all();

  return ((res.results ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
    fromCity: String(r.from_city),
    toCity: String(r.to_city),
    total: Number(r.total ?? 0),
    active: Number(r.active ?? 0),
    lastmod: String(r.lastmod ?? '').slice(0, 10),
  }));
}

export interface CityStat {
  city: string;
  /** заявок, где город — точка отправления или назначения */
  count: number;
  active: number;
  lastmod: string;
}

/** Города, которые встречаются в заявках (откуда или куда). */
export async function listCityStats(env: Env, limit = 300): Promise<CityStat[]> {
  const res = await env.DB.prepare(
    `SELECT city, COUNT(*) AS count, SUM(active) AS active, MAX(lastmod) AS lastmod
       FROM (
         SELECT from_city AS city, ${ACTIVE_EXPR} AS active, COALESCE(published_at, created_at) AS lastmod
           FROM listings WHERE ${VISIBLE_WHERE}
         UNION ALL
         SELECT to_city AS city, ${ACTIVE_EXPR} AS active, COALESCE(published_at, created_at) AS lastmod
           FROM listings WHERE ${VISIBLE_WHERE}
       )
      GROUP BY city
      ORDER BY active DESC, count DESC, city
      LIMIT ?`
  ).bind(Math.min(1000, Math.max(1, limit))).all();

  return ((res.results ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
    city: String(r.city),
    count: Number(r.count ?? 0),
    active: Number(r.active ?? 0),
    lastmod: String(r.lastmod ?? '').slice(0, 10),
  }));
}

export interface SitemapItem {
  id: string;
  lastmod: string;
}

/** Объявления для sitemap: те же, что видны на сайте, последними изменениями вперёд. */
export async function listSitemapItems(env: Env, limit = 5000): Promise<SitemapItem[]> {
  const res = await env.DB.prepare(
    `SELECT id, COALESCE(published_at, created_at) AS lastmod
       FROM listings
      WHERE ${VISIBLE_WHERE}
      ORDER BY lastmod DESC
      LIMIT ?`
  ).bind(Math.min(20000, Math.max(1, limit))).all();

  return ((res.results ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    lastmod: String(r.lastmod ?? '').slice(0, 10),
  }));
}

/* ------------------------------------------------------------------ */
/* Статистика по месяцам: исходные строки и снимки итогов              */
/* ------------------------------------------------------------------ */

/**
 * Месяц объявления — когда оно попало на доску (published_at), а не когда
 * было создано черновиком. Считаем только то, что реально публиковали:
 * снятые за фейк «rejected» в итоги не идут.
 */
const MONTH_EXPR = `strftime('%Y-%m', COALESCE(published_at, created_at))`;

/** Таблица снимков: итоги месяца переживают удаление самих объявлений. */
export async function ensureStatsTable(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS stats_months (
       month TEXT PRIMARY KEY,
       total INTEGER NOT NULL DEFAULT 0,
       payload TEXT NOT NULL DEFAULT '{}',
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`
  ).run();
  await ensureStatsSummaryColumn(env);
}

let statsSummaryReady: Promise<void> | null = null;

/**
 * Колонка summary (аналитическое «мнение» месяца для страницы /itogi/…) —
 * тот же сценарий, что у recurring и *_lc: ALTER делает сам воркер,
 * отдельная миграция не нужна и не мешает порядку «миграции → деплой».
 */
export function ensureStatsSummaryColumn(env: Env): Promise<void> {
  if (!statsSummaryReady) {
    statsSummaryReady = (async () => {
      const info = await env.DB.prepare(`PRAGMA table_info(stats_months)`).all();
      const names = new Set(
        ((info.results ?? []) as unknown as Array<Record<string, unknown>>).map((r) => String(r.name))
      );
      if (!names.has('summary')) {
        await env.DB.prepare(`ALTER TABLE stats_months ADD COLUMN summary TEXT`).run();
      }
    })();
    statsSummaryReady.catch(() => { statsSummaryReady = null; });
  }
  return statsSummaryReady;
}

export interface MonthRow {
  id: string;
  type: 'offer' | 'request';
  fromCity: string;
  toCity: string;
  price: string | null;
  source: string | null;
}

/** Объявления месяца — сырьё для подсчёта (цена как написана человеком). */
export async function listMonthRows(env: Env, month: string): Promise<MonthRow[]> {
  const res = await env.DB.prepare(
    `SELECT id, type, from_city, to_city, price, source
       FROM listings
      WHERE status IN ('published', 'expired')
        AND ${MONTH_EXPR} = ?
      ORDER BY COALESCE(published_at, created_at)`
  ).bind(month).all();

  return ((res.results ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    type: r.type === 'request' ? 'request' : 'offer',
    fromCity: String(r.from_city ?? ''),
    toCity: String(r.to_city ?? ''),
    price: r.price == null ? null : String(r.price),
    source: r.source == null ? null : String(r.source),
  }));
}

/** В каких месяцах есть опубликованные объявления. */
export async function listMonthsPresent(env: Env): Promise<string[]> {
  const res = await env.DB.prepare(
    `SELECT DISTINCT ${MONTH_EXPR} AS month
       FROM listings
      WHERE status IN ('published', 'expired')
      ORDER BY month DESC
      LIMIT 60`
  ).all();
  return ((res.results ?? []) as unknown as Array<Record<string, unknown>>)
    .map((r) => String(r.month))
    .filter((m) => /^\d{4}-\d{2}$/.test(m));
}

export interface StatsSnapshot {
  month: string;
  total: number;
  /** итог месяца целиком (см. MonthStat в src/stats.ts) */
  payload: string;
  /** аналитическая заметка месяца (ИИ или шаблон) — для страницы /itogi/… */
  summary: string | null;
  updatedAt: string;
}

/** Все сохранённые итоги, свежими вперёд. */
export async function loadStatsSnapshots(env: Env): Promise<StatsSnapshot[]> {
  await ensureStatsTable(env);
  const res = await env.DB.prepare(
    `SELECT month, total, payload, summary, updated_at FROM stats_months ORDER BY month DESC LIMIT 60`
  ).all();
  return ((res.results ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
    month: String(r.month),
    total: Number(r.total ?? 0),
    payload: String(r.payload ?? '{}'),
    summary: r.summary ? String(r.summary) : null,
    updatedAt: String(r.updated_at ?? ''),
  }));
}

/** Один снимок месяца (страница /itogi/:month) или null. */
export async function getMonthSnapshot(env: Env, month: string): Promise<StatsSnapshot | null> {
  await ensureStatsTable(env);
  const row = (await env.DB.prepare(
    `SELECT month, total, payload, summary, updated_at FROM stats_months WHERE month = ?`
  ).bind(month).first()) as Record<string, unknown> | null;
  if (!row) return null;
  return {
    month: String(row.month),
    total: Number(row.total ?? 0),
    payload: String(row.payload ?? '{}'),
    summary: row.summary ? String(row.summary) : null,
    updatedAt: String(row.updated_at ?? ''),
  };
}

/** Сохранить итог месяца. summary передан — перезаписываем, нет — не трогаем
 *  (снимок пересчитывается ежедневно, а текст живёт своим сроком). */
export async function saveStatsSnapshot(
  env: Env,
  month: string,
  total: number,
  payload: unknown,
  summary?: string | null
): Promise<void> {
  await ensureStatsTable(env);
  await env.DB.prepare(
    `INSERT INTO stats_months (month, total, payload, summary, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(month) DO UPDATE SET
       total = excluded.total,
       payload = excluded.payload,
       summary = COALESCE(excluded.summary, stats_months.summary),
       updated_at = excluded.updated_at`
  ).bind(month, total, JSON.stringify(payload), summary ?? null).run();
}

/** Сохранить только аналитическую заметку месяца (кнопка в админке, ИИ). */
export async function saveMonthSummary(env: Env, month: string, summary: string): Promise<boolean> {
  await ensureStatsTable(env);
  const res = await env.DB.prepare(
    'UPDATE stats_months SET summary = ? WHERE month = ?'
  ).bind(summary, month).run();
  return (res.meta.changes ?? 0) > 0;
}

/* (сохранение снимков — saveStatsSnapshot выше, рядом с StatsSnapshot) */
