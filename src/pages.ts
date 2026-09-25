/**
 * Серверные страницы сайта: главная с живой доской, карточка объявления и
 * текстовые разделы («как это работает», «условия», «приватность», бот).
 *
 * Всё это отдаёт воркер (см. run_worker_first в wrangler.toml): HTML приходит
 * готовым, а public/app.js подхватывает состояние и дальше работает как SPA.
 * Смысл — в индексе: раньше главная была пустым <div id="list">, а разделы
 * жили за «#», которого для поисковика не существует.
 */
import type { Env, Listing } from './types';
import { getCounts, getListingById, listListings, getChatLinks, relatedListings } from './store';
import { normalizeCity } from './parser';
import { escapeHtml } from './util';
import { plural, fmtDayShort, fmtPeriod, fmtPeriodGen, currentPeriod } from './format';
import { breadcrumbsLd, itemListLd, listingLd, webSiteLd, faqPageLd, SITE_NAME } from './seo';
import { isArchived, renderDetailHtml, renderRowsHtml, renderShell, readShellTemplate, type View } from './ssr';
import { seoPageShell, routePathFor, mastheadData } from './seo-routes';
import { listMonthStats, refreshStats, parseMonthPayload, fallbackSummary, type MonthStat } from './stats';
import { getMonthSnapshot } from './store';
import { fmtAmount, CURRENCY_LABEL } from './price';

export interface PageResult {
  html: string;
  status?: number;
  cacheControl?: string;
}

/** Основной домен сайта: SITE_URL из переменных, иначе — origin запроса. */
export function siteOrigin(env: Env, requestUrl: string): string {
  const configured = (env.SITE_URL ?? '').replace(/\/+$/, '');
  if (configured) return configured;
  return new URL(requestUrl).origin;
}

/* ------------------------------------------------------------------ */
/* Текстовые разделы                                                   */
/* ------------------------------------------------------------------ */

interface StaticPage {
  view: View;
  title: string;
  description: string;
  robots?: string;
  /** брать ли вопросы-ответы из разметки раздела для JSON-LD FAQPage */
  faq?: boolean;
}

export const STATIC_PAGES: Record<string, StaticPage> = {
  '/how': {
    view: 'how',
    title: 'Как передать посылку с попуткой — правила доски | попутка.',
    description:
      'Как работает доска попутных передач: водитель публикует рейс, вы находите маршрут и договариваетесь напрямую. Кто проверяет объявления, сколько ждать модерации, что нельзя передавать и почему нет рейтинга.',
    faq: true,
  },
  '/bot': {
    view: 'bot',
    title: 'Телеграм-бот попутка: чаты водителей попутного груза | попутка.',
    description:
      'Бот попутка читает чаты водителей попутного груза, собирает объявления о передачах и публикует их на доске. Как отправить посылку через Telegram: команда /post, поиск по городу, жалобы.',
    faq: true,
  },
  '/terms': {
    view: 'terms',
    title: 'Условия использования доски попутка.',
    description:
      'Правила доски попутных передач: что можно и нельзя публиковать, как работает модерация, жалобы и снятие объявлений, кто отвечает за содержимое и передачу посылок.',
  },
  '/privacy': {
    view: 'privacy',
    title: 'Политика приватности — попутка.',
    description:
      'Какие данные собирает доска попутных передач: объявления, контакты, жалобы и логи. Где хранится, сколько живёт, кому передаётся и как удалить своё объявление.',
  },
  '/new': {
    view: 'new',
    title: 'Разместить объявление о попутном рейсе или передаче посылки | попутка.',
    description:
      'Бесплатная форма объявления: «подвезу посылку» или «нужно передать» — маршрут, дата выезда, вес, цена и контакт. Без регистрации, на доске после проверки модератором — обычно в течение пары часов.',
    faq: true,
  },
  '/admin': {
    view: 'admin',
    title: 'Админ — попутка.',
    description: 'Модерация объявлений: очередь, доска, чаты, подбор пар и повторы.',
    robots: 'noindex, nofollow',
  },
};

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Вопросы-ответы раздела (<details class="qa">) — для JSON-LD FAQPage. */
export function extractFaq(html: string, view: View): Array<[string, string]> {
  const section = new RegExp(`<section id="view-${view}"[^>]*>([\\s\\S]*?)</section>`).exec(html);
  if (!section?.[1]) return [];
  const out: Array<[string, string]> = [];
  const re = /<details class="qa">\s*<summary>([\s\S]*?)<\/summary>\s*<p>([\s\S]*?)<\/p>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section[1])) !== null) {
    const q = stripTags(m[1] ?? '');
    const a = stripTags(m[2] ?? '');
    if (q && a) out.push([q, a]);
  }
  return out;
}

