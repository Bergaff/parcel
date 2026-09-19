/**
 * Серверный рендер оболочек сайта.
 *
 * Почему это нужно: доска — SPA, и без JS в HTML главной был пустой
 * <div id="list">. Google такой контент рендерит с задержкой и не всегда
 * полностью, Яндекс — хуже. Поэтому воркер отдаёт тот же index.html, но с
 * уже вставленными объявлениями, нужным <title>, description, canonical,
 * OG-тегами и JSON-LD. Клиент (public/app.js) подхватывает готовую разметку
 * и дальше работает как обычно: данные из SSR кладутся в кэш, так что клик по
 * строке открывает карточку мгновенно, ещё до ответа API.
 *
 * Разметка строк и карточки повторяет public/app.js (buildRow/renderDetail) —
 * иначе после гидрации контент «прыгал» бы.
 */
import type { Env, Listing } from './types';
import { escapeHtml, mskTodayIso, normalizeContacts } from './util';
import { agoText, fmtDateWithYear, fmtDayShort, fmtWeight, plural, MONTHS_SHORT, WEEKDAY_NAMES } from './format';
import { headMeta, jsonLdAll } from './seo';

export type View = 'list' | 'item' | 'new' | 'how' | 'bot' | 'terms' | 'privacy' | 'admin';

export const APP_VIEWS: View[] = ['list', 'item', 'new', 'how', 'bot', 'terms', 'privacy', 'admin'];

/** Пути, которые обслуживает SPA (остальное — отдельные серверные страницы). */
export function isAppPath(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/' || p === '/new' || p === '/how' || p === '/bot' || p === '/terms' || p === '/privacy' || p === '/admin') return true;
  return p.startsWith('/item/');
}

export function isArchived(l: Listing): boolean {
  // Регулярный рейс архивом не считается: дата выезда — ближайший заезд,
  // cron катит её вперёд (archiveExpired в src/store.ts)
  if (l.status === 'expired') return true;
  if (l.recurring) return false;
  return l.departureDate != null && l.departureDate < mskTodayIso();
}

/* --------------------------- подпись источника --------------------------- */

/** Чем объявление попало на доску: пересылка, чат или форма сайта.
 *  Совпадает с sourceLabel() в public/app.js. */
export function sourceLabel(l: Listing): string {
  if (l.sourceChat && l.sourceChat.startsWith('Переслано от ')) return l.sourceChat;
  if (l.source === 'parser' || l.source === 'telegram') {
    return l.sourceChat ? `из чата «${l.sourceChat}»` : 'из Telegram';
  }
  return 'с сайта';
}

/** Публичная ссылка на исходное сообщение (t.me/c/… для супергрупп). */
export function sourceLinkUrl(l: Listing, chatLinks: Record<string, string> = {}): string | null {
  if (l.sourceChatId && chatLinks[l.sourceChatId]) return chatLinks[l.sourceChatId] ?? null;
  if (!l.sourceChatId) return null;
  const m = /^-100(\d+)$/.exec(l.sourceChatId);
  if (!m) return null;
  return `https://t.me/c/${m[1]}${l.sourceMessageId != null ? '/' + l.sourceMessageId : ''}`;
}

function sourceHtml(l: Listing, chatLinks: Record<string, string> = {}): string {
  const label = escapeHtml(sourceLabel(l));
  const url = sourceLinkUrl(l, chatLinks);
  return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${label}</a>` : label;
}

/** Контакт для показа: username → ссылка в Telegram, номер → tel:. */
export function contactOf(l: Listing): { kind: 'telegram' | 'phone'; href: string; label: string } | null {
  const { telegram, phone } = normalizeContacts(l.telegram, l.phone);
  if (telegram) {
    const user = telegram.replace(/^@/, '');
    return { kind: 'telegram', href: `https://t.me/${user}`, label: `@${user}` };
  }
  if (phone) return { kind: 'phone', href: `tel:${phone.replace(/[^\d+]/g, '')}`, label: phone };
  return null;
}

/* ------------------------------ строка доски ----------------------------- */

export interface RowOptions {
  chatLinks?: Record<string, string>;
  /** показывать ссылку «открыть» справа (на страницах маршрутов — да) */
  openLink?: boolean;
  /** кнопки «скопировать»/«пожаловаться» — там, где есть app.js (доска и
   *  блок похожих заявок). На витринных страницах скрипта нет, кнопки были бы
   *  мёртвыми, поэтому там их не рисуем. */
  actions?: boolean;
}

