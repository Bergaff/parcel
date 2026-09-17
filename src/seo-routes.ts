/**
 * SEO-страницы: маршруты /r/:slug, города /gorod/:slug, каталог /routes
 * и карта сайта.
 *
 * Люди ищут не «доска попутных передач», а «передать посылку варшава львов» —
 * под такие запросы делаем отдельную страницу на каждый маршрут: заголовок,
 * честный текст (~500 слов из вариативных блоков, чтобы страницы не были
 * копиями друг друга) и живые заявки из базы.
 *
 * Маршрутов два вида:
 *  - «витрина» (SEO_ROUTES ниже) — направления, которые мы держим всегда,
 *    даже если заявок сейчас нет; их адреса уже в индексе, слаги руками подобраны;
 *  - динамические — любая пара городов, где есть хотя бы одна активная заявка.
 *    Слаги строятся транслитом (src/seo.ts), поэтому витринные пары
 *    исключаются: двух страниц у одного направления не будет.
 *
 * Страницы рендерит воркер (см. /r/:slug и /gorod/:slug в index.ts),
 * в sitemap они попадают автоматически.
 */
import type { Env, Listing } from './types';
import { escapeHtml } from './util';
import {
  getChatLinks, listCityStats, listListings, listRoutePairs, listSitemapItems,
  type CityStat, type RoutePair,
} from './store';
import { fmtDayShort, plural } from './format';
import {
  breadcrumbsLd, citySlug, faqPageLd, headMeta, itemListLd, jsonLdAll, routeSlug, SITE_NAME,
  type Crumb,
} from './seo';
import { renderRowHtml } from './ssr';
import { fromCity, genitiveCity, accusativeCity, inCountry } from './ru';

export interface SeoRoute {
  from: string;
  to: string;
  slug: string;
}

export const SEO_ROUTES: SeoRoute[] = [
  // Польша ↔ Украина
  { from: 'Варшава', to: 'Львов', slug: 'varshava-lvov' },
  { from: 'Варшава', to: 'Киев', slug: 'varshava-kiev' },
  { from: 'Краков', to: 'Львов', slug: 'krakov-lvov' },
  { from: 'Краков', to: 'Киев', slug: 'krakov-kiev' },
  { from: 'Люблин', to: 'Львов', slug: 'lyublin-lvov' },
  { from: 'Люблин', to: 'Киев', slug: 'lyublin-kiev' },
  { from: 'Катовице', to: 'Львов', slug: 'katovitse-lvov' },
  { from: 'Варшава', to: 'Одесса', slug: 'varshava-odessa' },
  { from: 'Варшава', to: 'Харьков', slug: 'varshava-harkov' },
  { from: 'Краков', to: 'Ивано-Франковск', slug: 'krakov-ivano-frankovsk' },
  { from: 'Варшава', to: 'Черновцы', slug: 'varshava-chernovtsy' },
  { from: 'Гданьск', to: 'Киев', slug: 'gdansk-kiev' },
  // Польша ↔ Беларусь
  { from: 'Варшава', to: 'Минск', slug: 'varshava-minsk' },
  { from: 'Краков', to: 'Минск', slug: 'krakov-minsk' },
  { from: 'Варшава', to: 'Брест', slug: 'varshava-brest' },
  { from: 'Варшава', to: 'Гродно', slug: 'varshava-grodno' },
  { from: 'Белосток', to: 'Минск', slug: 'belostok-minsk' },
  { from: 'Белосток', to: 'Гродно', slug: 'belostok-grodno' },
  { from: 'Белосток', to: 'Брест', slug: 'belostok-brest' },
  { from: 'Гданьск', to: 'Минск', slug: 'gdansk-minsk' },
  { from: 'Вильнюс', to: 'Минск', slug: 'vilnyus-minsk' },
  { from: 'Краков', to: 'Брест', slug: 'krakov-brest' },
  // Беларусь ↔ Украина
  { from: 'Минск', to: 'Киев', slug: 'minsk-kiev' },
  { from: 'Минск', to: 'Львов', slug: 'minsk-lvov' },
  { from: 'Брест', to: 'Львов', slug: 'brest-lvov' },
  { from: 'Гомель', to: 'Киев', slug: 'gomel-kiev' },
  // Польша ↔ Европа
  { from: 'Варшава', to: 'Берлин', slug: 'varshava-berlin' },
  { from: 'Варшава', to: 'Прага', slug: 'varshava-praga' },
  { from: 'Краков', to: 'Прага', slug: 'krakov-praga' },
  { from: 'Краков', to: 'Вена', slug: 'krakov-vena' },
  { from: 'Варшава', to: 'Вильнюс', slug: 'varshava-vilnyus' },
  { from: 'Варшава', to: 'Амстердам', slug: 'varshava-amsterdam' },
  { from: 'Варшава', to: 'Париж', slug: 'varshava-parizh' },
  { from: 'Гданьск', to: 'Берлин', slug: 'gdansk-berlin' },
  { from: 'Варшава', to: 'Кёльн', slug: 'varshava-koln' },
  { from: 'Варшава', to: 'Милан', slug: 'varshava-milan' },
  // Европа ↔ Украина
  { from: 'Берлин', to: 'Киев', slug: 'berlin-kiev' },
  { from: 'Берлин', to: 'Львов', slug: 'berlin-lvov' },
  { from: 'Прага', to: 'Киев', slug: 'praga-kiev' },
  { from: 'Прага', to: 'Львов', slug: 'praga-lvov' },
  { from: 'Вильнюс', to: 'Киев', slug: 'vilnyus-kiev' },
  // Беларусь ↔ Россия
  { from: 'Минск', to: 'Москва', slug: 'minsk-moskva' },
  { from: 'Минск', to: 'Санкт-Петербург', slug: 'minsk-peterburg' },
  // Внутри стран
  { from: 'Киев', to: 'Львов', slug: 'kiev-lvov' },
  { from: 'Киев', to: 'Одесса', slug: 'kiev-odessa' },
  { from: 'Варшава', to: 'Краков', slug: 'varshava-krakov' },
  { from: 'Минск', to: 'Гродно', slug: 'minsk-grodno' },
];