/** Текстовый раздел: тот же index.html, нужная секция видима, свои meta-теги. */
export async function buildStaticPage(env: Env, origin: string, path: string): Promise<PageResult | null> {
  const page = STATIC_PAGES[path];
  if (!page) return null;
  const template = await readShellTemplate(env);
  const faq = page.faq ? extractFaq(template, page.view) : [];

  const html = await renderShell(env, {
    view: page.view,
    title: page.title,
    description: page.description,
    canonical: `${origin}${path}`,
    origin,
    robots: page.robots,
    jsonLd: [
      webSiteLd(origin),
      breadcrumbsLd(origin, [
        { name: 'Доска', path: '/' },
        { name: stripTags(page.title.replace(/\s*\|\s*попутка\.$/, '')) },
      ]),
      faq.length ? faqPageLd(faq) : null,
    ],
  });
  return { html, cacheControl: 'public, max-age=300, s-maxage=3600' };
}

/* ------------------------------------------------------------------ */
/* Главная и фильтры доски                                             */
/* ------------------------------------------------------------------ */

export interface BoardQuery {
  from?: string;
  to?: string;
  type?: 'offer' | 'request';
  date?: string;
  archive?: boolean;
}

export function parseBoardQuery(url: URL): BoardQuery {
  const typeRaw = url.searchParams.get('type');
  const fromRaw = url.searchParams.get('from');
  const toRaw = url.searchParams.get('to');
  return {
    // Поиск понимает и латиницу: «warsaw» → «Варшава» (как в /api/listings)
    from: fromRaw ? normalizeCity(fromRaw).trim() || undefined : undefined,
    to: toRaw ? normalizeCity(toRaw).trim() || undefined : undefined,
    type: typeRaw === 'offer' || typeRaw === 'request' ? typeRaw : undefined,
    date: url.searchParams.get('date') ?? undefined,
    archive: url.searchParams.get('archive') === '1',
  };
}

/* Заголовок главной заточен под то, как доску ищут: «попутки», «попутчики»,
   «передать посылку с попутчиком». Бренд стоит первым — он сам по себе
   главный запрос («попутка сайт», «бот попутка»). */
const HOME_TITLE = `${SITE_NAME} — попутки и попутчики: передать посылку с попутчиком`;
const HOME_DESCRIPTION =
  'Попутки и попутчики: водители берут посылки попутно по своему маршруту — Минск, Гродно, Москва, Киев, Варшава, Прага. Доска объявлений: разместить бесплатно и без регистрации, договор напрямую.';

/**
 * Главная (и фильтры доски): первые 20 заявок прямо в HTML.
 * Фильтрованные адреса — noindex с canonical на главную: под такие запросы
 * есть отдельные страницы маршрутов /r/:slug, дубли не нужны.
 */
