/**
 * GEO-страницы «Что передают» (/peredat, /peredat/:slug) и /llms.txt.
 *
 * GEO (Generative Engine Optimization) — то же SEO, но под ИИ-поисковики:
 * ChatGPT, Яндекс Нейро, Perplexity и Google AI Overviews отвечают на вопросы
 * вроде «как передать документы из Минска в Варшаву» и цитируют страницы сами.
 * Им нужны: серверный HTML без JS (есть), короткие понятные факты с живыми
 * цифрами (берём из D1 теми же словами, что админский отчёт «что передают»),
 * FAQ-структура и JSON-LD, разрешение ботов в robots.txt и сводка llms.txt.
 *
 * Цифры не врут: на страницах только живые заявки (published), цена — всегда
 * «договор напрямую» (поле цены пустое в 99% заявок, выдумывать нельзя),
 * «обновлено» — реальный MAX(published_at) из базы.
 */
import type { Env, Listing } from './types';
import { escapeHtml } from './util';
import { fmtDayShort, plural } from './format';
import { breadcrumbsLd, faqPageLd, itemListLd, SITE_NAME, type Crumb } from './seo';
import { crumbs, footRoutes, mastheadData, routePathFor, seoPageShell, type OgCardSpec } from './seo-routes';
import { renderRowHtml } from './ssr';
import { CARRY_PAGES, resolveCarryPage, type CarryPage } from './carry-pages';
import {
  CARRY_CATEGORIES, carryCategoryBoard, carryListings, carryTopRoutes, getChatLinks, getCounts,
  listCarryStats, listListings, type CarryBoardStat, type CarryRouteStat,
} from './store';

const TITLE_MAX = 60;
const DESC_MAX = 160;

/** Слова категории из админского отчёта — публичные страницы считают тем же
 *  правилом, что и админка: одна механика, одни числа. */
export function carryWordsFor(key: string): string[] {
  return CARRY_CATEGORIES.find((c) => c.key === key)?.words ?? [];
}