/** Страна города (для текста страниц). */
const CITY_COUNTRY: Record<string, { name: string; inst: string }> = {
  'Варшава': { name: 'Польша', inst: 'Польшей' },
  'Краков': { name: 'Польша', inst: 'Польшей' },
  'Люблин': { name: 'Польша', inst: 'Польшей' },
  'Катовице': { name: 'Польша', inst: 'Польшей' },
  'Гданьск': { name: 'Польша', inst: 'Польшей' },
  'Белосток': { name: 'Польша', inst: 'Польшей' },
  'Львов': { name: 'Украина', inst: 'Украиной' },
  'Киев': { name: 'Украина', inst: 'Украиной' },
  'Одесса': { name: 'Украина', inst: 'Украиной' },
  'Харьков': { name: 'Украина', inst: 'Украиной' },
  'Ивано-Франковск': { name: 'Украина', inst: 'Украиной' },
  'Черновцы': { name: 'Украина', inst: 'Украиной' },
  'Минск': { name: 'Беларусь', inst: 'Беларусью' },
  'Брест': { name: 'Беларусь', inst: 'Беларусью' },
  'Гродно': { name: 'Беларусь', inst: 'Беларусью' },
  'Гомель': { name: 'Беларусь', inst: 'Беларусью' },
  'Вильнюс': { name: 'Литва', inst: 'Литвой' },
  'Берлин': { name: 'Германия', inst: 'Германией' },
  'Кёльн': { name: 'Германия', inst: 'Германией' },
  'Прага': { name: 'Чехия', inst: 'Чехией' },
  'Вена': { name: 'Австрия', inst: 'Австрией' },
  'Амстердам': { name: 'Нидерланды', inst: 'Нидерландами' },
  'Париж': { name: 'Франция', inst: 'Францией' },
  'Милан': { name: 'Италия', inst: 'Италией' },
  'Москва': { name: 'Россия', inst: 'Россией' },
  'Санкт-Петербург': { name: 'Россия', inst: 'Россией' },
};

const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

/** Простой хеш строки — для детерминированного выбора вариантов текста. */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

function pick<T>(arr: T[], seed: string): T {
  return arr[hash(seed) % arr.length]!;
}

function fmtDay(iso: string | null): string {
  if (!iso) return '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return `${parseInt(m[3]!, 10)} ${MONTHS_SHORT[parseInt(m[2]!, 10) - 1]}`;
}

function findRoute(slug: string): SeoRoute | null {
  return SEO_ROUTES.find((r) => r.slug === slug) ?? null;
}

/* ------------------------------------------------------------------ */
/* Текст страницы: блоки с вариантами, чтобы страницы не дублировались */
/* ------------------------------------------------------------------ */

function introText(r: SeoRoute, seed: string): string {
  const from = escapeHtml(r.from);
  const to = escapeHtml(r.to);
  const cf = CITY_COUNTRY[r.from]?.name ?? '';
  const ct = CITY_COUNTRY[r.to]?.name ?? '';
  const between = cf && ct && cf !== ct ? ` между ${CITY_COUNTRY[r.from]!.inst} и ${CITY_COUNTRY[r.to]!.inst}` : '';
  return pick([
    `Маршрут ${from} → ${to} — один из самых частых на доске: люди регулярно едут${between ? between : ''} и берут посылки попутно, чтобы окупить бензин. На этой странице собраны действующие заявки водителей и просьбы передать посылку по этому направлению — обновляются сами, как только на доске появляется новое объявление.`,
    `Если нужно передать посылку из ${from} в ${to} — не обязательно искать курьерскую службу и платить за конверт как за груз. По этому направлению несколько раз в неделю едут обычные люди${between ? ` — маршрут соединяет ${cf} и ${ct}` : ''}, и большинство из них рады взять с собой конверт, коробку или сумку. Ниже — живые заявки с доски «попутка.».`,
    `Направление ${from} → ${to} живое круглый год: студенты, командировочные, водители-рекордсмены и просто попутчики. Каждый из них может стать вашим «курьером» — за символическую плату или просто в благодарность. Здесь видно, кто едет в ближайшие дни, что готов взять и как с ним связаться.`,
  ], seed + 'intro');
}

function howtoText(r: SeoRoute, seed: string): Array<[string, string]> {
  const from = escapeHtml(r.from);
  const to = escapeHtml(r.to);
  return pick([
    [
      ['Найдите заявку', `Откройте список ниже или доску с фильтром «${from} → ${to}». В каждой заявке видно дату выезда, сколько килограмм готов взять водитель и контакт.`],
      ['Напишите человеку', 'Связь — напрямую в Telegram или по телефону. Договоритесь о месте передачи, времени и вознаграждении: обычно это половина цены курьерской службы или просто «спасибо» и компенсация бензина.'],
      ['Передайте посылку', 'Взвешивайте, проверяйте содержимое вместе и не передавайте деньги вперёд: добросовестному водителю это не нужно.'],
    ],
    [
      ['Разместите просьбу', `Если подходящего рейса сейчас нет, опишите, что и когда нужно передать по маршруту ${from} → ${to} — объявление бесплатное и появится на доске после проверки модератором.`],
      ['Дождитесь отклика', 'Водители, которые планируют поездку, просматривают доску и список просьб: часто связываются в тот же день.'],
      ['Договоритесь', 'Место, время, цена — всё решается в личной переписке. Доска только знакомит людей, посредников здесь нет.'],
    ],
  ], seed + 'howto');
}

function whatText(r: SeoRoute, seed: string): string {
  const from = escapeHtml(r.from);
  const to = escapeHtml(r.to);
  return pick([
    `По маршруту ${from} → ${to} чаще всего передают документы и бумаги для виз, лекарства из аптек, посылки родителям — кофе, чай, сладости, консервы, — а также одежду и небольшие коробки с вещами. Водители обычно указывают, сколько места есть: от «влезет конверт» до «могу взять чемодан». Тяжёлые и габаритные грузы честнее отправлять перевозчиком: попутка — для того, что можно передать из рук в руки.`,
    `Типичный груз на этом направлении — конверты с документами, аптечные позиции, продукты и небольшие подарки родственникам. Реже возят технику и одежду. Взвешивать «на глаз» не стоит: посмотрите в заявке лимит по весу и убедитесь, что посылка в него влезает — водителю ещё её нести. Всё запрещённое к перевозке через границу — от лекарств без рецепта до паспортов третьих лиц — на доске размещать нельзя, такие объявления снимаются.`,
    `Что обычно везут из ${from} в ${to}: документы, банковские карты (сами сообщаете номер — не передавайте!), продукты с долгим сроком хранения, вещи, книги, запчасти. Перед передачей упакуйте посылку так, чтобы её можно было открыть и показать содержимое на границе — водителя могут попросить. Ничего ценнее морального комфорта не кладите: попутная передача — это доверие, а не страхование груза.`,
  ], seed + 'what');
}