export async function buildHomePage(env: Env, origin: string, url: URL): Promise<PageResult> {
  const f = parseBoardQuery(url);
  const filtered = Boolean(f.from || f.to || f.date || f.type || f.archive);
  const search = url.searchParams.toString();

  const [{ items }, counts, chatLinks] = await Promise.all([
    listListings(env, {
      from: f.from, to: f.to, type: f.type, date: f.date, archive: f.archive, page: 1, perPage: 20,
    }),
    getCounts(env, { from: f.from, to: f.to, date: f.date, archive: f.archive }),
    getChatLinks(env).catch(() => ({} as Record<string, string>)),
  ]);
  const total = counts.offer + counts.request;

  const title = filtered
    ? `${f.from ?? 'Доска'}${f.from && f.to ? ' → ' + f.to : f.to ? ' → ' + f.to : ''} — заявки на доске | ${SITE_NAME}`
    : HOME_TITLE;
  const description = filtered
    ? `Заявки по направлению ${f.from ?? '—'} → ${f.to ?? '—'} на доске попутных передач: даты выезда, вес, цена и контакты водителей. Обновлено ${fmtDayShort(new Date().toISOString().slice(0, 10))}.`
    : HOME_DESCRIPTION;

  // FAQ с главной — и людям (блок под доской), и поисковику (FAQPage JSON-LD):
  // раскрывающиеся вопросы в выдаче заметно поднимают кликабельность сниппета
  const homeFaq = filtered ? [] : extractFaq(await readShellTemplate(env), 'list');

  const html = await renderShell(env, {
    view: 'list',
    title,
    description,
    canonical: filtered ? `${origin}/` : `${origin}/`,
    origin,
    // фильтры — не самостоятельная страница: canonical на главную, в индекс не пускаем
    robots: filtered ? 'noindex, follow' : undefined,
    total,
    counts,
    listHtml: items.length > 0 ? renderRowsHtml(items, { chatLinks }) : '',
    listData: items,
    jsonLd: [
      webSiteLd(origin),
      itemListLd(origin, filtered ? `Заявки: ${f.from ?? ''} → ${f.to ?? ''}` : 'Заявки на доске', items.map((l) => ({
        path: `/item/${encodeURIComponent(l.id)}`,
        name: `${l.fromCity} → ${l.toCity}${l.departureDate ? `, выезд ${fmtDayShort(l.departureDate)}` : ''}`,
      }))),
      homeFaq.length > 0 ? faqPageLd(homeFaq) : null,
    ],
  });

  return {
    html,
    // главная живая: надолго не кэшируем
    cacheControl: filtered ? 'no-store' : 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
  };
}

/* ------------------------------------------------------------------ */
/* Карточка объявления                                                 */
/* ------------------------------------------------------------------ */

export function itemTitle(l: Listing, archived: boolean): string {
  const typeLabel = l.type === 'offer' ? 'водитель везёт' : 'нужно передать';
  return `${l.fromCity} → ${l.toCity} · ${typeLabel}${archived ? ' · архив' : ''} | ${SITE_NAME}`;
}

export function itemDescription(l: Listing): string {
  const bits = [
    l.recurring ?? (l.departureDate ? `выезд ${fmtDayShort(l.departureDate)}` : null),
    l.recurring && l.departureDate ? `ближайший рейс ${fmtDayShort(l.departureDate)}` : null,
    l.weightKg != null ? `${String(l.weightKg).replace('.', ',')} кг` : null,
    l.price,
  ].filter(Boolean).join(' · ');
  return [bits, l.description.replace(/\s+/g, ' ').trim().slice(0, 180)].filter(Boolean).join('. ');
}

/**
 * Страница объявления: весь контент в HTML (раньше — пустышка с мгновенным
 * location.replace на #/item/…, то есть для краулера страницы не существовало).
 * null — объявление не найдено или не опубликовано: отдаём 404.
 */
