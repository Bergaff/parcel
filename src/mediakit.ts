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
import { getCounts, getSetting, listDailyStats } from './store';

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

/**
 * Проверить cookie входа. Приоритет — пара, заданная в админке (таблица
 * settings, там хранится только хэш), затем секреты воркера
 * MEDIA_LOGIN / MEDIA_PASSWORD.
 */
export async function isMediaAuthed(cookieValue: string | null, env: Env): Promise<boolean> {
  if (!cookieValue) return false;
  const storedHash = await getSetting(env, 'mediakit_hash').catch(() => null);
  // пара задана в админке — работает ТОЛЬКО она; секреты воркера
  // возвращаются кнопкой «сбросить» в админке
  if (storedHash) return cookieValue === storedHash;
  if (env.MEDIA_LOGIN && env.MEDIA_PASSWORD) {
    return cookieValue === await mediaCookieValue(env.MEDIA_LOGIN, env.MEDIA_PASSWORD);
  }
  return false;
}

/**
 * Проверить пару логин/пароль при входе: сначала пара из админки, затем
 * секреты воркера. Возвращает значение cookie или null, если не сошлось.
 */
export async function checkMediaCredentials(
  login: string,
  password: string,
  env: Env
): Promise<string | null> {
  const hash = await mediaCookieValue(login, password);
  const storedHash = await getSetting(env, 'mediakit_hash').catch(() => null);
  if (storedHash) return hash === storedHash ? hash : null;
  if (env.MEDIA_LOGIN && env.MEDIA_PASSWORD) {
    const envHash = await mediaCookieValue(env.MEDIA_LOGIN, env.MEDIA_PASSWORD);
    if (hash === envHash) return envHash;
  }
  return null;
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