function slugByKey(key: string): string | null {
  return CARRY_PAGES.find((p) => p.key === key)?.slug ?? null;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Заголовок категории с живой цифрой (как routeTitle: бренд в пределах 60). */
export function carryTitle(page: CarryPage, board: number): string {
  const variants = board > 0
    ? [
        `${page.h1} — ${board} ${plural(board, 'заявка', 'заявки', 'заявок')} на доске`,
        page.h1,
        page.label,
      ]
    : [`${page.h1} — доска попутных передач`, page.h1, page.label];
  const core = variants.find((v) => `${v} | ${SITE_NAME}`.length <= TITLE_MAX)
    ?? variants[variants.length - 1]!;
  return `${core} | ${SITE_NAME}`;
}

/** Описание категории: цифры живых заявок или честный «разместите просьбу». */
export function carryDescription(page: CarryPage, stat: CarryBoardStat | null, routes: CarryRouteStat[]): string {
  const dirs = routes.slice(0, 3).map((r) => `${r.from} → ${r.to}`).join(', ');
  const base = stat && stat.board > 0
    ? `${stat.board} ${plural(stat.board, 'живая заявка', 'живые заявки', 'живых заявок')}: передать ${page.acc} попуткой${dirs ? ` (${dirs})` : ''}. Договор напрямую с водителем — без посредников и комиссий.`
    : `Нужно передать ${page.acc} попуткой? Разместите просьбу бесплатно — водители увидят её на доске и в боте, отклик обычно в тот же день.`;
  return clip(base, DESC_MAX);
}

/* ------------------------------------------------------------------ */
/* Страница категории /peredat/:slug                                   */
/* ------------------------------------------------------------------ */

/** Страница категории. null — такого адреса нет (честный 404). */
export async function buildCarryPage(env: Env, slug: string, origin: string): Promise<string | null> {
  const page = resolveCarryPage(slug);
  if (!page) return null;
  const words = carryWordsFor(page.key);
  if (words.length === 0) return null;

  const [head, stat, routes, items, chatLinks] = await Promise.all([
    mastheadData(env),
    carryCategoryBoard(env, words).catch(() => null),
    carryTopRoutes(env, words, 6).catch(() => [] as CarryRouteStat[]),
    carryListings(env, words, 6).catch(() => [] as Listing[]),
    getChatLinks(env).catch(() => ({} as Record<string, string>)),
  ]);
  const board = stat?.board ?? 0;
  const bot = head.botUsername;
  const botLine = bot ? ` или ботом в Telegram <a href="https://t.me/${bot}">@${bot}</a>` : '';
  const botPlain = bot ? ` или ботом в Telegram @${bot}` : '';

  const title = carryTitle(page, board);
  const description = carryDescription(page, stat, routes);

  const lead = board > 0 && stat
    ? `Сейчас на доске <b>${board} ${plural(board, 'живая заявка', 'живые заявки', 'живых заявок')}</b> про ${escapeHtml(page.prep)}: ${stat.offers} ${plural(stat.offers, 'водитель везёт', 'водителя везут', 'водителей везут')}, ${stat.requests} ${plural(stat.requests, 'ищет', 'ищут', 'ищут')} перевозку. Новых за 30 дней — ${stat.last30}. Люди договариваются напрямую: без посредников и комиссий.`
    : `Сейчас на доске нет живых заявок про ${escapeHtml(page.prep)} — разместите просьбу, и водители увидят её на доске и в боте; отклик обычно приходит в тот же день.`;

  // направление ведёт на страницу маршрута, если она есть (витрина или живая пара)
  const routePaths = await Promise.all(routes.map((r) => routePathFor(env, r.from, r.to).catch(() => null)));
  const routesHtml = routes.length > 0
    ? `<ul class="carry-routes">${routes.map((r, i) => {
        const label = `${escapeHtml(r.from)} <span class="r-arrow">→</span> ${escapeHtml(r.to)}`;
        const p = routePaths[i];
        return `<li>${p ? `<a href="${escapeHtml(p)}">${label}</a>` : label} <span class="num">· ${r.total} ${plural(r.total, 'заявка', 'заявки', 'заявок')}</span></li>`;
      }).join('\n')}</ul>`
    : `<p class="empty-note">Живых направлений по этой теме сейчас нет — это временно: разместите просьбу в <a href="/new">форме</a>, и водители её увидят.</p>`;

  const rowsHtml = items.length > 0
    ? `<h2 class="rule-head">Заявки на доске сейчас</h2>\n    <div class="rows">${items.map((l) => renderRowHtml(l, { chatLinks, openLink: true })).join('\n')}</div>`
    : '';

  const steps: Array<[string, string]> = [
    ['Разместите заявку', `<a href="/new">форма на сайте</a>${botLine} — бесплатно и занимает минуту: направление, дата, что передаёте, контакт для связи.`],
    ['Выберите, кто едет', `Водители откликнутся сами в Telegram или по телефону; можно написать и водителю напрямую — живые заявки есть на этой странице и на <a href="/routes">страницах маршрутов</a>.`],
    ['Договоритесь о цене и передаче', `Цену обсуждаете лично — доска не назначает тарифов и не берёт комиссий.`],
    ['Передайте и оставайтесь на связи', `Опишите водителю, что внутри, и держите связь до передачи получателю.`],
  ];
  const stepsHtml = steps.map(([h, t]) => `<li><b>${escapeHtml(h)}</b>: ${t}</li>`).join('\n');

  const faq: Array<[string, string]> = [
    [`Как передать ${page.acc} попуткой?`,
      `Разместите заявку на доске — через форму на сайте${botPlain}: это бесплатно. Водители, которым по пути, увидят её и свяжутся с вами напрямую. Или напишите водителю сами: живые заявки собраны на этой странице и на страницах маршрутов.`],
    [`Сколько стоит передать ${page.acc} с попуткой?`,
      `Цену договаривают напрямую с водителем — доска не назначает цены и не берёт комиссию. Стоимость зависит от веса, объёма и маршрута.`],
    [`По каким направлениям чаще всего передают ${page.prep}?`,
      routes.length > 0
        ? `Сейчас на доске: ${routes.slice(0, 3).map((r) => `${r.from} → ${r.to} (${r.total} ${plural(r.total, 'заявка', 'заявки', 'заявок')})`).join(', ')}. Все направления — на странице маршрутов.`
        : `Живых заявок по этой теме сейчас нет — разместите просьбу, и водители увидят её на доске и в боте.`],
    [`Безопасно ли передавать ${page.prep} с незнакомым водителем?`,
      `${page.tip} Объявления проходят модерацию, а люди общаются напрямую: запишите данные водителя и оставайтесь на связи всю дорогу.`],
    [`Можно ли передать ${page.acc} через границу?`,
      `Да, трансграничные рейсы — основа доски: Беларусь ↔ Польша, Литва, Украина, Россия и Европа. ${page.border}`],
  ];
  const faqHtml = faq.map(([q, a]) =>
    `<details class="qa"><summary>${escapeHtml(q)}</summary><p>${escapeHtml(a).replace(/@([A-Za-z0-9_]+)/g, '<a href="https://t.me/$1">@$1</a>')}</p></details>`).join('\n');

  const related = CARRY_PAGES.filter((p) => p.slug !== page.slug).slice(0, 8);
  const relatedHtml = `<h2 class="rule-head">Смотрите также</h2><p class="related">${related
    .map((p) => `<a href="/peredat/${p.slug}">${escapeHtml(p.og)}</a>`).join('')}<a href="/peredat">все темы →</a></p>`;

  const trail: Crumb[] = [
    { name: 'Доска', path: '/' },
    { name: 'Что передают', path: '/peredat' },
    { name: page.label },
  ];

  const body = `    ${crumbs(origin, trail)}
    <p class="doc-date">${stat?.updatedAt ? `данные доски: ${fmtDayShort(stat.updatedAt)}` : 'живая доска'}</p>
    <h1 class="page-title">${escapeHtml(page.h1)}</h1>

    <p class="lead">${lead}</p>

    <div class="cta-row">
      <a class="btn btn-ink btn-lg" href="/new">Разместить объявление</a>
      <a class="btn btn-line btn-lg" href="/peredat">Что передают</a>
      <a class="btn btn-line btn-lg" href="/routes">Маршруты</a>
    </div>

    <h2 class="rule-head">Популярные направления</h2>
    ${routesHtml}

    ${rowsHtml}

    <h2 class="rule-head">Как передать ${escapeHtml(page.acc)} попуткой</h2>
    <ol class="steps">${stepsHtml}</ol>

    <h2 class="rule-head">${escapeHtml(page.label)}: как это передают</h2>
    <p>${escapeHtml(page.about)} ${escapeHtml(page.tip)}</p>

    <h2 class="rule-head">Частые вопросы</h2>
    ${faqHtml}

    ${relatedHtml}

    <p class="colophon">Не нашли попутку на нужную дату? Разместите просьбу — это бесплатно и занимает минуту: <a href="/new">форма на сайте</a>${botLine}.</p>`;

  return seoPageShell({
    ...head,
    title,
    description,
    canonical: `${origin}/peredat/${page.slug}`,
    origin,
    body,
    image: `${origin}/og-carry/${page.slug}.png`,
    imageAlt: `${page.label}: передать попуткой — живые заявки на доске`,
    jsonLd: [
      breadcrumbsLd(origin, trail),
      itemListLd(origin, `Заявки «${page.label}» сейчас`, items.map((l) => ({
        path: `/item/${encodeURIComponent(l.id)}`,
        name: `${l.fromCity} → ${l.toCity}${l.departureDate ? `, выезд ${fmtDayShort(l.departureDate)}` : ''}`,
      }))),
      faqPageLd(faq),
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Хаб /peredat                                                        */
/* ------------------------------------------------------------------ */

/** Хаб «Что передают»: категории с живыми цифрами и свежие заявки доски. */
export async function buildCarryHubPage(env: Env, origin: string): Promise<string> {
  const [head, stats, counts, latest, chatLinks] = await Promise.all([
    mastheadData(env),
    listCarryStats(env, { boardOnly: true }).catch(() => null),
    getCounts(env, {}).catch(() => ({ offer: 0, request: 0 })),
    listListings(env, { perPage: 6 }).then((r) => r.items).catch(() => [] as Listing[]),
    getChatLinks(env).catch(() => ({} as Record<string, string>)),
  ]);
  const boardTotal = counts.offer + counts.request;
  const cats = (stats?.categories ?? []).filter((c) => c.total > 0 && slugByKey(c.key));
  const bot = head.botUsername;
  const botPlain = bot ? ` или ботом в Telegram @${bot}` : '';

  const title = `Что передают попуткой: документы, лекарства, вещи | ${SITE_NAME}`;
  const description = clip(
    `Документы, лекарства, посылки, техника, вещи и другие грузы — что реально передают попутками: ${boardTotal} ${plural(boardTotal, 'объявление', 'объявления', 'объявлений')} на доске, живые цифры по каждой теме.`,
    DESC_MAX,
  );

  const lead = `В каждой заявке люди пишут, что именно везут. Сейчас на доске <b>${boardTotal} ${plural(boardTotal, 'объявление', 'объявления', 'объявлений')}</b>: ${counts.offer} «водитель везёт» и ${counts.request} «ищу, кто передаст». Вот что передают чаще всего — цифры по живым заявкам${stats?.updatedAt ? `, данные на ${fmtDayShort(stats.updatedAt)}` : ''}.`;

  const catsHtml = cats.length > 0
    ? `<ol class="carry-list">${cats.map((c) => {
        const slug = slugByKey(c.key)!;
        return `<li><a href="/peredat/${slug}">${escapeHtml(c.label)}</a> <span class="num">${c.total} ${plural(c.total, 'заявка', 'заявки', 'заявок')} · ${c.offers} везут / ${c.requests} ищут</span></li>`;
      }).join('\n')}</ol>`
    : `<p class="empty-note">Сейчас на доске нет объявлений — загляните позже или <a href="/new">разместите первое</a>.</p>`;

  const rowsHtml = latest.length > 0
    ? `<h2 class="rule-head">Свежие заявки на доске</h2>\n    <div class="rows">${latest.map((l) => renderRowHtml(l, { chatLinks, openLink: true })).join('\n')}</div>`
    : '';

  const topCats = cats.slice(0, 5).map((c) => `${c.label.toLowerCase()} (${c.total})`).join(', ');
  const faq: Array<[string, string]> = [
    ['Что можно передать попуткой?',
      topCats
        ? `Почти всё, что не запрещено законом и таможенными правилами. Сейчас на доске чаще всего передают: ${topCats}. У каждой темы — своя страница с живыми заявками и направлениями.`
        : `Почти всё, что не запрещено законом и таможенными правилами: посылки, документы, лекарства, продукты, технику, вещи, ключи. У каждой темы — своя страница с живыми заявками.`],
    ['Сколько стоит передать посылку с попуткой?',
      'Цену договаривают напрямую с водителем — доска не назначает тарифов и не берёт комиссию. Стоимость зависит от веса, объёма и маршрута.'],
    ['Как разместить объявление?',
      `Бесплатно и без регистрации: через форму на сайте${botPlain}. Заявка живёт месяц и видна на доске, в боте и поисковикам.`],
    ['Что нельзя передавать попуткой?',
      'Всё, что запрещено законом и таможенными правилами стран по маршруту: оружие, наркотики, незадекларированные товары. Объявления проходят модерацию — доска для легальных грузов.'],
  ];
  const faqHtml = faq.map(([q, a]) =>
    `<details class="qa"><summary>${escapeHtml(q)}</summary><p>${escapeHtml(a).replace(/@([A-Za-z0-9_]+)/g, '<a href="https://t.me/$1">@$1</a>')}</p></details>`).join('\n');

  const trail: Crumb[] = [{ name: 'Доска', path: '/' }, { name: 'Что передают' }];

  const body = `    ${crumbs(origin, trail)}
    <p class="doc-date">живая доска${stats?.updatedAt ? ` · данные на ${fmtDayShort(stats.updatedAt)}` : ''}</p>
    <h1 class="page-title">Что передают попуткой</h1>

    <p class="lead">${lead}</p>

    <div class="cta-row">
      <a class="btn btn-ink btn-lg" href="/new">Разместить объявление</a>
      <a class="btn btn-line btn-lg" href="/routes">Маршруты</a>
      <a class="btn btn-line btn-lg" href="/gorod">Города</a>
    </div>

    ${catsHtml}

    ${rowsHtml}

    <h2 class="rule-head">Частые вопросы</h2>
    ${faqHtml}

    <p class="colophon">Тема не найдена? Всё равно разместите заявку — водители читают описания: <a href="/new">форма на сайте</a>.</p>`;

  return seoPageShell({
    ...head,
    title,
    description,
    canonical: `${origin}/peredat`,
    origin,
    body,
    jsonLd: [
      breadcrumbsLd(origin, trail),
      itemListLd(origin, 'Что передают попуткой', cats.map((c) => ({
        path: `/peredat/${slugByKey(c.key)!}`,
        name: `${c.label} — ${c.total} ${plural(c.total, 'заявка', 'заявки', 'заявок')} на доске`,
      }))),
      faqPageLd(faq),
    ],
  });
}

/* ------------------------------------------------------------------ */
/* llms.txt — сводка сайта для LLM                                     */
/* ------------------------------------------------------------------ */

/** /llms.txt: markdown-сводка сайта для ИИ-поисковиков (стандарт llmstxt.org).
 *  Чат-боты читают её, чтобы понимать, что за сайт и какие страницы цитировать. */
export async function buildLlmsTxt(env: Env, origin: string): Promise<string> {
  const [stats, counts, head] = await Promise.all([
    listCarryStats(env, { boardOnly: true }).catch(() => null),
    getCounts(env, {}).catch(() => ({ offer: 0, request: 0 })),
    mastheadData(env),
  ]);
  const boardTotal = counts.offer + counts.request;
  const date = (stats?.updatedAt ?? '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  const cats = (stats?.categories ?? []).filter((c) => c.total > 0 && slugByKey(c.key));

  const lines = [
    `# ${SITE_NAME}`,
    '',
    '> Личная доска попутных передач: водители, которые едут между городами, берут посылки, документы, лекарства, технику и вещи. Люди договариваются напрямую — без посредников и комиссий, размещение бесплатное. Основные направления: Беларусь ↔ Польша, Литва, Украина, Россия и Европа.',
    '',
    `Данные доски на ${date}: ${boardTotal} ${plural(boardTotal, 'активное объявление', 'активных объявления', 'активных объявлений')} — ${counts.offer} «водитель везёт» и ${counts.request} «ищу передачу». Заявки живут месяц после даты выезда.`,
    '',
    '## Что передают попуткой',
    ...(cats.length > 0
      ? cats.map((c) => `- [${c.label}](${origin}/peredat/${slugByKey(c.key)}): ${c.total} ${plural(c.total, 'заявка', 'заявки', 'заявок')} на доске (${c.offers} везут / ${c.requests} ищут)`)
      : ['- Категории появятся, когда на доске будут живые заявки']),
    '',
    '## Популярные направления',
    ...footRoutes(9).map((r) => `- [${r.from} → ${r.to}](${origin}/r/${r.slug})`),
    '',
    '## Как разместить объявление',
    `- [Форма на сайте](${origin}/new): бесплатно, без регистрации, заявка живёт месяц`,
    ...(head.botUsername ? [`- Бот в Telegram: @${head.botUsername} — пришлите сообщение с маршрутом, и заявка попадёт на доску`] : []),
    '',
    '## Подробнее',
    `- [Как это работает](${origin}/how)`,
    `- [Итоги месяца: цифры и средние цены](${origin}/itogi)`,
    `- [Маршруты](${origin}/routes) и [города](${origin}/gorod)`,
    '',
  ];
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* OG-картинка категории                                               */
/* ------------------------------------------------------------------ */

/** Что написать на картинке категории: тема и живые заявки. */
export function carryOgSpec(page: CarryPage, stat: CarryBoardStat | null): OgCardSpec {
  const n = stat?.board ?? 0;
  return {
    from: page.og,
    badge: n > 0 ? `${n} ${plural(n, 'заявка', 'заявки', 'заявок')} на доске` : 'передать попуткой',
    meta: 'что передают попуткой',
    note: 'люди договариваются напрямую — без посредников и комиссий',
  };
}
