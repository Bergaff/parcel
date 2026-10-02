/**
 * Статистика аудитории для медиакита (pop-utka.app/mediakit).
 *
 * Независимый счётчик «как у аналитики»: воркер видит каждый просмотр
 * страницы (edge-кэш у нас программный — запрос всё равно доходит до
 * воркера), различает людей и роботов по User-Agent, обезличивает
 * посетителя суточным хешем IP+браузер (сам IP не хранится), а «живость»
 * браузера подтверждает JavaScript-маячок app.js (`/api/visit-confirm`).
 *
 * Все чистые функции (классификация UA, рефереров, страницы) вынесены
 * отдельно и тестируются юнитами без сети и базы.
 */
import type { Env } from './types';

/* ------------------------------------------------------------------ */
/* Классификация                                                       */
/* ------------------------------------------------------------------ */

/** Роботы, превью-генераторы мессенджеров, ИИ-краулеры, скрипты, мониторинги. */
const BOT_UA = new RegExp(
  'bot|crawler|spider|slurp|bingpreview|facebookexternalhit|telegrambot|whatsapp'
  + '|twitterbot|embedly|preview|monitor|uptime|headless|phantom|puppeteer|playwright'
  + '|python-requests|python-urllib|curl|wget|go-http-client|okhttp|axios|node-fetch'
  + '|scrapy|lighthouse|pagespeed|gtmetrix|gptbot|oai-searchbot|claudebot|claude-web'
  + '|anthropic-ai|google-extended|perplexitybot|amazonbot|bytespider|applebot|ccbot'
  + '|omgili|youbot|semrush|ahrefsbot|mj12bot|dotbot|petalbot|yandexbot',
  'i'
);

/** Организации VPN и дата-центров в Cloudflare asOrganization. */
const DC_ORG = /(google cloud|amazon|digitalocean|\bovh\b|hetzner|m247|datacamp|linode|vultr|leaseweb|selectel|contabo|scaleway|oracle cloud|microsoft azure|zscaler|nordvpn|surfshark|cyberghost|windscribe)/i;

export interface UaInfo { bot: boolean; device: string; os: string }

/** Кто это: робот или человек, с какого устройства и какой ОС. */
export function classifyUserAgent(ua: string): UaInfo {
  const bot = !ua.trim() || BOT_UA.test(ua);
  // Android-планшеты поймались первой веткой (Tablet); десктопные UA
  // слова Android не содержат, так что Android без «Tablet» — телефон
  let device = 'Компьютер';
  if (/iPad|Tablet|PlayBook|Silk(?!.*Mobile)/i.test(ua)) device = 'Планшет';
  else if (/Mobi|iPhone|Windows Phone|Android/i.test(ua)) device = 'Телефон';
  let os = 'Другое';
  if (/iPhone|iPad|iPod|iOS|CriOS/i.test(ua)) os = 'iOS';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(ua)) os = 'macOS';
  else if (/Linux/i.test(ua)) os = 'Linux';
  return { bot, device, os };
}

/** Похоже ли на VPN/дата-центр (по организации AS из Cloudflare). */
export function isDatacenterOrg(asOrg: string | null | undefined): boolean {
  return Boolean(asOrg) && DC_ORG.test(asOrg!);
}

export interface RefInfo { group: string; host: string | null }

/**
 * Источник захода: Telegram / Поиск / Соцсети / Другие сайты / Напрямую.
 * Переходы внутри сайта не считаются источником (как в классической аналитике).
 */
export function classifyRef(referer: string | null, siteHost: string): RefInfo {
  if (!referer) return { group: 'Напрямую', host: null };
  let host: string;
  try {
    host = new URL(referer).hostname.replace(/^www\./, '');
  } catch {
    return { group: 'Напрямую', host: null };
  }
  const bare = (d: string) => host === d || host.endsWith(`.${d}`);
  if (siteHost && bare(siteHost)) {
    return { group: 'Внутренние', host: null };
  }
  if (host === 't.me' || host === 'telegram.me' || host === 'telegram.dog' || host === 'link.tg' || bare('t.me')) {
    return { group: 'Telegram', host: 't.me' };
  }
  if (host.startsWith('google.') || bare('yandex.ru') || host.startsWith('yandex.')
    || bare('bing.com') || bare('duckduckgo.com') || bare('search.yahoo.com') || bare('go.mail.ru')) {
    return { group: 'Поиск', host };
  }
  if (['vk.com', 'ok.ru', 'facebook.com', 'instagram.com', 'x.com', 'twitter.com',
    'reddit.com', 'tiktok.com'].includes(host) || bare('youtube.com')) {
    return { group: 'Соцсети', host };
  }
  return { group: 'Другие сайты', host };
}