function priceText(r: SeoRoute, seed: string): string {
  const from = escapeHtml(r.from);
  const to = escapeHtml(r.to);
  return pick([
    `Цена договорная и зависит от веса и срочности: конверт с документами часто передают просто так или за 20–50 zł/€, коробка 5–10 кг — обычно заметно дешевле курьерской службы. Точную цифру называйте сразу в переписке, чтобы не тратить время ни себе, ни водителю. Если просят полную предоплату «за бронь места» — это мошенничество, на доске так не работают.`,
    `Сколько стоит передать посылку по маршруту ${from} → ${to}? Как договоритесь: чаще всего это символическая сумма — 20–100 zł за конверт или небольшую коробку, иногда передают бесплатно. Ориентир простой: попутная передача всегда дешевле курьера, потому что машина уже едет по этому пути. Деньги передают при получении посылки, а не до.`,
  ], seed + 'price');
}

function safetyText(seed: string): string {
  return pick([
    `Доска не проверяет паспорта и не даёт «звёздочек доверия» — зато каждое объявление проходит модерацию, а три жалобы снимают его автоматически. Главные правила здравого смысла: не отдавайте деньги, пока не увидели посылку в машине; переписывайтесь в Telegram, чтобы осталась история; содержимое показывайте при передаче, а не «поверьте на слово». Если что-то пошло не так — жалуйтесь прямо из карточки объявления.`,
    `Безопасность на попутной передаче держится на трёх вещах: открытая переписка (история сообщений в Telegram — уже документ), передача из рук в руки при встрече и оплата по факту. Водитель, который просит перевести деньги «за бронь», или отправитель, который не хочет показывать содержимое, — повод отказаться. Объявления на доске модерируются вручную, но здравый смысл никого не отменял.`,
    `Как не нарваться на мошенника: у настоящего водителя есть дата выезда, понимающий маршрут и живой диалог. Мошенника выдают срочность, «последнее место» и просьба о предоплате. Никогда не отправляйте деньги вперёд и не передавайте чужие паспорта и карты — за это ответственность несут оба. Жалоба из карточки объявления доходит модератору напрямую.`,
  ], seed + 'safety');
}

function faqText(r: SeoRoute, seed: string): Array<[string, string]> {
  const from = escapeHtml(r.from);
  const to = escapeHtml(r.to);
  return pick([
    [
      ['А если по маршруту сейчас пусто?', `Заявки появляются по мере того, как люди планируют поездки. Разместите просьбу «нужно передать ${from} → ${to}» — водители увидят её на доске и в боте, и часто откликаются в тот же день. Объявление бесплатное.`],
      ['Это точно бесплатно?', 'Да. Доска не берёт ни комиссии, ни платы за размещение, ни подписки. Деньги вы договариваетесь передать непосредственно водителю — и только с ним.'],
    ],
    [
      ['Кто эти водители?', 'Обычные люди, которые едут по своим делам: работа, учёба, визиты к родным. Объявления с сайта и из телеграм-чатов проходят ручную модерацию, а контакт вы видите в самой заявке.'],
      ['Что нельзя передавать?', 'Оружие, наркотики, лекарства без рецепта, чужие документы и карты, животных без документов. За перевозку запрещённого отвечает и отправитель, и передающий — такие объявления снимаются без предупреждения.'],
    ],
  ], seed + 'faq');
}

/* ------------------------------------------------------------------ */
/* Разметка                                                            */
/* ------------------------------------------------------------------ */

/** Строка объявления на SEO-странице — та же разметка, что на доске (src/ssr.ts). */
function listingCard(l: Listing, chatLinks: Record<string, string>): string {
  return renderRowHtml(l, { chatLinks, openLink: true });
}

/* ------------------------------------------------------------------ */
/* Оболочка SEO-страницы                                               */
/* ------------------------------------------------------------------ */

/** Общая оболочка SEO-страниц (маршруты, города, каталоги, итоги). */
export function seoPageShell(opts: {
  title: string;
  description: string;
  canonical: string;
  origin: string;
  body: string;
  jsonLd?: Array<unknown | null | undefined>;
  image?: string;
  imageAlt?: string;
  robots?: string;
}): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#f2eee5" />
  <title>${escapeHtml(opts.title)}</title>
  <meta name="description" content="${escapeHtml(opts.description)}" />
  ${headMeta({
    title: opts.title,
    description: opts.description,
    canonical: opts.canonical,
    origin: opts.origin,
    robots: opts.robots,
    image: opts.image,
    imageAlt: opts.imageAlt,
  })}
  ${jsonLdAll(opts.jsonLd ?? [])}
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' fill='%23f2eee5'/><text x='50' y='68' font-size='52' font-family='Georgia' text-anchor='middle' fill='%23201d17'>п</text></svg>" />
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <header class="masthead">
    <div class="wrap masthead-grid">
      <a class="wordmark" href="/">попутка<span class="wordmark-dot">.</span></a>
      <nav class="topnav wrap" style="padding:0">
        <a href="/">Доска</a>
        <a href="/how">Как это работает</a>
        <a href="/routes">Маршруты</a>
        <a href="/gorod">Города</a>
        <a href="/new" class="btn btn-ink nav-cta">+ разместить</a>
      </nav>
    </div>
  </header>
  <main class="wrap narrow section-page seo-page">
${opts.body}
  </main>
  <footer class="colophon-foot wrap">
    <div class="foot-row">
      <span class="wordmark small">${SITE_NAME}</span>
      <p class="foot-note">Личная доска без посредников: люди договариваются между собой напрямую.</p>
      <nav class="foot-links">
        <a href="/terms">условия</a>
        <a href="/privacy">приватность</a>
        <a href="/itogi">итоги месяца</a>
      </nav>
    </div>
    <p class="foot-meta">нашли фейк — жалоба из карточки объявления</p>
  </footer>