/** Одна строка доски — та же разметка, что рисует buildRow() в public/app.js. */
export function renderRowHtml(l: Listing, opts: RowOptions = {}): string {
  const contact = contactOf(l);
  const archived = isArchived(l);
  const meta = [
    // «2 дн. назад»/«15 сен» — как в app.js, иначе строка меняется после гидрации
    `<span>${escapeHtml(agoText(l.publishedAt ?? l.createdAt))}</span>`,
    l.recurring
      ? `<span>↻ ${escapeHtml(l.recurring)}${l.departureDate ? `, ближайший ${escapeHtml(fmtDayShort(l.departureDate))}` : ''}</span>`
      : l.departureDate ? `<span>выезд ${escapeHtml(fmtDayShort(l.departureDate))}</span>` : '<span>дата не указана</span>',
    fmtWeight(l.weightKg) ? `<span class="mono">${escapeHtml(fmtWeight(l.weightKg)!)}</span>` : null,
    l.price ? `<span class="mono">${escapeHtml(l.price)}</span>` : null,
    `<span class="src">${sourceHtml(l, opts.chatLinks)}</span>`,
  ].filter(Boolean).join('');

  const side = [
    `<span class="stamp stamp-${l.type}">${l.type === 'offer' ? 'водитель везёт' : 'ищу передачу'}</span>`,
    l.recurring ? '<span class="stamp stamp-recur">регулярно</span>' : null,
    archived ? '<span class="stamp stamp-expired">архив</span>' : null,
    contact
      ? `<a class="write-link" href="${escapeHtml(contact.href)}" target="_blank" rel="noopener">${contact.kind === 'phone' ? 'позвонить' : 'написать'}</a>`
      : '<span class="write-link" style="cursor:default">контакт в карточке</span>',
    opts.openLink ? `<a class="write-link" href="/item/${encodeURIComponent(l.id)}">открыть</a>` : null,
    opts.actions ? `<a class="write-link share-link" href="/item/${encodeURIComponent(l.id)}" data-copy="${escapeHtml(l.id)}">скопировать</a>` : null,
    opts.actions ? `<a class="write-link report-link" href="/item/${encodeURIComponent(l.id)}" data-report="${escapeHtml(l.id)}">пожаловаться</a>` : null,
    `<span class="row-no">№ ${escapeHtml(l.id.slice(0, 4).toUpperCase())}</span>`,
  ].filter(Boolean).join('\n    ');

  return `<article class="row">
  <a class="row-link" href="/item/${encodeURIComponent(l.id)}" aria-label="${escapeHtml(l.fromCity)} → ${escapeHtml(l.toCity)}: открыть объявление"></a>
  <div class="row-main">
    <h3 class="route-line">${escapeHtml(l.fromCity)}<span class="r-arrow">→</span><span class="r-to">${escapeHtml(l.toCity)}</span></h3>
    <p class="desc">${escapeHtml(l.description)}</p>
    <div class="meta-line">${meta}</div>
  </div>
  <div class="row-side">
    ${side}
  </div>
</article>`;
}

/** Список заявок для доски и блока «Ещё по этому маршруту»: оба рисуются внутри
 *  оболочки с app.js, поэтому строки сразу с кнопками «скопировать» и
 *  «пожаловаться» — иначе они появляются спустя мгновение после гидрации.
 *  Витринные страницы (/r/…, /gorod/…) зовут renderRowHtml напрямую. */
export function renderRowsHtml(items: Listing[], opts: RowOptions = {}): string {
  return items.map((l) => renderRowHtml(l, { actions: true, ...opts })).join('\n');
}

/* ------------------------------ карточка -------------------------------- */

export interface DetailOptions {
  origin: string;
  /** ссылка на страницу маршрута, если она есть */
  routePath?: string | null;
  /** страница города отправления — второй уровень хлебных крошек */
  cityPath?: string | null;
  chatLinks?: Record<string, string>;
  /** соседние заявки того же маршрута */
  related?: Listing[];
}

