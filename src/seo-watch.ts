/**
 * SEO-видимость сайта — два бесплатных измерителя:
 *
 * 1. Присутствие в открытых корпусах (Common Crawl, Wayback Machine).
 *    Common Crawl — краулер, на данных которого учатся LLM: если сайт
 *    попадает в свежие краулы, он «существует» для ИИ-систем. Wayback —
 *    веб-архив, плюс к этому публичная история сайта.
 * 2. Позиции в поиске (SerpApi, бесплатный лимит 100 поисков/мес):
 *    20 запросов раз в неделю ≈ 85 проверок в месяц.
 *
 * Все внешние вызовы — чистые функции разбора ответов вынесены отдельно:
 * они тестируются юнитами без сети.
 */
import type { Env } from './types';
import { listSerpQueries, saveAiRun, saveSerpChecks } from './store';

/** Домен сайта из SITE_URL: 'https://pop-utka.app/' → 'pop-utka.app'. */
export function siteDomain(siteUrl: string | null | undefined): string {
  if (!siteUrl) return '';
  try {
    return new URL(siteUrl).hostname.replace(/^www\./, '').replace(/\/+$/, '');
  } catch {
    return siteUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  }
}

/** Хостнейм ссылки — для сравнения с нашим доменом (учёт www и поддоменов). */
export function hostnameOf(url: string | null | undefined): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Наш ли это домен: точное совпадение или поддомен. */
export function isOwnHost(host: string, domain: string): boolean {
  if (!host || !domain) return false;
  return host === domain || host.endsWith(`.${domain}`);
}

/* ------------------------------------------------------------------ */
/* Common Crawl                                                        */
/* ------------------------------------------------------------------ */

export interface CcCollection { id: string; name?: string }

/** Список коллекций Common Crawl (свежие первыми) — публичный JSON без ключа. */
export async function fetchCcCollections(timeoutMs = 20000): Promise<CcCollection[]> {
  const res = await fetch('https://index.commoncrawl.org/collinfo.json', {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`collinfo HTTP ${res.status}`);
  const list = (await res.json()) as CcCollection[];
  if (!Array.isArray(list)) throw new Error('collinfo: неожиданный ответ');
  return list;
}

export interface CcPresence {
  collection: string;
  captures: number;
  pages: number;
  urls: string[];
}

/**
 * Разобрать ответ индекса CC (NDJSON, по строке на захват). Считаем уникальные
 * URL — «сколько страниц сайта видел краулер», а не сколько раз их брали.
 */
export function parseCcIndex(text: string): { captures: number; urls: string[] } {
  const urls = new Set<string>();
  let captures = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t) as { url?: string };
      captures += 1;
      if (row.url) urls.add(row.url);
    } catch { /* битая строка — не считаем */ }
  }
  return { captures, urls: [...urls].sort() };
}

/** Сколько страниц домена есть в конкретной коллекции CC. */
export async function fetchCcPresence(
  collection: string,
  domain: string,
  timeoutMs = 25000
): Promise<CcPresence> {
  const url = `https://index.commoncrawl.org/${collection}-index`
    + `?url=${encodeURIComponent(`${domain}/*`)}&output=json&filter=status:200&limit=500`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 404) return { collection, captures: 0, pages: 0, urls: [] };
  if (!res.ok) throw new Error(`CC ${collection} HTTP ${res.status}`);
  const { captures, urls } = parseCcIndex(await res.text());
  return { collection, captures, pages: urls.length, urls };
}

/* ------------------------------------------------------------------ */
/* Wayback Machine                                                     */
/* ------------------------------------------------------------------ */

export interface WaybackPresence {
  pages: number;
  urls: string[];
  lastSnapshot: string | null; // 'YYYY-MM-DD'
}

/**
 * Разобрать CDX-ответ (output=json): строки [timestamp, original, ...],
 * первая может быть заголовком. Возвращает уникальные URL и дату свежего
 * снимка — «насколько жив сайт для веб-архива».
 */
export function parseCdxRows(rows: unknown): { urls: string[]; lastSnapshot: string | null } {
  const urls = new Set<string>();
  let last = '';
  if (!Array.isArray(rows)) return { urls: [], lastSnapshot: null };
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const ts = String(row[0] ?? '');
    const original = String(row[1] ?? '');
    if (!/^\d{12,14}$/.test(ts) || !original) continue; // заголовок или мусор
    urls.add(original);
    if (ts > last) last = ts;
  }
  const lastSnapshot = last
    ? `${last.slice(0, 4)}-${last.slice(4, 6)}-${last.slice(6, 8)}`
    : null;
  return { urls: [...urls].sort(), lastSnapshot };
}

/** Что веб-архив знает о домене (уникальные снимавшиеся URL). */
export async function fetchWaybackPresence(
  domain: string,
  timeoutMs = 20000
): Promise<WaybackPresence> {
  const url = `https://web.archive.org/cdx/search/cdx`
    + `?url=${encodeURIComponent(domain)}*&output=json&collapse=urlkey`
    + `&filter=statuscode:200&fl=timestamp,original&limit=500`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`CDX HTTP ${res.status}`);
  const { urls, lastSnapshot } = parseCdxRows(await res.json());
  return { pages: urls.length, urls, lastSnapshot };
}