</body>
</html>`;
}

function crumbs(origin: string, trail: Crumb[]): string {
  return `<nav class="crumbs" aria-label="Хлебные крошки">${trail
    .map((c) => (c.path ? `<a href="${escapeHtml(c.path)}">${escapeHtml(c.name)}</a>` : `<span>${escapeHtml(c.name)}</span>`))
    .join(' <span class="crumb-sep">›</span> ')}</nav>`;
}

/* ------------------------------------------------------------------ */
/* Индекс маршрутов и городов: витрина + живые данные из базы          */
/* ------------------------------------------------------------------ */

interface RouteEntry extends SeoRoute {
  /** живая статистика пары (для динамических маршрутов и подписей) */
  pair?: RoutePair;
  curated: boolean;
}

interface RouteIndex {
  bySlug: Map<string, RouteEntry>;
  /** «Варшава|Минск» → slug (строго один слаг на пару) */
  byPair: Map<string, string>;
  /** транслитный слаг → витринный (301, чтобы не плодить дубли) */
  aliasBySlug: Map<string, string>;
  cityBySlug: Map<string, { city: string; stat?: CityStat }>;
  pairs: RoutePair[];
  cities: CityStat[];
  at: number;
}

const INDEX_TTL = 10 * 60 * 1000; // 10 минут: страницы живые, но не дёргаем D1 на каждый запрос
let indexCache: RouteIndex | null = null;

const pairKey = (from: string, to: string) => `${from.toLowerCase()}|${to.toLowerCase()}`;

/** Сбросить кэш индекса (тесты и принудительное обновление). */
export function clearRouteIndexCache(): void {
  indexCache = null;
}

async function routeIndex(env: Env, force = false): Promise<RouteIndex> {
  if (!force && indexCache && Date.now() - indexCache.at < INDEX_TTL) return indexCache;

  const bySlug = new Map<string, RouteEntry>();
  const byPair = new Map<string, string>();
  const aliasBySlug = new Map<string, string>();

  // 1) витрина: адреса уже в индексе, их слаги не меняем
  for (const r of SEO_ROUTES) {
    bySlug.set(r.slug, { ...r, curated: true });
    byPair.set(pairKey(r.from, r.to), r.slug);
    // «Варшава → Кёльн» транслитом дало бы varshava-keln: такой адрес
    // редиректим на витринный, а не отдаём 404 и не делаем вторую страницу
    const auto = routeSlug(r.from, r.to);
    if (auto && auto !== r.slug) aliasBySlug.set(auto, r.slug);
  }

  // 2) живые пары из базы — только те, которых нет в витрине
  let pairs: RoutePair[] = [];
  let cities: CityStat[] = [];
  try {
    [pairs, cities] = await Promise.all([listRoutePairs(env, 500), listCityStats(env, 300)]);
  } catch (e) {
    console.error('route index: база недоступна', e);
  }
  for (const p of pairs) {
    const key = pairKey(p.fromCity, p.toCity);
    const existing = byPair.get(key);
    if (existing) {
      const entry = bySlug.get(existing);
      if (entry) entry.pair = p; // витринный маршрут — та же пара, страница одна
      continue;
    }
    const slug = routeSlug(p.fromCity, p.toCity);
    if (!slug || bySlug.has(slug)) continue;
    bySlug.set(slug, { from: p.fromCity, to: p.toCity, slug, curated: false, pair: p });
    byPair.set(key, slug);
  }

  // 3) города: известные нам (витрина подвала) + те, что встречаются в заявках
  const cityBySlug = new Map<string, { city: string; stat?: CityStat }>();
  for (const city of Object.keys(CITY_COUNTRY)) {
    const slug = citySlug(city);
    if (slug) cityBySlug.set(slug, { city });
  }
  for (const stat of cities) {
    const slug = citySlug(stat.city);
    if (slug) cityBySlug.set(slug, { city: stat.city, stat });
  }

  indexCache = { bySlug, byPair, aliasBySlug, cityBySlug, pairs, cities, at: Date.now() };
  return indexCache;
}

/** Маршрут по слагу: витрина или живая пара из базы. */
export async function resolveRoute(env: Env, slug: string): Promise<RouteEntry | null> {
  const idx = await routeIndex(env);
  return idx.bySlug.get(slug) ?? null;
}

/**
 * Транслитный слаг, который на самом деле ведёт на витринную страницу:
 * /r/varshava-keln → /r/varshava-koln. Нужно для честного 301.
 */
export async function resolveRouteAlias(env: Env, slug: string): Promise<string | null> {
  const idx = await routeIndex(env);
  return idx.aliasBySlug.get(slug) ?? null;
}

/** Город по слагу. */
export async function resolveCity(env: Env, slug: string): Promise<{ city: string; stat?: CityStat } | null> {
  const idx = await routeIndex(env);
  return idx.cityBySlug.get(slug) ?? null;
}

/** Есть ли страница у этой пары городов — для ссылок и хлебных крошек. */
export async function routePathFor(env: Env, from: string, to: string): Promise<string | null> {
  const idx = await routeIndex(env);
  const slug = idx.byPair.get(pairKey(from, to));
  return slug ? `/r/${slug}` : null;
}

export function cityPathFor(city: string): string {
  const slug = citySlug(city);
  return slug ? `/gorod/${slug}` : '/gorod';
}

/** Синхронный вариант для витрины (используется там, где базы под рукой нет). */
export function curatedRoutePath(from: string, to: string): string | null {
  const r = SEO_ROUTES.find((x) => x.from === from && x.to === to);
  return r ? `/r/${r.slug}` : null;
}

/* ------------------------------------------------------------------ */
/* Текст страниц городов                                               */
/* ------------------------------------------------------------------ */

function cityIntro(city: string, country: string | null, active: number, seed: string): string {
  const c = escapeHtml(city);
  const cGen = escapeHtml(genitiveCity(city));
  const cAcc = escapeHtml(accusativeCity(city));
  const cFrom = escapeHtml(fromCity(city));
  const where = country ? ` ${inCountry(country)}` : '';
  const live = active > 0
    ? `Сейчас на доске ${active} ${plural(active, 'заявка', 'заявки', 'заявок')} с этим городом`
    : 'Сейчас заявок с этим городом нет — они появляются волнами, к выходным и перед праздниками';
  return pick([
    `${c}${where} — частая точка на доске попутных передач: отсюда везут посылки и документы и сюда же ищут, кто передаст. ${live}. Ниже — направления с числом заявок и сами объявления: кто едет, когда, сколько готов взять и как с ним связаться.`,
    `Передачи ${cFrom} и обратно: люди едут по своим делам и берут посылки попутно — документы, лекарства, вещи, продукты. ${live}. Доска только знакомит: о цене, месте и времени вы договариваетесь напрямую, без посредников и комиссий.`,
    `Здесь собрано всё, что происходит на доске вокруг города ${cGen}${where}: куда едут водители, откуда ждут передачи и какие направления самые живые. ${live}. Объявления обновляются сами — как только модератор пропускает новое.`,
  ], seed + 'city-intro');
}

function cityHowto(city: string, seed: string): Array<[string, string]> {
  const c = escapeHtml(city);
  const cGen = escapeHtml(genitiveCity(city));
  const cAcc = escapeHtml(accusativeCity(city));
  const cFrom = escapeHtml(fromCity(city));
  return pick([
    [
      ['Посмотрите направления', `Ниже — куда едут ${cFrom} и откуда везут сюда. Нажмите на направление, чтобы увидеть все заявки по нему: даты выезда, вес, цену и контакт.`],
      ['Или откройте доску с фильтром', `На доске можно вписать «${cAcc}» в поле «откуда» или «куда» и смотреть только свои направления — включая архив прошедших рейсов.`],
      ['Напишите человеку напрямую', 'Связь в Telegram или по телефону. Договоритесь о месте, времени и вознаграждении; деньги вперёд не отправляйте — добросовестному водителю это не нужно.'],
    ],
    [
      ['Разместите свою заявку', `Если подходящего рейса нет, опишите, что и когда нужно передать (${cFrom} или сюда) — это бесплатно, объявление появится после проверки модератором.`],
      ['Дождитесь отклика', 'Водители смотрят доску и список просьб каждый день: часто отвечают в тот же день.'],
      ['Договоритесь о деталях', 'Место встречи, вес, упаковка, цена — всё в личной переписке. Содержимое показывайте при встрече, а не «на слово».'],
    ],
  ], seed + 'city-howto');
}

function cityFaq(city: string, seed: string): Array<[string, string]> {
  const c = escapeHtml(city);
  const cGen = escapeHtml(genitiveCity(city));
  const cAcc = escapeHtml(accusativeCity(city));
  const cFrom = escapeHtml(fromCity(city));
  return pick([
    [
      ['Это бесплатно?', `Да. Разместить заявку или найти водителя ${cFrom} можно без оплаты: доска не берёт комиссию и не продаёт контакты. Деньги — только тому, кто везёт, и по договорённости.`],
      ['А если заявок сейчас нет?', `Направления живут волнами: больше всего заявок перед выходными и праздниками. Разместите просьбу — её увидят на доске и в боте, часто откликаются в тот же день.`],
    ],
    [
      ['Кто эти водители?', 'Обычные люди, которые едут по своим делам: работа, учёба, визиты к родным. Каждое объявление проходит ручную модерацию, контакт виден в заявке.'],
      ['Что нельзя передавать?', 'Оружие, наркотики, лекарства без рецепта, чужие документы и карты, животных без документов. Такие объявления снимаются без предупреждения — за перевозку запрещённого отвечают оба.'],
    ],
  ], seed + 'city-faq');
}

/* ------------------------------------------------------------------ */
/* Страница маршрута /r/:slug                                          */
/* ------------------------------------------------------------------ */

/** Страница маршрута /r/:slug. null — маршрута нет (отдаём 404). */
export async function buildRoutePage(env: Env, slug: string, origin: string): Promise<string | null> {
  const r = await resolveRoute(env, slug);
  if (!r) return null;
  const seed = r.slug;

  const [{ items: main }, { items: back }, chatLinks] = await Promise.all([
    listListings(env, { from: r.from, to: r.to, perPage: 15 }),
    listListings(env, { from: r.to, to: r.from, perPage: 5 }),
    getChatLinks(env).catch(() => ({} as Record<string, string>)),
  ]);

  const idx = await routeIndex(env);
  const reverseRoute = idx.byPair.get(pairKey(r.to, r.from)) ?? null;
  const active = r.pair?.active ?? main.length;

  // «Смотрите также»: соседние направления из базы (а не только витрина)
  const neighbours = [...idx.bySlug.values()]
    .filter((x) => x.slug !== r.slug && (x.from === r.from || x.to === r.to || x.from === r.to || x.to === r.from))
    .sort((a, b) => (b.pair?.active ?? 0) - (a.pair?.active ?? 0))
    .slice(0, 10);

  const boardUrl = `/?from=${encodeURIComponent(r.from)}&to=${encodeURIComponent(r.to)}`;
  const statsLine = [
    r.pair ? `${r.pair.active} ${plural(r.pair.active, 'заявка', 'заявки', 'заявок')} на доске` : null,
    back.length ? `${back.length} ${plural(back.length, 'обратный рейс', 'обратных рейса', 'обратных рейсов')}` : null,
    r.pair?.lastmod ? `обновлено ${fmtDayShort(r.pair.lastmod)}` : null,
  ].filter(Boolean).join(' · ');

  const title = `Передать посылку ${r.from} → ${r.to} — заявки водителей | ${SITE_NAME}`;
  const description = `Нужно передать посылку ${r.from} → ${r.to}? Водители берут посылки попутно: даты выезда, вес, цена и контакт — напрямую, без посредников и комиссий. Обновляется каждый день.`;

  const listingsHtml = main.length > 0
    ? main.map((l) => listingCard(l, chatLinks)).join('\n')
    : `<p class="empty-note">По этому маршруту сейчас нет активных заявок. Разместите просьбу — водители увидят её на доске и в боте, отклик обычно приходит в тот же день.</p>`;

  const backHtml = back.length > 0
    ? `\n<h2 class="rule-head">Обратные рейсы ${escapeHtml(r.to)} → ${escapeHtml(r.from)}</h2>\n<div class="rows">${back.map((l) => listingCard(l, chatLinks)).join('\n')}</div>`
    : '';

  const relatedHtml = neighbours.length > 0
    ? `<h2 class="rule-head">Смотрите также</h2><p class="related">${neighbours.map((x) =>
        `<a href="/r/${x.slug}">${escapeHtml(x.from)} → ${escapeHtml(x.to)}</a>`).join('')}${
          reverseRoute && !neighbours.some((x) => x.slug === reverseRoute)
            ? `<a href="/r/${reverseRoute}">${escapeHtml(r.to)} → ${escapeHtml(r.from)}</a>`
            : ''
        }</p>`
    : '';

  const steps = howtoText(r, seed).map(([h, t]) => `<li><b>${escapeHtml(h)}</b>: ${t}</li>`).join('\n');
  const faq = faqText(r, seed);
  const faqHtml = faq.map(([q, a]) =>
    `<details class="qa"><summary>${escapeHtml(q)}</summary><p>${a}</p></details>`).join('\n');

  const trail: Crumb[] = [
    { name: 'Доска', path: '/' },
    { name: 'Маршруты', path: '/routes' },
    { name: r.from, path: cityPathFor(r.from) },
    { name: `${r.from} → ${r.to}` },
  ];

  const countryFrom = CITY_COUNTRY[r.from]?.name ?? null;
  const countryTo = CITY_COUNTRY[r.to]?.name ?? null;

  const body = `    ${crumbs(origin, trail)}
    <p class="doc-date">${r.curated ? 'популярный маршрут' : 'живой маршрут'}</p>
    <h1 class="page-title">Передать посылку ${escapeHtml(r.from)} <span class="r-arrow">→</span> ${escapeHtml(r.to)}</h1>
    <p class="route-cities">${countryFrom ?? ''}${countryTo && countryFrom !== countryTo ? ' ↔ ' + countryTo : ''}${statsLine ? ' · ' + statsLine : ''}</p>

    <p class="lead">${introText(r, seed)}</p>

    <div class="cta-row">
      <a class="btn btn-ink btn-lg" href="/new">Разместить объявление</a>
      <a class="btn btn-line btn-lg" href="${boardUrl}">Открыть на доске</a>
      <a class="btn btn-line btn-lg" href="${cityPathFor(r.from)}">${escapeHtml(r.from)}: все направления</a>
    </div>

    <h2 class="rule-head">Заявки по маршруту сейчас</h2>
    <div class="rows">${listingsHtml}</div>${backHtml}

    <h2 class="rule-head">Как передать посылку ${escapeHtml(r.from)} → ${escapeHtml(r.to)}</h2>
    <ol class="steps">${steps}</ol>

    <h2 class="rule-head">Что обычно передают</h2>
    <p>${whatText(r, seed)}</p>

    <h2 class="rule-head">Сколько это стоит</h2>
    <p>${priceText(r, seed)}${active > 0 ? ` На этой странице ${active} ${plural(active, 'живая заявка', 'живые заявки', 'живых заявок')} — цены в них настоящие, их пишут сами водители.` : ''}</p>

    <h2 class="rule-head">Безопасность</h2>
    <p>${safetyText(seed)}</p>

    <h2 class="rule-head">Частые вопросы</h2>
    ${faqHtml}

    ${relatedHtml}

    <p class="colophon">Не нашли рейс на нужную дату? Разместите просьбу — это бесплатно и занимает минуту: <a href="/new">форма на сайте</a> или бот в Telegram.</p>`;

  return seoPageShell({
    title,
    description,
    canonical: `${origin}/r/${r.slug}`,
    origin,
    body,
    image: `${origin}/og-route/${r.slug}.png`,
    imageAlt: `${r.from} → ${r.to}: передать посылку попутно`,
    jsonLd: [
      breadcrumbsLd(origin, trail),
      itemListLd(origin, `Заявки ${r.from} → ${r.to}`, main.map((l) => ({
        path: `/item/${encodeURIComponent(l.id)}`,
        name: `${l.fromCity} → ${l.toCity}${l.departureDate ? `, выезд ${fmtDayShort(l.departureDate)}` : ''}`,
      }))),
      faqPageLd(faq),
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Страница города /gorod/:slug                                        */
/* ------------------------------------------------------------------ */

/** Страница города: направления, заявки из города и в город. null — города нет. */
export async function buildCityPage(env: Env, slug: string, origin: string): Promise<string | null> {
  const found = await resolveCity(env, slug);
  if (!found) return null;
  const { city, stat } = found;
  const idx = await routeIndex(env);
  const country = CITY_COUNTRY[city]?.name ?? null;

  const [outPage, inPage, chatLinks] = await Promise.all([
    listListings(env, { from: city, perPage: 12 }),
    listListings(env, { to: city, perPage: 12 }),
    getChatLinks(env).catch(() => ({} as Record<string, string>)),
  ]);
  const outItems = outPage.items;
  const inItems = inPage.items;

  const directionsOut = idx.pairs.filter((p) => p.fromCity === city).slice(0, 12);
  const directionsIn = idx.pairs.filter((p) => p.toCity === city).slice(0, 12);
  const otherCities = idx.cities
    .filter((c) => c.city !== city && (country ? CITY_COUNTRY[c.city]?.name === country : true))
    .slice(0, 12);

  const active = stat?.active ?? outItems.length + inItems.length;
  const gen = genitiveCity(city);
  const acc = accusativeCity(city);
  const title = `Передачи ${fromCity(city)} и в ${acc} — направления и заявки | ${SITE_NAME}`;
  const description = `${city}${country ? ` (${country})` : ''}: кто едет и что готов передать. Направления с числом заявок, живые объявления водителей и просьбы передать посылку — договариваетесь напрямую, без посредников.`;

  const dirBlock = (title2: string, dirs: RoutePair[], fromHere: boolean) => {
    if (dirs.length === 0) return '';
    const links = dirs.map((d) => {
      const s = idx.byPair.get(pairKey(d.fromCity, d.toCity));
      const label = fromHere ? `${escapeHtml(d.toCity)}` : `${escapeHtml(d.fromCity)}`;
      return s
        ? `<a href="/r/${s}">${label} <span class="mono">${d.active}</span></a>`
        : `<a href="/?from=${encodeURIComponent(d.fromCity)}&to=${encodeURIComponent(d.toCity)}">${label} <span class="mono">${d.active}</span></a>`;
    }).join('');
    return `\n<h2 class="rule-head">${escapeHtml(title2)}</h2>\n<p class="related">${links}</p>`;
  };

  const rowsBlock = (title2: string, items: Listing[]) => {
    if (items.length === 0) return '';
    return `\n<h2 class="rule-head">${escapeHtml(title2)}</h2>\n<div class="rows">${items.map((l) => listingCard(l, chatLinks)).join('\n')}</div>`;
  };

  const steps = cityHowto(city, slug).map(([h, t]) => `<li><b>${escapeHtml(h)}</b>: ${t}</li>`).join('\n');
  const faq = cityFaq(city, slug);
  const faqHtml = faq.map(([q, a]) => `<details class="qa"><summary>${escapeHtml(q)}</summary><p>${a}</p></details>`).join('\n');

  const trail: Crumb[] = [
    { name: 'Доска', path: '/' },
    { name: 'Города', path: '/gorod' },
    { name: city },
  ];

  const body = `    ${crumbs(origin, trail)}
    <p class="doc-date">город на доске</p>
    <h1 class="page-title">Передачи ${escapeHtml(fromCity(city))} и в ${escapeHtml(acc)}</h1>
    <p class="route-cities">${country ? escapeHtml(country) + ' · ' : ''}${active} ${plural(active, 'заявка', 'заявки', 'заявок')} сейчас${stat?.lastmod ? ' · обновлено ' + fmtDayShort(stat.lastmod) : ''}</p>

    <p class="lead">${cityIntro(city, country, active, slug)}</p>

    <div class="cta-row">
      <a class="btn btn-ink btn-lg" href="/new">Разместить объявление</a>
      <a class="btn btn-line btn-lg" href="/?from=${encodeURIComponent(city)}">Куда едут ${escapeHtml(fromCity(city))}</a>
      <a class="btn btn-line btn-lg" href="/?to=${encodeURIComponent(city)}">Кто едет в ${escapeHtml(acc)}</a>
    </div>