/** Какая это страница — для таблицы «Страницы». */
export function pageKind(path: string): string {
  if (path === '/') return 'Главная';
  if (path === '/routes' || path.startsWith('/r/')) return 'Маршруты';
  if (path === '/gorod' || path.startsWith('/gorod/')) return 'Города';
  if (path.startsWith('/item/')) return 'Карточки объявлений';
  if (path === '/itogi' || path.startsWith('/itogi/')) return 'Итоги';
  if (path === '/new') return 'Форма подачи';
  return 'Прочее';
}

/** Считаем ли просмотр: только контентные страницы сайта. */
export function isTrackablePage(path: string): boolean {
  return path === '/' || path === '/routes' || path.startsWith('/r/')
    || path === '/gorod' || path.startsWith('/gorod/')
    || path.startsWith('/item/') || path === '/itogi' || path.startsWith('/itogi/')
    || path === '/new' || path === '/how' || path === '/bot' || path === '/terms' || path === '/privacy';
}

/* ------------------------------------------------------------------ */
/* Обезличенный посетитель                                             */
/* ------------------------------------------------------------------ */

/** Суточный идентификатор: хеш соли, дня, IP и браузера. IP не хранится. */
export async function visitorId(ip: string, ua: string, day: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`visit:${salt}:${day}:${ip}:${ua}`)
  );
  return [...new Uint8Array(digest)].slice(0, 16)
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Соль для хеша: живёт в KV, создаётся один раз. */
export async function ensureSalt(env: Env): Promise<string> {
  try {
    const existing = await env.KV.get('visit-stat-salt');
    if (existing) return existing;
    const salt = crypto.randomUUID();
    await env.KV.put('visit-stat-salt', salt);
    return salt;
  } catch {
    return 'no-kv-salt'; // KV недоступен — статистика всё равно работает
  }
}

/* ------------------------------------------------------------------ */
/* Запись                                                              */
/* ------------------------------------------------------------------ */

let statTablesReady: Promise<void> | null = null;