/* ------------------------------------------------------------------ */
/* SerpApi: позиции                                                    */
/* ------------------------------------------------------------------ */

export interface SerpOrganic { position?: number; link?: string; url?: string; domain?: string }

export interface SerpMatch { position: number | null; url: string | null; top: string[] }

/** Найти наш сайт в органике выдачи + кто занял топ-5. */
export function findOwnPosition(organic: SerpOrganic[], domain: string): SerpMatch {
  const top: string[] = [];
  for (const [i, item] of organic.entries()) {
    const link = item.link ?? item.url ?? null;
    const host = item.domain ?? hostnameOf(link);
    if (top.length < 5 && host) top.push(host);
    if (isOwnHost(host, domain)) {
      return { position: item.position ?? i + 1, url: link, top };
    }
  }
  return { position: null, url: null, top };
}

/** URL запроса к SerpApi под конкретный движок. */
export function serpApiUrl(engine: string, query: string, apiKey: string): string {
  const base = 'https://serpapi.com/search.json';
  if (engine === 'yandex') {
    return `${base}?engine=yandex&text=${encodeURIComponent(query)}&lr=157&api_key=${encodeURIComponent(apiKey)}`;
  }
  return `${base}?engine=google&q=${encodeURIComponent(query)}&hl=ru&gl=by&num=20&api_key=${encodeURIComponent(apiKey)}`;
}

/* ------------------------------------------------------------------ */
/* Прогоны (пишут в базу)                                              */
/* ------------------------------------------------------------------ */

export interface AiCheckSummary {
  domain: string;
  cc: Array<{ label: string; pages: number; urls: string[] }>;
  wayback: { pages: number; urls: string[]; lastSnapshot: string | null };
}

/** Замерить присутствие в корпусах и записать в ai_runs. */
export async function runAiVisibilityCheck(
  env: Env,
  opts: { collections?: number } = {}
): Promise<AiCheckSummary> {
  const domain = siteDomain(env.SITE_URL);
  if (!domain) throw new Error('SITE_URL не задан — домен для проверки неизвестен');
  const want = Math.max(1, Math.min(6, opts.collections ?? 3));
  const colls = await fetchCcCollections();
  const picked = colls.slice(0, want).map((c) => c.id);
  const cc: AiCheckSummary['cc'] = [];
  for (const id of picked) {
    const p = await fetchCcPresence(id, domain);
    cc.push({ label: id, pages: p.pages, urls: p.urls });
    await saveAiRun(env, { kind: 'commoncrawl', label: id, pages: p.pages, urls: p.urls });
  }
  const wayback = await fetchWaybackPresence(domain);
  await saveAiRun(env, { kind: 'wayback', label: 'wayback', pages: wayback.pages, urls: wayback.urls });
  return { domain, cc, wayback };
}

export interface SerpCheckSummary {
  checked: number;
  found: number;
  errors: string[];
}

/**
 * Проверить позиции всех активных запросов (SerpApi). Запросы идут пачками
 * по 5, чтобы уложиться в минуты, а не в десятки минут.
 */
export async function runSerpCheck(env: Env): Promise<SerpCheckSummary> {
  if (!env.SERPAPI_KEY) throw new Error('нет SERPAPI_KEY');
  const domain = siteDomain(env.SITE_URL);
  if (!domain) throw new Error('SITE_URL не задан');
  const apiKey = env.SERPAPI_KEY;
  const queries = await listSerpQueries(env);
  const errors: string[] = [];
  let found = 0;
  const batch: Array<{ queryId: string; position: number | null; foundUrl: string | null; top: string[] }> = [];
  for (let i = 0; i < queries.length; i += 5) {
    const slice = queries.slice(i, i + 5);
    const results = await Promise.allSettled(slice.map(async (q) => {
      const res = await fetch(serpApiUrl(q.engine, q.query, apiKey), {
        signal: AbortSignal.timeout(30000),
      });
      const data = (await res.json().catch(() => ({}))) as {
        organic_results?: SerpOrganic[]; organic?: SerpOrganic[]; error?: string;
      };
      if (data.error) throw new Error(data.error);
      const organic = data.organic_results ?? data.organic ?? [];
      const m = findOwnPosition(organic, domain);
      return { queryId: q.id, position: m.position, foundUrl: m.url, top: m.top };
    }));
    for (const [j, r] of results.entries()) {
      if (r.status === 'fulfilled') {
        if (r.value.position != null) found += 1;
        batch.push(r.value);
      } else {
        errors.push(`${slice[j]!.query}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      }
    }
  }
  if (batch.length > 0) await saveSerpChecks(env, batch);
  return { checked: batch.length, found, errors };
}