${dirBlock(`Куда едут ${fromCity(city)}`, directionsOut, true)}
${dirBlock(`Откуда везут в ${acc}`, directionsIn, false)}
${rowsBlock(`Заявки ${fromCity(city)} сейчас`, outItems)}
${rowsBlock(`Заявки в ${acc} сейчас`, inItems)}

    <h2 class="rule-head">Как договориться о передаче</h2>
    <ol class="steps">${steps}</ol>

    <h2 class="rule-head">Безопасность</h2>
    <p>${safetyText(slug)}</p>

    <h2 class="rule-head">Частые вопросы</h2>
    ${faqHtml}
${otherCities.length > 0 ? `\n    <h2 class="rule-head">Другие города${country ? ' (' + escapeHtml(country) + ')' : ''}</h2>\n    <p class="related">${otherCities.map((c) => `<a href="/gorod/${citySlug(c.city)}">${escapeHtml(c.city)} <span class="mono">${c.active}</span></a>`).join('')}</p>` : ''}

    <p class="colophon">Не нашли нужное направление? Откройте <a href="/">доску</a> и впишите города в поиск — заявки фильтруются по любому маршруту.</p>`;

  return seoPageShell({
    title,
    description,
    canonical: `${origin}/gorod/${slug}`,
    origin,
    body,
    image: `${origin}/og-route/${slug}.png`,
    imageAlt: `${city}: передачи и посылки попутно`,
    jsonLd: [
      breadcrumbsLd(origin, trail),
      itemListLd(origin, `Направления ${fromCity(city)}`, directionsOut.map((d) => ({
        path: `/r/${idx.byPair.get(pairKey(d.fromCity, d.toCity)) ?? ''}`,
        name: `${d.fromCity} → ${d.toCity}`,
      })).filter((x) => x.path !== '/r/')),
      faqPageLd(faq),
    ],
  });
}

/* ------------------------------------------------------------------ */
/* Каталоги                                                            */
/* ------------------------------------------------------------------ */

/** Каталог всех маршрутов /routes: витрина + живые пары из базы. */
export async function buildRoutesIndexPage(env: Env, origin: string): Promise<string> {
  const idx = await routeIndex(env);

  const groups = new Map<string, RouteEntry[]>();
  for (const r of idx.bySlug.values()) {
    const cf = CITY_COUNTRY[r.from]?.name;
    const ct = CITY_COUNTRY[r.to]?.name;
    const key = cf && ct && cf !== ct ? `${cf} ↔ ${ct}` : cf && !ct ? `${cf} → другие страны` : 'Внутри страны и другие';
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }

  const list = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([group, routes]) =>
      `<h2 class="rule-head">${escapeHtml(group)}</h2>