/** Таблицы статистики создаёт сам воркер (как и остальные ensure-*). */
export function ensureStatTables(env: Env): Promise<void> {
  if (!statTablesReady) {
    statTablesReady = (async () => {
      await env.DB.batch([
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS stat_views (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts TEXT NOT NULL, day TEXT NOT NULL, vid TEXT NOT NULL, kind TEXT NOT NULL,
          bot INTEGER NOT NULL DEFAULT 0, country TEXT, device TEXT, os TEXT,
          dc INTEGER NOT NULL DEFAULT 0, ref_group TEXT, ref_host TEXT)`),
        env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_stat_views_day ON stat_views(day)'),
        env.DB.prepare('CREATE TABLE IF NOT EXISTS stat_js (day TEXT NOT NULL, vid TEXT NOT NULL, PRIMARY KEY (day, vid))'),
        env.DB.prepare('CREATE TABLE IF NOT EXISTS stat_bot_chats (chat_id TEXT PRIMARY KEY, last_seen TEXT NOT NULL)'),
        env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)'),
        // боты работали с чатами и до появления статистики — не начинаем
        // счётчик с нуля, засеиваем из истории объявлений (idempotent)
        env.DB.prepare(
          `INSERT OR IGNORE INTO stat_bot_chats (chat_id, last_seen)
           SELECT DISTINCT source_chat_id, datetime('now') FROM listings
           WHERE source_chat_id IS NOT NULL`
        ),
      ]);
    })();
    statTablesReady.catch(() => { statTablesReady = null; });
  }
  return statTablesReady;
}

export interface PageViewInput {
  path: string;
  ip: string;
  ua: string;
  country: string | null;
  asOrg: string | null;
  referer: string | null;
}

/** Записать просмотр страницы (роботов тоже пишем — их считаем «отфильтрованными»). */
export async function trackPageView(env: Env, v: PageViewInput): Promise<void> {
  await ensureStatTables(env);
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const ua = classifyUserAgent(v.ua);
  const siteHost = (() => {
    try { return env.SITE_URL ? new URL(env.SITE_URL).hostname.replace(/^www\./, '') : ''; } catch { return ''; }
  })();
  const ref = ua.bot ? { group: null, host: null } : classifyRef(v.referer, siteHost);
  const vid = ua.bot ? 'bot' : await visitorId(v.ip, v.ua, day, await ensureSalt(env));
  await env.DB.prepare(
    `INSERT INTO stat_views (ts, day, vid, kind, bot, country, device, os, dc, ref_group, ref_host)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    now.toISOString(), day, vid, pageKind(v.path), ua.bot ? 1 : 0,
    ua.bot ? null : v.country, ua.bot ? null : ua.device, ua.bot ? null : ua.os,
    isDatacenterOrg(v.asOrg) ? 1 : 0,
    ref.group ?? null, ref.host ?? null
  ).run();
}

/** Маячок из app.js: браузер живой. Отмечает посетителя дня как подтверждённого. */
export async function confirmJsVisit(env: Env, v: { ip: string; ua: string }): Promise<void> {
  const ua = classifyUserAgent(v.ua);
  if (ua.bot) return;
  await ensureStatTables(env);
  const day = new Date().toISOString().slice(0, 10);
  const vid = await visitorId(v.ip, v.ua, day, await ensureSalt(env));
  await env.DB.prepare('INSERT OR IGNORE INTO stat_js (day, vid) VALUES (?, ?)').bind(day, vid).run();
}

/** Помнить чаты, в которых бот работает (для блока Telegram-бота). */
export async function logBotChat(env: Env, chatId: string): Promise<void> {
  await ensureStatTables(env);
  await env.DB.prepare(
    `INSERT INTO stat_bot_chats (chat_id, last_seen) VALUES (?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET last_seen = excluded.last_seen`
  ).bind(chatId, new Date().toISOString()).run();
}

/** Чистка старых сырых данных (cron, раз в сутки): храним 90 дней. */
export async function pruneVisitStats(env: Env): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM stat_views WHERE day < date('now', '-90 days')"),
    env.DB.prepare("DELETE FROM stat_js WHERE day < date('now', '-90 days')"),
  ]);
}

/* ------------------------------------------------------------------ */
/* Агрегаты                                                            */
/* ------------------------------------------------------------------ */

export interface AudienceDaily { day: string; uniques: number; views: number; js: number; bots: number }

export interface AudienceStats {
  days: number;
  generatedAt: string;
  coveredDays: number;
  avgUniques: number;
  views: number;
  uniquesSum: number;
  pagesPerVisitor: string;
  jsSharePct: number;
  botsFiltered: number;
  daily: AudienceDaily[];
  countries: Array<{ country: string; views: number; share: number }>;
  dcViews: number;
  devices: Array<{ name: string; views: number; share: number }>;
  os: Array<{ name: string; views: number; share: number }>;
  sources: Array<{ name: string; views: number; share: number }>;
  referrers: Array<{ host: string; views: number; share: number }>;
  pages: Array<{ name: string; views: number; share: number }>;
  bot: { total: number; active: number };
}

/** Последние N дней (UTC), включая сегодня — для нулей в графике. */
export function lastDays(n: number): string[] {
  const out: string[] = [];
  const now = Date.now();
  for (let i = n - 1; i >= 0; i -= 1) {
    out.push(new Date(now - i * 86400e3).toISOString().slice(0, 10));
  }
  return out;
}

/** Собрать все агрегаты за период. */
export async function gatherVisitStats(env: Env, days: number): Promise<AudienceStats> {
  await ensureStatTables(env);
  const dayList = lastDays(days);
  const from = dayList[0]!;

  const [byDay, jsByDay, geo, dcRes, devRes, osRes, srcRes, refRes, pageRes, botRes] = await Promise.all([
    env.DB.prepare(
      `SELECT day, SUM(CASE WHEN bot = 0 THEN 1 ELSE 0 END) AS views,
              COUNT(DISTINCT CASE WHEN bot = 0 THEN vid END) AS uniques,
              SUM(bot) AS bots
       FROM stat_views WHERE day >= ? GROUP BY day`
    ).bind(from).all(),
    env.DB.prepare('SELECT day, COUNT(*) AS n FROM stat_js WHERE day >= ? GROUP BY day').bind(from).all(),
    env.DB.prepare(
      `SELECT COALESCE(country, '—') AS country, COUNT(*) AS n FROM stat_views
       WHERE day >= ? AND bot = 0 GROUP BY country ORDER BY n DESC LIMIT 15`
    ).bind(from).all(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM stat_views WHERE day >= ? AND bot = 0 AND dc = 1').bind(from).first(),
    env.DB.prepare(
      `SELECT COALESCE(device, '—') AS name, COUNT(*) AS n FROM stat_views
       WHERE day >= ? AND bot = 0 GROUP BY device ORDER BY n DESC`
    ).bind(from).all(),
    env.DB.prepare(
      `SELECT COALESCE(os, '—') AS name, COUNT(*) AS n FROM stat_views
       WHERE day >= ? AND bot = 0 GROUP BY os ORDER BY n DESC`
    ).bind(from).all(),
    env.DB.prepare(
      `SELECT ref_group AS name, COUNT(*) AS n FROM stat_views
       WHERE day >= ? AND bot = 0 AND ref_group IS NOT NULL AND ref_group != 'Внутренние'
       GROUP BY ref_group ORDER BY n DESC`
    ).bind(from).all(),
    env.DB.prepare(
      `SELECT ref_host AS host, COUNT(*) AS n FROM stat_views
       WHERE day >= ? AND bot = 0 AND ref_host IS NOT NULL
       GROUP BY ref_host ORDER BY n DESC LIMIT 10`
    ).bind(from).all(),
    env.DB.prepare(
      `SELECT kind AS name, COUNT(*) AS n FROM stat_views
       WHERE day >= ? AND bot = 0 GROUP BY kind ORDER BY n DESC`
    ).bind(from).all(),
    env.DB.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN last_seen >= ? THEN 1 ELSE 0 END) AS active FROM stat_bot_chats')
      .bind(new Date(Date.now() - days * 86400e3).toISOString()).first(),
  ]);

  const dayMap = new Map<string, { views: number; uniques: number; bots: number }>();
  for (const r of (byDay.results ?? []) as unknown as Array<{ day: string; views: number; uniques: number; bots: number }>) {
    dayMap.set(String(r.day), { views: Number(r.views), uniques: Number(r.uniques ?? 0), bots: Number(r.bots ?? 0) });
  }
  const jsMap = new Map<string, number>();
  for (const r of (jsByDay.results ?? []) as unknown as Array<{ day: string; n: number }>) {
    jsMap.set(String(r.day), Number(r.n));
  }
  const daily: AudienceDaily[] = dayList.map((day) => ({
    day,
    uniques: dayMap.get(day)?.uniques ?? 0,
    views: dayMap.get(day)?.views ?? 0,
    bots: dayMap.get(day)?.bots ?? 0,
    js: jsMap.get(day) ?? 0,
  }));

  const views = daily.reduce((a, d) => a + d.views, 0);
  const uniquesSum = daily.reduce((a, d) => a + d.uniques, 0);
  // день «покрыт», только если были живые посетители: день с одними
  // ботами данными не считаем (иначе «1 из 30» при нулевых людях)
  const coveredDays = daily.filter((d) => d.uniques > 0 || d.views > 0).length;
  const jsSum = daily.reduce((a, d) => a + d.js, 0);
  // доля каждой строки от общего числа просмотров (один знак после запятой)
  const withShare = <T extends object>(rows: T[], count: (r: T) => number, total: number) =>
    rows.map((r) => ({ ...r, share: total > 0 ? Math.round((count(r) / total) * 1000) / 10 : 0 }));

  return {
    days,
    generatedAt: new Date().toISOString(),
    coveredDays,
    avgUniques: coveredDays > 0 ? Math.round(uniquesSum / coveredDays) : 0,
    views,
    uniquesSum,
    pagesPerVisitor: uniquesSum > 0 ? (views / uniquesSum).toFixed(1).replace('.', ',') : '0',
    jsSharePct: uniquesSum > 0 ? Math.round((jsSum / uniquesSum) * 100) : 0,
    botsFiltered: daily.reduce((a, d) => a + d.bots, 0),
    daily,
    countries: withShare(((geo.results ?? []) as unknown as Array<{ country: string; n: number }>)
      .map((r) => ({ country: String(r.country), views: Number(r.n) })), (r) => r.views, views),
    dcViews: Number((dcRes as { n: number } | null)?.n ?? 0),
    devices: withShare(((devRes.results ?? []) as unknown as Array<{ name: string; n: number }>)
      .map((r) => ({ name: String(r.name), views: Number(r.n) })), (r) => r.views, views),
    os: withShare(((osRes.results ?? []) as unknown as Array<{ name: string; n: number }>)
      .map((r) => ({ name: String(r.name), views: Number(r.n) })), (r) => r.views, views),
    sources: withShare(((srcRes.results ?? []) as unknown as Array<{ name: string; n: number }>)
      .map((r) => ({ name: String(r.name), views: Number(r.n) })), (r) => r.views, views),
    referrers: withShare(((refRes.results ?? []) as unknown as Array<{ host: string; n: number }>)
      .map((r) => ({ host: String(r.host), views: Number(r.n) })), (r) => r.views, views),
    pages: withShare(((pageRes.results ?? []) as unknown as Array<{ name: string; n: number }>)
      .map((r) => ({ name: String(r.name), views: Number(r.n) })), (r) => r.views, views),
    bot: {
      total: Number((botRes as { total: number } | null)?.total ?? 0),
      active: Number((botRes as { active: number } | null)?.active ?? 0),
    },
  };
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

/** Ежедневная таблица в CSV (для Excel — с BOM и точкой с запятой). */
export function renderDailyCsv(daily: AudienceDaily[]): string {
  const lines = ['day;uniques;views;js_confirmed;bots_filtered'];
  for (const d of daily) {
    lines.push(`${d.day};${d.uniques};${d.views};${d.js};${d.bots}`);
  }
  return `\uFEFF${lines.join('\n')}\n`;
}

/* ------------------------------------------------------------------ */
/* Страница                                                            */
/* ------------------------------------------------------------------ */

/** Флаг страны по ISO-коду: 'BY' → 🇧🇾. */
export function countryFlag(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return '🌐';
  return String.fromCodePoint(...[...code.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

const COUNTRY_RU: Record<string, string> = {
  BY: 'Беларусь', RU: 'Россия', PL: 'Польша', UA: 'Украина', LT: 'Литва', LV: 'Латвия',
  DE: 'Германия', US: 'Соединенные Штаты', GB: 'Великобритания', NL: 'Нидерланды',
  CZ: 'Чехия', MD: 'Молдова', GE: 'Грузия', TR: 'Турция', FI: 'Финляндия', KZ: 'Казахстан',
  HU: 'Венгрия', CA: 'Канада', SG: 'Сингапур', KR: 'Республика Корея', CN: 'Китай',
  ES: 'Испания', SE: 'Швеция', IT: 'Италия', FR: 'Франция', IL: 'Израиль', EE: 'Эстония',
};

function countryName(code: string): string {
  return COUNTRY_RU[code] ?? code;
}

function fmtDayRu(iso: string): string {
  const [, m, d] = iso.split('-');
  const months = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  return `${Number(d)} ${months[Number(m) - 1] ?? ''}`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function sectionTable(title: string, rows: Array<{ a: string; b: string; c: string }>): string {
  if (rows.length === 0) {
    return `<h2 class="rule-head">${title}</h2><p class="plain">Пока нет данных</p>`;
  }
  return `<h2 class="rule-head">${title}</h2>
  <table class="stats-table"><thead><tr><th>${rows[0]!.a === ' ' ? '' : ''}</th><th>Просмотры</th><th>Доля</th></tr></thead>
  <tbody>${rows.map((r) => `<tr><td>${r.a}</td><td>${r.b}</td><td>${r.c}%</td></tr>`).join('')}</tbody></table>`;
}

export interface AudiencePageOpts {
  audience: AudienceStats;
  board: { onBoard: number; last30Arrived: number; last30Cities: number; viewsTotal: number } | null;
}

/** Страница «Статистика аудитории» — как в примере биржи. */
export function renderAudiencePage(opts: AudiencePageOpts): string {
  const a = opts.audience;
  const maxV = Math.max(1, ...a.daily.map((d) => d.views));
  const bars = a.daily
    .map((d) => {
      const h = Math.max(2, Math.round((d.views / maxV) * 130));
      const hu = Math.max(2, Math.round((d.uniques / maxV) * 130));
      return `<div class="media-day" title="${d.day}: ${d.uniques} уник., ${d.views} просм.">`
        + `<div class="media-bar" style="height:${hu}px"></div><div class="media-bar media-bar-views" style="height:${h}px"></div></div>`;
    })
    .join('');
  const ticks = a.daily.filter((_, i) => a.days <= 7 || i % 5 === 0).map((d) => `<span>${fmtDayRu(d.day)}</span>`).join('');

  const tiles = [
    [String(a.avgUniques), 'посетителей в день (среднее)'],
    [String(a.views), 'просмотров страниц'],
    [String(a.uniquesSum), 'сумма суточных посетителей'],
    [a.pagesPerVisitor, 'страниц на посетителя'],
    [`${a.jsSharePct}%`, 'подтверждены браузером'],
    [String(a.botsFiltered), 'отфильтровано роботов'],
  ].map(([n, label]) => `<div class="media-tile"><b>${n}</b><span>${label}</span></div>`).join('');

  const board = opts.board
    ? `<h2 class="rule-head">Площадка</h2>
       <div class="media-grid">
         <div class="media-tile"><b>${opts.board.onBoard}</b><span>объявлений на доске</span></div>
         <div class="media-tile"><b>${opts.board.last30Arrived}</b><span>новых заявок за 30 дней</span></div>
         <div class="media-tile"><b>${opts.board.last30Cities}</b><span>городов в обороте</span></div>
         <div class="media-tile"><b>${opts.board.viewsTotal}</b><span>просмотров карточек</span></div>
       </div>`
    : '';

  const geo = sectionTable('География', a.countries.map((c) => ({
    a: `${countryFlag(c.country)} ${esc(countryName(c.country))}`, b: String(c.views), c: String(c.share).replace('.', ','),
  })));
  const dcNote = a.dcViews > 0 ? `<p class="plain">Из них через VPN / дата-центры: ${a.dcViews} просмотров.</p>` : '';
  const devices = sectionTable('Устройства', a.devices.map((d) => ({ a: esc(d.name), b: String(d.views), c: String(d.share).replace('.', ',') })));
  const os = sectionTable('Операционные системы', a.os.map((d) => ({ a: esc(d.name), b: String(d.views), c: String(d.share).replace('.', ',') })));
  const sources = sectionTable('Источники трафика', a.sources.map((d) => ({ a: esc(d.name), b: String(d.views), c: String(d.share).replace('.', ',') })));
  const referrers = sectionTable('Основные источники', a.referrers.map((d) => ({ a: esc(d.host), b: String(d.views), c: String(d.share).replace('.', ',') })));
  const pages = sectionTable('Страницы', a.pages.map((d) => ({ a: esc(d.name), b: String(d.views), c: String(d.share).replace('.', ',') })));

  const dayRows = a.daily.slice().reverse().map((d) =>
    `<tr><td class="mono">${d.day}</td><td>${d.uniques}</td><td>${d.views}</td><td>${d.js}</td></tr>`).join('');

  const period = (n: number) => `<a class="media-period${a.days === n ? ' on' : ''}" href="/mediakit?days=${n}">${n === 1 ? '24 часа' : `${n} дней`}</a>`;

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Статистика аудитории — попутка.</title>
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="stylesheet" href="/styles.css">
<style>
  .media-wrap { max-width: 960px; margin: 0 auto; padding: 28px 20px 48px; }
  .media-top { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; margin: 10px 0 4px; }
  .media-periods { display: flex; gap: 6px; }
  .media-period { border: 1px solid var(--line); border-radius: 8px; padding: 5px 12px; font-size: 14px; text-decoration: none; color: var(--ink); }
  .media-period.on { background: var(--ink); color: var(--paper); border-color: var(--ink); }
  .media-actions { display: flex; gap: 6px; }
  .media-actions a, .media-actions button { border: 1px solid var(--line); background: var(--card); border-radius: 8px; padding: 5px 12px; font-size: 14px; color: var(--ink); text-decoration: none; cursor: pointer; }
  .media-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin: 16px 0; }
  .media-tile { border: 1px solid var(--line); background: var(--card); border-radius: 10px; padding: 12px 14px; }
  .media-tile b { display: block; font-family: var(--serif); font-size: 24px; line-height: 1.15; }
  .media-tile span { font-size: 12.5px; color: var(--ink-soft); }
  .media-chart { display: flex; align-items: flex-end; gap: 4px; height: 150px; border-bottom: 1px solid var(--line-strong); padding-top: 8px; margin: 12px 0 4px; }
  .media-day { flex: 1; display: flex; align-items: flex-end; gap: 2px; height: 100%; }
  .media-bar { flex: 1; background: var(--accent); border-radius: 3px 3px 0 0; min-height: 2px; }
  .media-bar-views { background: var(--line-strong); opacity: .45; }
  .media-ticks { display: flex; gap: 4px; font-size: 11px; color: var(--ink-soft); }
  .media-ticks span { flex: 1; text-align: center; }
  .media-legend { font-size: 13px; color: var(--ink-soft); margin-bottom: 6px; }
  .media-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin: 0 4px 0 10px; vertical-align: middle; font-style: normal; }
  @media print { .media-actions { display: none; } }
</style>
</head>
<body>
<main class="media-wrap">
  <p class="doc-date">попутка. · статистика аудитории · сформировано ${fmtDayRu(a.generatedAt.slice(0, 10))}, ${a.generatedAt.slice(11, 16)} UTC</p>
  <div class="media-top">
    <div class="media-periods">${period(1)}${period(7)}${period(30)}</div>
    <div class="media-actions">
      <a href="/mediakit/export.csv?days=${a.days}">Скачать CSV</a>
      <button type="button" onclick="window.print()">Печать / PDF</button>
      <form method="post" action="/mediakit/logout" style="display:inline"><button type="submit">Выйти</button></form>
    </div>
  </div>
  <p class="plain">Период покрыт данными на ${a.coveredDays} из ${a.days} дн. Статистика по текущей методике собирается с первого дня после обновления.</p>

  <div class="media-grid">${tiles}</div>

  ${board}

  <h2 class="rule-head">Динамика по дням</h2>
  <div class="media-legend">Уникальные посетители<i style="background:var(--accent)"></i> Просмотры страниц<i style="background:var(--line-strong);opacity:.45"></i></div>
  <div class="media-chart">${bars}</div>
  <div class="media-ticks">${ticks}</div>

  ${geo}${dcNote}
  ${devices}
  ${os}
  ${sources}
  ${referrers}
  ${pages}

  <h2 class="rule-head">Telegram-бот (@parcel_transfer_bot)</h2>
  <p class="plain">Чатов, с которыми бот работал: <b>${a.bot.total}</b> · активных за период: <b>${a.bot.active}</b></p>

  <h2 class="rule-head">Динамика по дням (таблица)</h2>
  <table class="stats-table stats-table-wide">
    <thead><tr><th>Дата</th><th>Уникальные посетители</th><th>Просмотры страниц</th><th>Подтверждены браузером</th></tr></thead>
    <tbody>${dayRows}</tbody>
  </table>

  <h2 class="rule-head">Методика подсчёта</h2>
  <ul class="plain-list">
    <li>Учитываются только люди: поисковые роботы, превью ссылок в мессенджерах, ИИ-краулеры, скрипты и мониторинги определяются по User-Agent и исключаются (но считаются в «отфильтровано роботов»).</li>
    <li>Уникальный посетитель — обезличенный суточный идентификатор (хеш соли, даты, IP-адреса и браузера; сам IP не хранится). За период выводится сумма и среднее суточных значений.</li>
    <li>Просмотр страницы засчитывается при каждом открытии страниц доски, включая ответы из CDN-кэша.</li>
    <li>«Подтверждены браузером» — посетители, чей браузер выполнил JavaScript страницы. Это отсекает большинство автоматического трафика.</li>
    <li>География — по IP-адресу (Cloudflare). Посетители через VPN учитываются по стране VPN-сервера и отмечаются отдельной строкой.</li>
    <li>Источник трафика определяется по заголовку Referer при входе на сайт; переходы внутри сайта не считаются.</li>
    <li>Даты — по UTC. Сырые данные хранятся 90 дней, затем удаляются.</li>
  </ul>

  <form method="post" action="/mediakit/logout" style="margin-top:24px">
    <button type="submit" class="btn btn-line btn-sm">выйти</button>
  </form>
</main>
</body>
</html>`;
}