export async function buildItemPage(
  env: Env,
  origin: string,
  id: string,
  opts: {
    /** есть ли SEO-страница у маршрута (может смотреть в базу — поэтому async) */
    routePath?: (from: string, to: string) => string | null | Promise<string | null>;
    cityPath?: (city: string) => string | null | Promise<string | null>;
  } = {}
): Promise<PageResult | null> {
  const listing = await getListingById(env, id);
  if (!listing || (listing.status !== 'published' && listing.status !== 'expired')) return null;

  const archived = isArchived(listing);
  const routePath = opts.routePath ? await opts.routePath(listing.fromCity, listing.toCity) : null;
  const cityFromPath = opts.cityPath ? await opts.cityPath(listing.fromCity) : null;
  const chatLinks = await getChatLinks(env).catch(() => ({} as Record<string, string>));

  // соседние заявки того же маршрута: и человеку полезно, и перелинковка
  const related = await relatedListings(env, listing);

  const html = await renderShell(env, {
    view: 'item',
    title: itemTitle(listing, archived),
    description: itemDescription(listing),
    canonical: `${origin}/item/${encodeURIComponent(listing.id)}`,
    origin,
    // архив живёт месяц и всё равно снимется: в индекс его пускать незачем
    robots: archived ? 'noindex, follow' : undefined,
    image: `${origin}/og/${encodeURIComponent(listing.id)}.png`,
    imageAlt: `${listing.fromCity} → ${listing.toCity}: ${listing.type === 'offer' ? 'водитель везёт' : 'нужно передать'}`,
    detailHtml: renderDetailHtml(listing, { origin, routePath, cityPath: cityFromPath, chatLinks, related }),
    detailData: listing,
    jsonLd: [
      breadcrumbsLd(origin, [
        { name: 'Доска', path: '/' },
        ...(cityFromPath ? [{ name: listing.fromCity, path: cityFromPath }] : []),
        ...(routePath ? [{ name: `${listing.fromCity} → ${listing.toCity}`, path: routePath }] : []),
        { name: `№ ${listing.id.slice(0, 8)}` },
      ]),
      listingLd(origin, listing),
      itemListLd(origin, `Ещё ${listing.fromCity} → ${listing.toCity}`, related.map((l) => ({
        path: `/item/${encodeURIComponent(l.id)}`,
        name: `${l.fromCity} → ${l.toCity}${l.departureDate ? `, выезд ${fmtDayShort(l.departureDate)}` : ''}`,
      }))),
    ],
  });

  return { html, cacheControl: archived ? 'no-store' : 'public, max-age=0, s-maxage=300' };
}

/* ------------------------------------------------------------------ */
/* 404                                                                 */
/* ------------------------------------------------------------------ */