<p class="related">${routes
        .sort((a, b) => (b.pair?.active ?? 0) - (a.pair?.active ?? 0))
        .map((r) => `<a href="/r/${r.slug}">${escapeHtml(r.from)} → ${escapeHtml(r.to)}${r.pair?.active ? ` <span class="mono">${r.pair.active}</span>` : ''}</a>`)
        .join('')}</p>`)
    .join('\n');

  const cityLinks = idx.cities.slice(0, 40).map((c) =>
    `<a href="/gorod/${citySlug(c.city)}">${escapeHtml(c.city)} <span class="mono">${c.active}</span></a>`).join('');

  const totalActive = idx.pairs.reduce((n, p) => n + p.active, 0);

  return seoPageShell({
    title: `Маршруты передачи посылок — все направления | ${SITE_NAME}`,
    description: 'Все направления передачи посылок попутно: Польша, Беларусь, Украина, Литва, Германия, Чехия и другие. На странице маршрута — живые заявки водителей, цены, вес и контакты.',
    canonical: `${origin}/routes`,
    origin,
    jsonLd: [
      breadcrumbsLd(origin, [{ name: 'Доска', path: '/' }, { name: 'Маршруты' }]),
      itemListLd(origin, 'Маршруты', [...idx.bySlug.values()].slice(0, 100).map((r) => ({
        path: `/r/${r.slug}`, name: `${r.from} → ${r.to}`,
      }))),
    ],
    body: `    ${crumbs(origin, [{ name: 'Доска', path: '/' }, { name: 'Маршруты' }])}
    <p class="doc-date">все направления</p>
    <h1 class="page-title">Маршруты передачи посылок</h1>
    <p class="route-cities">${idx.bySlug.size} ${plural(idx.bySlug.size, 'направление', 'направления', 'направлений')} · ${totalActive} ${plural(totalActive, 'заявка', 'заявки', 'заявок')} на доске</p>
    <p class="lead">Выберите направление — на странице маршрута собраны живые заявки водителей и просьбы передать посылку, а также подробности: что обычно везут, сколько это стоит и как не нарваться на мошенника. Страницы появляются сами: как только на доске возникает новая пара городов с живой заявкой.</p>