/** Карточка объявления — та же разметка, что рисует renderDetail() в app.js. */
export function renderDetailHtml(l: Listing, opts: DetailOptions): string {
  const contact = contactOf(l);
  const archived = isArchived(l);

  const cells = [
    [l.recurring ? 'ближайший выезд' : 'выезд', l.departureDate ? fmtDateWithYear(l.departureDate) : (l.recurring ? l.recurring : 'дата не указана')],
    ...(l.recurring ? [['регулярно', l.recurring]] : []),
    ...(fmtWeight(l.weightKg) ? [['вес', fmtWeight(l.weightKg)!]] : []),
    ...(l.price ? [['цена', l.price]] : []),
  ] as Array<[string, string]>;

  const cellsHtml = cells
    .map(([label, value]) => `<div class="cell"><span class="label">${escapeHtml(label)}</span><span class="value">${escapeHtml(value)}</span></div>`)
    .join('');

  const actions = [
    contact
      ? `<a class="btn btn-ink btn-lg" href="${escapeHtml(contact.href)}" target="_blank" rel="noopener">${contact.kind === 'phone' ? 'позвонить' : 'написать'} ${escapeHtml(contact.label)}</a>`
      : null,
    `<button class="link-btn" type="button" data-report="${escapeHtml(l.id)}">пожаловаться</button>`,
    `<button class="btn btn-line btn-lg" type="button" data-copy="${escapeHtml(l.id)}">скопировать ссылку</button>`,
  ].filter(Boolean).join('\n      ');

  const crumbs = [
    '<a href="/">Доска</a>',
    // порядок тот же, что в JSON-LD BreadcrumbList: доска → город → маршрут → объявление
    opts.cityPath ? `<a href="${escapeHtml(opts.cityPath)}">${escapeHtml(l.fromCity)}</a>` : null,
    opts.routePath ? `<a href="${escapeHtml(opts.routePath)}">${escapeHtml(l.fromCity)} → ${escapeHtml(l.toCity)}</a>` : null,
    `<span>№ ${escapeHtml(l.id.slice(0, 8))}</span>`,
  ].filter(Boolean).join(' <span class="crumb-sep">›</span> ');

  const relatedHtml = opts.related && opts.related.length > 0
    ? `\n<h2 class="rule-head">Ещё по этому маршруту</h2>\n<div class="rows">${renderRowsHtml(opts.related)}</div>`
    : '';

  return `<nav class="crumbs" aria-label="Хлебные крошки">${crumbs}</nav>
<div class="d-head">
  <h1 class="d-route">${escapeHtml(l.fromCity)} <span class="r-arrow">→</span> ${escapeHtml(l.toCity)}</h1>
  <span class="stamp stamp-${l.type}">${l.type === 'offer' ? 'водитель везёт' : 'ищу передачу'}</span>
  ${l.recurring ? `<span class="stamp stamp-recur">регулярно</span>` : ''}
  ${archived ? '<span class="stamp stamp-expired">архив</span>' : ''}
</div>
<div class="d-meta">${cellsHtml}<div class="cell"><span class="label">источник</span><span class="value">${sourceHtml(l, opts.chatLinks)}</span></div><div class="cell"><span class="label">добавлено</span><span class="value">${escapeHtml(fmtDateWithYear((l.publishedAt ?? l.createdAt).slice(0, 10)))}</span></div></div>
${archived ? '<p class="d-note">Дата поездки прошла — заявка в архиве. Ещё месяц она доступна по ссылке, потом удалится. Автору всё ещё можно написать с вопросом.</p>' : ''}
<p class="d-desc">${escapeHtml(l.description)}</p>
<div class="d-actions">
      ${actions}
</div>
<p class="d-note">Объявление проверено модератором, но это не гарантия: связывайтесь с человеком, задавайте вопросы и не передавайте деньги заранее. Опечатка или фейк, нажмите «пожаловаться», разберусь.</p>${relatedHtml}`;
}

/* ------------------------------- оболочка -------------------------------- */

export interface ShellOptions {
  view: View;
  title: string;
  description: string;
  /** абсолютный URL канонической страницы */
  canonical: string;
  origin: string;
  robots?: string;
  image?: string;
  imageAlt?: string;
  jsonLd?: Array<unknown | null | undefined>;
  /** HTML строк для #list (главная, фильтры) */
  listHtml?: string;
  /** данные строк — клиент положит их в кэш и откроет карточку без запроса */
  listData?: Listing[];
  /** HTML карточки для #item-detail */
  detailHtml?: string;
  detailData?: Listing | null;
  total?: number;
  counts?: { offer: number; request: number };
  /** сколько объявлений на доске в шапке («на доске N объявлений») */
  today?: Date;
}

let shellCache: { html: string; at: number } | null = null;