/** Страница «не найдено»: свой HTML со ссылками, а не дефолтная заглушка Cloudflare. */
export async function buildNotFoundPage(env: Env, origin: string, message?: string): Promise<PageResult> {
  let page = '';
  try {
    page = await (await env.ASSETS.fetch(new Request('https://assets/404.html'))).text();
  } catch {
    page = '';
  }
  if (!page) {
    page = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Не найдено — ${escapeHtml(SITE_NAME)}</title></head><body><h1>404</h1><p>${escapeHtml(message ?? 'Страница не найдена.')}</p><p><a href="/">на доску</a></p></body></html>`;
  }
  page = page
    .replace('<!--404_MESSAGE-->', message ? `<p class="empty-note">${escapeHtml(message)}</p>` : '')
    .replace(/<!--404_CANONICAL-->/g, origin);
  return { html: page, status: 404, cacheControl: 'public, max-age=0, s-maxage=60' };
}

/* ------------------------------------------------------------------ */
/* Итоги месяца                                                        */
/* ------------------------------------------------------------------ */

/** Есть ли у пары городов SEO-страница — ссылка в топе направлений. */
async function routePath(env: Env, from: string, to: string): Promise<string | null> {
  try {
    return await routePathFor(env, from, to);
  } catch {
    return null;
  }
}

/** Строка таблицы цен: валюта, среднее, разброс, сколько объявлений. */
function priceRowsHtml(stat: MonthStat): string {
  if (stat.prices.length === 0) {
    return `<p class="empty-note">В этом месяце цену почти никто не писал — договаривались в переписке.</p>`;
  }
  const rows = stat.prices.map((b) => `        <tr>
          <th scope="row">${escapeHtml(CURRENCY_LABEL[b.currency])}</th>
          <td class="mono">${escapeHtml(fmtAmount(b.avg))}</td>
          <td class="mono">${b.min === b.max ? '—' : `${escapeHtml(fmtAmount(b.min))}–${escapeHtml(fmtAmount(b.max))}`}</td>
          <td class="mono">${b.count}</td>
        </tr>`).join('\n');
  const tails: string[] = [];
  if (stat.free > 0) tails.push(`${stat.free} ${plural(stat.free, 'человек предложил', 'человека предложили', 'человек предложили')} передать бесплатно`);
  const without = stat.total - stat.priced - stat.free;
  if (without > 0) tails.push(`${without} ${plural(without, 'объявление', 'объявления', 'объявлений')} без цены`);
  return `<table class="stats-table">
      <thead>
        <tr><th>валюта</th><th>средняя цена</th><th>от и до</th><th>объявлений</th></tr>
      </thead>
      <tbody>
${rows}
      </tbody>
    </table>
    ${tails.length ? `<p class="foot-note">Ещё ${escapeHtml(tails.join(', '))}. Среднее считаем отдельно по каждой валюте: смешивать евро с рублями было бы бессмыслицей.</p>` : ''}`;
}

/** Строка сводной таблицы прошлых месяцев. */
function monthRowHtml(stat: MonthStat): string {
  const main = stat.prices.find((b) => b.currency !== 'none');
  const price = main ? `${fmtAmount(main.avg)} ${main.currency}` : (stat.prices.length ? 'без валюты' : '—');
  return `        <tr>
          <th scope="row"><a href="/itogi/${stat.month}">${escapeHtml(fmtPeriod(stat.month))}</a></th>
          <td class="mono">${stat.total}</td>
          <td class="mono">${stat.offers}</td>
          <td class="mono">${stat.requests}</td>
          <td class="mono">${stat.cities}</td>
          <td class="mono">${escapeHtml(price)}</td>
        </tr>`;
}

/**
 * Публичная страница итогов /itogi: цифры по месяцам и средние цены.
 *
 * Объявления живут на доске месяц после выезда, а потом удаляются кроном —
 * поэтому берём не живые строки, а снимки stats_months (см. src/stats.ts).
 * Если снимков ещё нет (первый запуск), считаем и сохраняем на месте.
 */
export async function buildStatsPage(env: Env, origin: string): Promise<PageResult> {
  let months = await listMonthStats(env);
  if (months.length === 0) {
    await refreshStats(env).catch((e) => console.error('stats refresh failed', e));
    months = await listMonthStats(env);
  }
  const current = months[0];

  let body: string;
  if (!current) {
    body = `    <p class="doc-date">цифры доски</p>
    <h1 class="page-title">Итоги месяца</h1>
    <p class="lead">Пока считать нечего: на доске не было опубликованных объявлений. Как только появится первое, здесь будут цифры за месяц — сколько заявок, откуда и по чём договаривались.</p>
    <p class="colophon">Загляните на <a href="/">доску</a> или <a href="/new">разместите объявление</a>.</p>`;
  } else {
    const figures = [
      [current.total, 'объявлений за месяц'],
      [current.offers, '«водитель везёт»'],
      [current.requests, '«нужно передать»'],
      [current.cities, plural(current.cities, 'город', 'города', 'городов')],
    ] as Array<[number, string]>;

    const directions = current.topDirections.length > 0
      ? await Promise.all(current.topDirections.map(async (d) => {
          const path = d.from && d.to ? await routePath(env, d.from, d.to) : null;
          const label = `${escapeHtml(d.pair)} <span class="mono">${d.count}</span>`;
          return path ? `<a href="${escapeHtml(path)}">${label}</a>` : `<span>${label}</span>`;
        }))
      : [];

    body = `    <nav class="crumbs" aria-label="Хлебные крошки"><a href="/">Доска</a> <span class="crumb-sep">›</span> <span>Итоги месяца</span></nav>
    <p class="doc-date">цифры доски</p>
    <h1 class="page-title">Итоги месяца</h1>
    <p class="route-cities"><a href="/itogi/${current.month}">${escapeHtml(fmtPeriod(current.month))}</a> · ${current.total} ${plural(current.total, 'объявление', 'объявления', 'объявлений')} · направлений ${current.directions}</p>

    <p class="lead">Сколько объявлений прошло через доску и по чём люди договаривались. Считаем по тем заявкам, что публиковались в этом месяце: водители и те, кому нужно передать. Цену берём ту, что человек написал сам, поэтому среднее — отдельно по каждой валюте.</p>

    <div class="stats-figures">
${figures.map(([n, label]) => `      <div class="stats-fig"><b>${n}</b><span>${escapeHtml(label)}</span></div>`).join('\n')}
    </div>

    <h2 class="rule-head">Средняя цена передачи</h2>
    ${priceRowsHtml(current)}

${directions.length > 0 ? `    <h2 class="rule-head">Куда везли чаще всего</h2>
    <p class="related">${directions.join('')}</p>` : ''}

    <h2 class="rule-head">Все месяцы</h2>
    <table class="stats-table stats-table-wide">
      <thead>
        <tr><th>месяц</th><th>всего</th><th>везут</th><th>передать</th><th>городов</th><th>средняя цена</th></tr>
      </thead>
      <tbody>
${months.map(monthRowHtml).join('\n')}
      </tbody>
    </table>
    <p class="foot-note">Закрытые месяцы не меняются, даже когда объявления уходят в архив и удаляются: цифры сохраняются снимком.</p>

    <p class="colophon">Хотите передать посылку по одному из направлений? Откройте <a href="/">доску</a> или <a href="/routes">список маршрутов</a> — там живые заявки водителей.</p>`;
  }

  const html = seoPageShell({
    ...(await mastheadData(env)),
    title: `Итоги месяца на доске попутных передач — сколько заявок и по чём | ${SITE_NAME}`,
    description: 'Статистика доски попутных передач по месяцам: сколько объявлений опубликовано, какие направления самые живые и какая средняя цена передачи в евро, злотых и рублях.',
    canonical: `${origin}/itogi`,
    origin,
    jsonLd: [breadcrumbsLd(origin, [{ name: 'Доска', path: '/' }, { name: 'Итоги месяца' }])],
    body,
  });
  return { html, cacheControl: 'public, max-age=0, s-maxage=1800' };
}

/**
 * Страница одного месяца /itogi/2026-09: цифры + аналитическая заметка
 * (DeepSeek, без ключа — уверенный шаблон из цифр). Каждый месяц —
 * отдельная страница: таких страниц по одной в месяц, они не устаревают
 * и собирают запросы про статистику направлений.
 * null — месяц не существует: честный 404.
 */
export async function buildMonthStatsPage(env: Env, origin: string, month: string): Promise<PageResult | null> {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const snapshot = await getMonthSnapshot(env, month);
  if (!snapshot) return null;
  const stat = parseMonthPayload(snapshot.payload, month);
  if (!stat) return null;

  const months = await listMonthStats(env);
  const idx = months.findIndex((m) => m.month === month);
  // список свежими вперёд: сосед снизу — месяц старше, сверху — новее
  const older = idx >= 0 && idx + 1 < months.length ? months[idx + 1]! : null;
  const newer = idx > 0 ? months[idx - 1]! : null;

  const isCurrent = month === currentPeriod();
  // у закрывшегося месяца заметка сохранена в снимке; текущий месяц живой —
  // показываем шаблон, пересчитанный при каждом заходе
  const summary = snapshot.summary ?? fallbackSummary(stat, older);

  const figures = [
    [stat.total, 'объявлений за месяц'],
    [stat.offers, '«водитель везёт»'],
    [stat.requests, '«нужно передать»'],
    [stat.cities, plural(stat.cities, 'город', 'города', 'городов')],
  ] as Array<[number, string]>;

  const directions = stat.topDirections.length > 0
    ? await Promise.all(stat.topDirections.map(async (d) => {
        const path = d.from && d.to ? await routePath(env, d.from, d.to) : null;
        const label = `${escapeHtml(d.pair)} <span class="mono">${d.count}</span>`;
        return path ? `<a href="${escapeHtml(path)}">${label}</a>` : `<span>${label}</span>`;
      }))
    : [];

  const summaryHtml = summary
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `    <p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');

  const nav: string[] = [];
  if (older) nav.push(`<a href="/itogi/${older.month}">← ${escapeHtml(fmtPeriod(older.month))}</a>`);
  nav.push('<a href="/itogi">все итоги</a>');
  if (newer) nav.push(`<a href="/itogi/${newer.month}">${escapeHtml(fmtPeriod(newer.month))} →</a>`);

  const desc = summary.replace(/\s+/g, ' ').trim().slice(0, 175).trimEnd();
  const publishedDay = `${month}-01`;

  const body = `    <nav class="crumbs" aria-label="Хлебные крошки"><a href="/">Доска</a> <span class="crumb-sep">›</span> <a href="/itogi">Итоги</a> <span class="crumb-sep">›</span> <span>${escapeHtml(fmtPeriod(month))}</span></nav>
    <p class="doc-date">${isCurrent ? 'месяц ещё идёт, цифры растут' : `цифры закрытого месяца · обновлено ${escapeHtml(fmtDayShort(snapshot.updatedAt.slice(0, 10)))}`}</p>
    <h1 class="page-title">Итоги ${escapeHtml(fmtPeriodGen(month))}</h1>
    <p class="route-cities">${stat.total} ${plural(stat.total, 'объявление', 'объявления', 'объявлений')} · ${stat.directions} ${plural(stat.directions, 'направление', 'направления', 'направлений')} · ${stat.cities} ${plural(stat.cities, 'город', 'города', 'городов')}</p>

    <p class="lead">Сколько объявлений прошло через доску и по чём договаривались: водители междугородних рейсов и те, кому нужно передать посылку. Цену берём ту, что человек написал сам, поэтому среднее считаем отдельно по каждой валюте.</p>

    <div class="stats-figures">
${figures.map(([n, label]) => `      <div class="stats-fig"><b>${n}</b><span>${escapeHtml(label)}</span></div>`).join('\n')}
    </div>

    <h2 class="rule-head">Средняя цена передачи</h2>
    ${priceRowsHtml(stat)}

${directions.length > 0 ? `    <h2 class="rule-head">Куда везли чаще всего</h2>
    <p class="related">${directions.join('')}</p>` : ''}

    <h2 class="rule-head">Как читается этот месяц</h2>
${summaryHtml}

    <p class="foot-note">${stat.fromChats + stat.fromSite > 0
      ? `Из телеграм-чатов — ${stat.fromChats}, с сайта — ${stat.fromSite}. Итоги не меняются, даже когда объявления уходят в архив и удаляются: цифры сохраняются снимком.`
      : 'Итоги не меняются, даже когда объявления уходят в архив и удаляются: цифры сохраняются снимком.'}</p>

    <p class="related">${nav.join(' · ')}</p>

    <p class="colophon">Хотите передать посылку? Откройте <a href="/">доску</a> или <a href="/routes">список маршрутов</a> — там живые заявки водителей.</p>`;

  const articleLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: `Итоги ${fmtPeriodGen(month)} на доске «попутка.»`,
    description: desc,
    datePublished: publishedDay,
    ...(snapshot.updatedAt ? { dateModified: snapshot.updatedAt.slice(0, 10) } : {}),
    author: { '@type': 'Organization', name: SITE_NAME, url: origin },
    publisher: { '@type': 'Organization', name: SITE_NAME, url: origin },
    mainEntityOfPage: `${origin}/itogi/${month}`,
  };

  const html = seoPageShell({
    ...(await mastheadData(env)),
    title: `Итоги ${fmtPeriodGen(month)}: ${stat.total} ${plural(stat.total, 'объявление', 'объявления', 'объявлений')}, направления и цены | ${SITE_NAME}`,
    description: desc || `Итоги ${fmtPeriodGen(month)} на доске попутных передач: ${stat.total} объявлений, ${stat.directions} направлений и средние цены.`,
    canonical: `${origin}/itogi/${month}`,
    origin,
    jsonLd: [
      breadcrumbsLd(origin, [
        { name: 'Доска', path: '/' },
        { name: 'Итоги', path: '/itogi' },
        { name: fmtPeriod(month) },
      ]),
      articleLd,
    ],
    body,
  });
  return {
    html,
    // закрытый месяц не меняется совсем, текущий — растёт каждый день
    cacheControl: isCurrent ? 'public, max-age=0, s-maxage=1800' : 'public, max-age=0, s-maxage=86400',
  };
}

/** Сколько всего объявлений на доске (подпись в шапке, итоги месяца). */
export async function boardTotal(env: Env): Promise<number> {
  const counts = await getCounts(env, {});
  return counts.offer + counts.request;
}

export { plural };
