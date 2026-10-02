/**
 * Медиакит для рекламных партнёров: pop-utka.app/mediakit
 *
 * Отдельная страница со статистикой доски — показать бирже рекламы. Вход по
 * логину и паролю (секреты MEDIA_LOGIN / MEDIA_PASSWORD), после входа —
 * cookie на неделю. Данные только агрегатные: никаких контактов, имён и
 * текстов объявлений — города, направления, счётчики и просмотры.
 *
 * Страница закрыта от индексации (meta robots + X-Robots-Tag + robots.txt)
 * и не кэшируется на edge: статистика должна быть свежей, а страница —
 * приватной.
 */
import type { Env } from './types';
import { getCounts, listDailyStats } from './store';

/* ------------------------------------------------------------------ */
/* Данные                                                              */
/* ------------------------------------------------------------------ */

export interface MediaDaily { day: string; arrived: number }

export interface MediaStats {
  generatedAt: string;
  /** На доске сейчас (published). */
  onBoard: { offer: number; request: number };
  /** Последние 30 дней. */
  last30: { arrived: number; approved: number; cities: number; directions: number };
  /** Суммарные просмотры карточек (за всё время). */
  viewsTotal: number;
  /** Динамика заявок по дням, старые → новые. */
  daily: MediaDaily[];
  topDirections: Array<{ from: string; to: string; n: number }>;
  /** Источники заявок за 30 дней: сайт / бот Telegram. */
  sources: Array<{ label: string; n: number; share: number }>;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Собрать агрегаты для страницы. Все числа — публично безразличные. */
export async function gatherMediaStats(env: Env): Promise<MediaStats> {
  const daily30 = (await listDailyStats(env, 30)).slice().reverse();
  const counts = await getCounts(env, { status: 'published' });
  const window30 = `status IN ('published','expired') AND datetime(created_at) >= datetime('now', '-30 days', '+3 hours')`;

  const [topRes, srcRes, cityRes, viewRes] = await Promise.all([
    env.DB.prepare(
      `SELECT from_city, to_city, COUNT(*) AS n FROM listings
       WHERE ${window30} GROUP BY from_city, to_city ORDER BY n DESC LIMIT 8`
    ).all(),
    env.DB.prepare(
      `SELECT source, COUNT(*) AS n FROM listings WHERE ${window30} GROUP BY source`
    ).all(),
    (await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT from_city AS c FROM listings WHERE ${window30}
         UNION SELECT to_city FROM listings WHERE ${window30}
       )`
    ).first()) as { n: number } | null,
    (await env.DB.prepare(
      `SELECT COALESCE(SUM(views), 0) AS v FROM listings WHERE status IN ('published','expired')`
    ).first()) as { v: number } | null,
  ]);

  const srcRows = ((srcRes.results ?? []) as unknown as Array<{ source?: string; n?: number }>)
    .map((r) => ({ source: String(r.source ?? ''), n: Number(r.n ?? 0) }));
  const byLabel = new Map<string, number>();
  for (const r of srcRows) {
    // parser — это объявления из чатов, разобранные ИИ; для медиакита это
    // всё равно «бот Telegram» (личка, пересылки, чаты)
    const label = r.source === 'site' ? 'Сайт' : 'Бот Telegram';
    byLabel.set(label, (byLabel.get(label) ?? 0) + r.n);
  }
  const srcTotal = [...byLabel.values()].reduce((a, b) => a + b, 0);
  const sources = [...byLabel.entries()]
    .map(([label, n]) => ({ label, n, share: srcTotal > 0 ? Math.round((n / srcTotal) * 100) : 0 }))
    .sort((a, b) => b.n - a.n);

  return {
    generatedAt: new Date().toISOString(),
    onBoard: counts,
    last30: {
      arrived: daily30.reduce((a, d) => a + d.arrived, 0),
      approved: daily30.reduce((a, d) => a + d.approved, 0),
      cities: Number(cityRes?.n ?? 0),
      directions: ((topRes.results ?? []) as unknown as Array<Record<string, unknown>>).length,
    },
    viewsTotal: Number(viewRes?.v ?? 0),
    daily: daily30.map((d) => ({ day: d.day, arrived: d.arrived })),
    topDirections: ((topRes.results ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
      from: String(r.from_city ?? ''), to: String(r.to_city ?? ''), n: Number(r.n ?? 0),
    })),
    sources,
  };
}

/* ------------------------------------------------------------------ */
/* Вход по логину и паролю                                             */
/* ------------------------------------------------------------------ */

/** Значение cookie: хэш от пары логин:пароль — проверяется пересчётом. */
export async function mediaCookieValue(login: string, password: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`poputka-media:${login}:${password}`)
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Достать cookie из заголовка запроса. */
export function getCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Проверить cookie входа: пересчитываем хэш по секретам и сверяем. */
export async function isMediaAuthed(cookieValue: string | null, env: Env): Promise<boolean> {
  if (!cookieValue || !env.MEDIA_LOGIN || !env.MEDIA_PASSWORD) return false;
  return cookieValue === await mediaCookieValue(env.MEDIA_LOGIN, env.MEDIA_PASSWORD);
}

/* ------------------------------------------------------------------ */
/* Страницы                                                            */
/* ------------------------------------------------------------------ */

const SHELL_HEAD = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Медиакит — попутка.</title>
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="stylesheet" href="/styles.css">
<style>
  .media-wrap { max-width: 880px; margin: 0 auto; padding: 28px 20px 48px; }
  .media-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 18px 0; }
  .media-tile { border: 1px solid var(--line); background: var(--card); border-radius: 10px; padding: 14px 16px; }
  .media-tile b { display: block; font-family: var(--serif); font-size: 26px; line-height: 1.1; }
  .media-tile span { font-size: 13px; color: var(--ink-soft); }
  .media-chart { display: flex; align-items: flex-end; gap: 3px; height: 150px; border-bottom: 1px solid var(--line-strong); padding: 8px 0 0; margin: 12px 0 4px; }
  .media-bar { flex: 1; background: var(--accent); border-radius: 3px 3px 0 0; min-height: 2px; }
  .media-ticks { display: flex; gap: 3px; font-size: 11px; color: var(--ink-soft); }
  .media-ticks span { flex: 1; text-align: center; }
  .media-login { max-width: 380px; margin: 12vh auto 0; }
</style>`;

/** Страница входа. `error` — почему не пустило (не раскрывает настройку). */
export function renderLoginPage(error?: string | null): string {
  return `${SHELL_HEAD}
</head>
<body>
<main class="media-wrap media-login">
  <p class="doc-date">попутка. · медиакит</p>
  <h1 class="page-title">Вход для партнёров</h1>
  <p class="plain">Статистика доски — для рекламных бирж и партнёров. Логин и пароль выдаёт владелец.</p>
  ${error ? `<p class="dup-warn dup-similar">${escapeHtml(error)}</p>` : ''}
  <form method="post" action="/mediakit/login" class="card">
    <label>Логин<br><input type="text" name="login" autocomplete="username" required></label><br><br>
    <label>Пароль<br><input type="password" name="password" autocomplete="current-password" required></label><br><br>
    <button type="submit" class="btn btn-ink">войти</button>
  </form>
</main>
</body>
</html>`;
}

function fmtDateRu(iso: string): string {
  const [, m, d] = iso.split('-');
  const months = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  return `${Number(d)} ${months[Number(m) - 1] ?? ''}`;
}

/** Сама страница статистики (после входа). */
export function renderMediaPage(stats: MediaStats, opts: { contact?: string | null } = {}): string {
  const maxArrived = Math.max(1, ...stats.daily.map((d) => d.arrived));
  const bars = stats.daily
    .map((d) => `<div class="media-bar" style="height:${Math.max(2, Math.round((d.arrived / maxArrived) * 140))}px" title="${d.day}: ${d.arrived}"></div>`)
    .join('');
  const ticks = stats.daily
    .filter((_, i) => i % 5 === 0)
    .map((d) => `<span>${fmtDateRu(d.day)}</span>`)
    .join('');
  const onBoardTotal = stats.onBoard.offer + stats.onBoard.request;
  const tiles = [
    [String(onBoardTotal), 'объявлений на доске сейчас'],
    [`${stats.onBoard.offer} / ${stats.onBoard.request}`, 'везут / нужно передать'],
    [String(stats.last30.arrived), 'новых заявок за 30 дней'],
    [String(stats.last30.cities), 'городов в обороте за 30 дней'],
    [String(stats.viewsTotal), 'просмотров карточек'],
  ]
    .map(([n, label]) => `<div class="media-tile"><b>${n}</b><span>${label}</span></div>`)
    .join('');
  const dirs = stats.topDirections.length > 0
    ? `<table class="stats-table">
        <thead><tr><th>направление</th><th>объявлений за 30 дней</th></tr></thead>
        <tbody>${stats.topDirections
          .map((d) => `<tr><td>${escapeHtml(d.from)} → ${escapeHtml(d.to)}</td><td>${d.n}</td></tr>`)
          .join('')}</tbody>
      </table>`
    : '<p class="plain">Направления появятся, когда наберутся объявления.</p>';
  const sources = stats.sources.length > 0
    ? stats.sources.map((s) => `${s.label} — ${s.share}% (${s.n})`).join(' · ')
    : '—';
  const contact = opts.contact
    ? `<p class="plain">Для рекламы и вопросов: ${escapeHtml(opts.contact)}</p>`
    : '';

  return `${SHELL_HEAD}
</head>
<body>
<main class="media-wrap">
  <p class="doc-date">попутка. · медиакит · собрано ${fmtDateRu(stats.generatedAt.slice(0, 10))}</p>
  <h1 class="page-title">Статистика доски «попутка.»</h1>
  <p class="plain">«попутка.» — доска объявлений о передаче посылок попутным транспортом между Польшей, Беларусью и соседними странами. Люди публикуют поездки и просьбы о передаче, договариваются напрямую, без посредников. Аудитория — релоканты, отправители документов и посылок, водители регулярных маршрутов.</p>

  <h2 class="rule-head">Ключевые цифры</h2>
  <div class="media-grid">${tiles}</div>

  <h2 class="rule-head">Новые заявки по дням (30 дней)</h2>
  <div class="media-chart">${bars}</div>
  <div class="media-ticks">${ticks}</div>
  <p class="plain">Всего за 30 дней: ${stats.last30.arrived} заявок, из них одобрено к публикации ${stats.last30.approved}.</p>

  <h2 class="rule-head">Популярные направления</h2>
  ${dirs}

  <h2 class="rule-head">Откуда приходят заявки</h2>
  <p class="plain">${sources}</p>

  <h2 class="rule-head">Контакты</h2>
  ${contact || '<p class="plain">Свяжитесь с владельцем доски — контакты в профиле бота <a href="https://t.me/parcel_transfer_bot">@parcel_transfer_bot</a>.</p>'}

  <form method="post" action="/mediakit/logout" style="margin-top:28px">
    <button type="submit" class="btn btn-line btn-sm">выйти</button>
  </form>
  <p class="doc-date" style="margin-top:24px">Данные — собственная статистика доски pop-utka.app, агрегаты без персональной информации. Обновляется при каждом открытии страницы.</p>
</main>
</body>
</html>`;
}
