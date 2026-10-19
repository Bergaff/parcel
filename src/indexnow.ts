/**
 * IndexNow — мгновенная переиндексация в Яндексе, Bing и остальных участниках.
 *
 * Повод: разбор Search Console показал, что сайт в индексе Google только с
 * 18 сентября и растёт, а Яндекса в инструментах нет вообще (ни IndexNow, ни
 * Метрики), хотя для Беларуси и России это половина поиска. Новые и правленые
 * объявления попадают в индекс «когда дойдут руки у краулера» — IndexNow
 * сообщает поисковикам сразу.
 *
 * Устроено так, чтобы не тормозить запросы и не терять уведомления:
 *  1. любое изменение объявления кладёт URL в таблицу-очередь `indexnow_queue`
 *     (чистая запись в D1, без сети — см. хуки в `src/store.ts`);
 *  2. обработчик `/api/*` после мутирующего запроса сливает очередь через
 *     `ctx.waitUntil` — ответ пользователю этого не ждёт;
 *  3. если сеть не ответила, URL возвращаются в очередь и уходят следующим
 *     разом (плюс ежедневный слив в cron);
 *  4. ключ IndexNow живёт в KV и отдаётся по `/indexnow-key.txt` — так его не
 *     нужно заводить руками в секретах.
 */

import type { Env } from './types';
import { routeSlug } from './seo';

/**
 * Минимальный образ fetch: в тестах удобно подделывать, а настоящий `fetch`
 * подходит под него структурно (принимает более широкий тип аргументов).
 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ status: number }>;

/** Путь, по которому поисковики проверяют владение ключом. */
export const KEY_LOCATION_PATH = '/indexnow-key.txt';

const KEY_KV = 'indexnow:key';
const ORIGIN_FALLBACK = 'https://pop-utka.app';

/** Куда шлём: один общий вход IndexNow и запасной — напрямую Яндексу. */
const ENDPOINTS = [
  'https://api.indexnow.org/indexnow',
  'https://yandex.com/indexnow',
];

/** Сколько URL за один слив (лимит IndexNow — 10 000, нам столько не нужно). */
const FLUSH_LIMIT = 500;

export async function ensureIndexNowTable(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS indexnow_queue (
       path TEXT PRIMARY KEY,
       queued_at TEXT NOT NULL
     )`
  ).run();
}

/** 32 шестнадцатеричных символа — формат ключа IndexNow. */
export function generateKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Ключ IndexNow: из секретов, иначе из KV, иначе создаём и кладём в KV. */
export async function getIndexNowKey(env: Env): Promise<string> {
  const explicit = env.INDEXNOW_KEY?.trim();
  if (explicit) return explicit;
  const cached = await env.KV.get(KEY_KV).catch(() => null);
  if (cached) return cached;
  const key = generateKey();
  await env.KV.put(KEY_KV, key).catch(() => undefined);
  return key;
}

/** Адреса, которые стоит сообщить поисковикам при изменении объявления. */
export function listingPaths(id: string, fromCity: string, toCity: string): string[] {
  const paths = [`/item/${encodeURIComponent(id)}`];
  // страница маршрута меняется вместе с объявлением: число заявок, даты.
  // Без городов слаг вырождается в «-» — такой адрес сообщать нельзя: он 404
  const hasCities = fromCity.trim().length > 0 && toCity.trim().length > 0;
  const route = hasCities ? routeSlug(fromCity, toCity) : '';
  if (route && route !== '-') paths.push(`/r/${route}`);
  return paths;
}

/** Положить адреса в очередь. Дубли гасятся первичным ключом. */
export async function queuePaths(env: Env, paths: string[]): Promise<number> {
  const unique = [...new Set(paths.map((p) => p.trim()).filter(Boolean))];
  if (unique.length === 0) return 0;
  await ensureIndexNowTable(env);
  const now = new Date().toISOString();
  await env.DB.batch(unique.map((p) =>
    env.DB.prepare(
      'INSERT OR IGNORE INTO indexnow_queue (path, queued_at) VALUES (?, ?)'
    ).bind(p, now)
  ));
  return unique.length;
}

/** Взять очередь на слив: читаем и сразу удаляем, чтобы не слать дважды. */
export async function takeQueuedPaths(env: Env, limit = FLUSH_LIMIT): Promise<string[]> {
  await ensureIndexNowTable(env);
  const res = await env.DB.prepare(
    'SELECT path FROM indexnow_queue ORDER BY queued_at LIMIT ?'
  ).bind(Math.max(1, Math.floor(limit))).all();
  const paths = ((res.results ?? []) as unknown as Array<{ path: string }>).map((r) => String(r.path));
  if (paths.length === 0) return [];
  await env.DB.batch(paths.map((p) =>
    env.DB.prepare('DELETE FROM indexnow_queue WHERE path = ?').bind(p)
  ));
  return paths;
}

/** Тело запроса к IndexNow. */
export function submitBody(host: string, key: string, keyLocation: string, paths: string[]): string {
  return JSON.stringify({
    host,
    key,
    keyLocation,
    urlList: paths.map((p) => `https://${host}${p}`),
  });
}

/** Один слив очереди. Вернулось false — адреса вернутся в очередь. */
export async function submitPaths(
  env: Env,
  origin: string,
  paths: string[],
  fetchImpl: FetchLike = fetch
): Promise<{ ok: boolean; status: number; endpoint: string | null }> {
  const host = new URL(origin).host;
  const key = await getIndexNowKey(env);
  const body = submitBody(host, key, `${origin}${KEY_LOCATION_PATH}`, paths);
  for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body,
      });
      // 200 и 202 — принято; остальное пробуем на следующем входе
      if (res.status === 200 || res.status === 202) return { ok: true, status: res.status, endpoint };
      if (res.status >= 500) continue;
      // 4xx: менять вход бессмысленно (ключ или адреса не понравились)
      return { ok: false, status: res.status, endpoint };
    } catch {
      // сеть недоступна (локальная разработка) — пробуем следующий вход
    }
  }
  return { ok: false, status: 0, endpoint: null };
}

/**
 * Слить очередь в IndexNow. Возвращает число отправленных адресов.
 * Не бросает исключений: переиндексация не должна ломать запрос.
 */
export async function flushIndexNow(
  env: Env,
  origin = env.SITE_URL?.trim() || ORIGIN_FALLBACK,
  fetchImpl: FetchLike = fetch
): Promise<number> {
  const paths = await takeQueuedPaths(env);
  if (paths.length === 0) return 0;
  const res = await submitPaths(env, origin, paths, fetchImpl);
  if (!res.ok) {
    // не ушло — возвращаем в очередь, следующий запрос или cron повторит
    await queuePaths(env, paths).catch(() => undefined);
    return 0;
  }
  return paths.length;
}

/**
 * Поставить в очередь адреса объявления по его id: используется хуками в
 * `src/store.ts`, где под рукой только идентификатор.
 */
export async function queueListingChange(env: Env, id: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT id, from_city, to_city FROM listings WHERE id = ?'
  ).bind(id).first<Record<string, unknown> | null>();
  if (!row?.id) return 0;
  return queuePaths(env, listingPaths(String(row.id), String(row.from_city ?? ''), String(row.to_city ?? '')));
}