/** index.html из биндинга ASSETS (без сети), с кэшем на минуту в изоляте. */
export async function readShellTemplate(env: Env): Promise<string> {
  if (shellCache && Date.now() - shellCache.at < 60_000) return shellCache.html;
  const res = await env.ASSETS.fetch(new Request('https://assets/index.html'));
  if (!res.ok) throw new Error(`index.html недоступен: ${res.status}`);
  const html = await res.text();
  shellCache = { html, at: Date.now() };
  return html;
}

/** Только нужная секция видима, остальные — hidden (иначе SSR показывает всё сразу). */
export function setView(html: string, view: View): string {
  return html.replace(/<section id="view-([a-z]+)"([^>]*)>/g, (_m, name: string, attrs: string) => {
    const clean = attrs.replace(/\s+hidden(="")?/g, '');
    return name === view ? `<section id="view-${name}"${clean}>` : `<section id="view-${name}"${clean} hidden>`;
  });
}

export function todayLine(now: Date): string {
  const msk = new Date(now.getTime() + 3 * 3600 * 1000);
  const wd = WEEKDAY_NAMES[msk.getUTCDay()];
  const month = MONTHS_SHORT[msk.getUTCMonth()];
  return `${wd}, ${msk.getUTCDate()} ${month}`;
}

/**
 * Собрать страницу: index.html + SEO-блок + нужная секция + SSR-контент.
 * Всё, что не передано, остаётся как в статике (страница продолжает работать
 * без JS и без воркера).
 */
export async function renderShell(env: Env, opts: ShellOptions): Promise<string> {
  let html = await readShellTemplate(env);

  const head = [
    `<title>${escapeHtml(opts.title)}</title>`,
    `<meta name="description" content="${escapeHtml(opts.description)}" />`,
    headMeta({
      title: opts.title,
      description: opts.description,
      canonical: opts.canonical,
      origin: opts.origin,
      robots: opts.robots,
      image: opts.image,
      imageAlt: opts.imageAlt,
    }),
    jsonLdAll(opts.jsonLd ?? []),
  ].filter(Boolean).join('\n  ');

  html = html.replace(/<!--SEO:START-->[\s\S]*?<!--SEO:END-->/, `<!--SEO:START-->\n  ${head}\n  <!--SEO:END-->`);
  html = setView(html, opts.view);

  if (opts.listHtml != null) {
    html = html.replace(
      /<div id="list"([^>]*)><\/div>/,
      `<div id="list"$1 data-ssr="1">\n${opts.listHtml}\n      </div>`
    );
  }
  if (opts.detailHtml != null) {
    // data-id нужен клиенту: пока открыто то же объявление, серверную карточку
    // не перерисовываем (в ней крошки и «похожие», которых клиент не знает)
    const ssrId = opts.detailData ? ` data-id="${escapeHtml(opts.detailData.id)}"` : '';
    html = html.replace(/<article id="item-detail"><\/article>/, `<article id="item-detail" data-ssr="1"${ssrId}>${opts.detailHtml}</article>`);
  }
  if (opts.total != null) {
    html = html.replace(
      /<b id="total-count">[^<]*<\/b>/,
      `<b id="total-count">${opts.total} ${escapeHtml(plural(opts.total, 'объявление', 'объявления', 'объявлений'))}</b>`
    );
  }
  if (opts.counts) {
    html = html.replace(/<span class="tab-count" id="c-all"><\/span>/, `<span class="tab-count" id="c-all">(${opts.total ?? 0})</span>`);
    html = html.replace(/<span class="tab-count" id="c-offer"><\/span>/, `<span class="tab-count" id="c-offer">(${opts.counts.offer})</span>`);
    html = html.replace(/<span class="tab-count" id="c-request"><\/span>/, `<span class="tab-count" id="c-request">(${opts.counts.request})</span>`);
  }
  html = html.replace(/<span id="today"><\/span>/, `<span id="today">${escapeHtml(todayLine(opts.today ?? new Date()))}</span>`);

  // Данные SSR — в кэш клиента: первый клик по строке открывает карточку без запроса
  const ssr = {
    view: opts.view,
    ...(opts.listData ? { items: opts.listData } : {}),
    ...(opts.detailData ? { item: opts.detailData } : {}),
    ...(opts.total != null ? { total: opts.total } : {}),
  };
  html = html.replace(
    '</body>',
    `  <script>window.__SSR__ = ${JSON.stringify(ssr).replace(/</g, '\\u003c')};</script>\n</body>`
  );

  return html;
}