${list}
    <h2 class="rule-head">Города</h2>
    <p class="related">${cityLinks}<a href="/gorod">все города →</a></p>
    <p class="colophon">Нет нужного маршрута? Откройте <a href="/">доску</a> и впишите города в поиск — заявки фильтруются по любому направлению.</p>`,
  });
}

/** Каталог городов /gorod. */
export async function buildCitiesIndexPage(env: Env, origin: string): Promise<string> {
  const idx = await routeIndex(env);
  const groups = new Map<string, CityStat[]>();
  for (const c of idx.cities) {
    const key = CITY_COUNTRY[c.city]?.name ?? 'Другие города';
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }
  const list = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([country, cs]) =>
      `<h2 class="rule-head">${escapeHtml(country)}</h2>
<p class="related">${cs.sort((a, b) => b.active - a.active).map((c) =>
        `<a href="/gorod/${citySlug(c.city)}">${escapeHtml(c.city)} <span class="mono">${c.active}</span></a>`).join('')}</p>`)
    .join('\n');

  return seoPageShell({
    title: `Города — откуда и куда передают посылки | ${SITE_NAME}`,
    description: 'Города на доске попутных передач: направления, живые заявки водителей и просьбы передать посылку. Польша, Беларусь, Украина, Литва, Германия и другие страны.',
    canonical: `${origin}/gorod`,
    origin,
    jsonLd: [
      breadcrumbsLd(origin, [{ name: 'Доска', path: '/' }, { name: 'Города' }]),
      itemListLd(origin, 'Города', idx.cities.slice(0, 100).map((c) => ({ path: `/gorod/${citySlug(c.city)}`, name: c.city }))),
    ],
    body: `    ${crumbs(origin, [{ name: 'Доска', path: '/' }, { name: 'Города' }])}
    <p class="doc-date">города на доске</p>
    <h1 class="page-title">Города</h1>
    <p class="route-cities">${idx.cities.length} ${plural(idx.cities.length, 'город', 'города', 'городов')} · число рядом — сколько заявок сейчас</p>
    <p class="lead">Выберите город: на его странице — куда едут водители, откуда ждут передачи и какие заявки живые прямо сейчас.</p>
${list}
    <p class="colophon">Нужного города нет? Он появится, как только по нему разместят первую заявку. А пока откройте <a href="/">доску</a> — поиск понимает любые города, и латиницу тоже.</p>`,
  });
}

/* ------------------------------------------------------------------ */
/* Карта сайта                                                         */
/* ------------------------------------------------------------------ */

const XML_HEADERS = { 'Content-Type': 'application/xml; charset=utf-8' };
export { XML_HEADERS };

function urlEntry(loc: string, opts: { lastmod?: string; changefreq?: string; priority?: string } = {}): string {
  const inner = [
    `    <loc>${loc}</loc>`,
    opts.lastmod ? `    <lastmod>${opts.lastmod}</lastmod>` : null,
    opts.changefreq ? `    <changefreq>${opts.changefreq}</changefreq>` : null,
    opts.priority ? `    <priority>${opts.priority}</priority>` : null,
  ].filter(Boolean).join('\n');
  return `  <url>\n${inner}\n  </url>`;
}

function urlset(entries: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`;
}

function sitemapIndex(entries: Array<{ loc: string; lastmod?: string }>): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries
    .map((e) => `  <sitemap>\n    <loc>${e.loc}</loc>${e.lastmod ? `\n    <lastmod>${e.lastmod}</lastmod>` : ''}\n  </sitemap>`)
    .join('\n')}\n</sitemapindex>\n`;
}

/** Постоянные страницы сайта. */
export function buildPagesSitemap(origin: string, lastmod: string): string {
  const pages: Array<[string, string, string]> = [
    ['/', 'hourly', '1.0'],
    ['/routes', 'daily', '0.9'],
    ['/gorod', 'daily', '0.9'],
    ['/how', 'monthly', '0.6'],
    ['/bot', 'monthly', '0.6'],
    ['/new', 'monthly', '0.7'],
    ['/terms', 'yearly', '0.3'],
    ['/privacy', 'yearly', '0.3'],
    ['/itogi', 'monthly', '0.7'],
  ];
  return urlset(pages.map(([path, changefreq, priority]) =>
    urlEntry(`${origin}${path}`, { lastmod, changefreq, priority })));
}

/** Маршруты и города — с lastmod из базы. */
export async function buildRoutesSitemap(env: Env, origin: string): Promise<string> {
  const idx = await routeIndex(env);
  const entries: string[] = [];
  for (const r of idx.bySlug.values()) {
    entries.push(urlEntry(`${origin}/r/${r.slug}`, {
      lastmod: r.pair?.lastmod || undefined,
      changefreq: 'daily',
      priority: r.curated ? '0.8' : '0.6',
    }));
  }
  for (const [slug, c] of idx.cityBySlug) {
    // город без заявок в индекс не пускаем: страница была бы пустой
    if (!c.stat || c.stat.active < 1) continue;
    entries.push(urlEntry(`${origin}/gorod/${slug}`, {
      lastmod: c.stat.lastmod || undefined,
      changefreq: 'daily',
      priority: '0.7',
    }));
  }
  return urlset(entries);
}

/** Объявления, которые видны на сайте. */
export async function buildItemsSitemap(env: Env, origin: string, limit = 5000): Promise<string> {
  try {
    const items = await listSitemapItems(env, limit);
    return urlset(items.map((i) => urlEntry(`${origin}/item/${encodeURIComponent(i.id)}`, {
      lastmod: i.lastmod || undefined,
      changefreq: 'weekly',
      priority: '0.5',
    })));
  } catch {
    return urlset([]);
  }
}

/**
 * /sitemap.xml — индекс из трёх карт (страницы, маршруты, объявления).
 * Разбиваем специально: объявления меняются каждый час, а витрина маршрутов —
 * раз в день, и поисковику незачем перечитывать всё разом.
 */
export async function buildSitemapXml(env: Env, origin: string): Promise<string> {
  const idx = await routeIndex(env);
  const latest = [
    ...idx.pairs.map((p) => p.lastmod),
    ...idx.cities.map((c) => c.lastmod),
  ].filter(Boolean).sort().pop() ?? new Date().toISOString().slice(0, 10);

  return sitemapIndex([
    { loc: `${origin}/sitemap-pages.xml`, lastmod: latest },
    { loc: `${origin}/sitemap-routes.xml`, lastmod: latest },
    { loc: `${origin}/sitemap-items.xml` },
  ]);
}

/* ------------------------------------------------------------------ */
/* Подписи для OG-картинок маршрутов и городов                         */
/* ------------------------------------------------------------------ */

export interface OgCardSpec {
  from: string;
  to?: string;
  badge?: string;
  meta?: string;
  note?: string;
}

/** Что написать на картинке маршрута: страны и живые заявки. */
export function routeOgSpec(r: RouteEntry): OgCardSpec {
  const cf = CITY_COUNTRY[r.from]?.name;
  const ct = CITY_COUNTRY[r.to]?.name;
  const countries = cf && ct && cf !== ct ? `${cf} ↔ ${ct}` : cf ?? null;
  const active = r.pair?.active ?? null;
  return {
    from: r.from,
    to: r.to,
    badge: active ? `${active} ${plural(active, 'заявка', 'заявки', 'заявок')} на доске` : 'передать посылку попутно',
    meta: countries ?? undefined,
    note: 'водитель везёт или нужно передать — договор напрямую, без посредников',
  };
}

/** Что написать на картинке города. */
export function cityOgSpec(city: string, stat?: CityStat): OgCardSpec {
  const country = CITY_COUNTRY[city]?.name ?? null;
  const active = stat?.active ?? 0;
  return {
    from: city,
    badge: active ? `${active} ${plural(active, 'заявка', 'заявки', 'заявок')} сейчас` : 'заявки появятся — город на доске',
    meta: country ?? undefined,
    note: 'куда едут и что готовы передать — обновления каждый день',
  };
}

/** Популярные маршруты для подвала (без дублирования направления). */
export function footRoutes(limit = 9): SeoRoute[] {
  const seen = new Set<string>();
  const out: SeoRoute[] = [];
  for (const r of SEO_ROUTES) {
    const key = [r.from, r.to].sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

/** Все известные города (витрина) — для подвала и перелинковки. */
export function knownCities(): string[] {
  return Object.keys(CITY_COUNTRY);
}

export { findRoute, routeIndex, CITY_COUNTRY };
