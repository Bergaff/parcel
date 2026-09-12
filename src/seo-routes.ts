/**
 * SEO-страницы популярных маршрутов: /r/варшава-львов и т.п.
 *
 * Люди ищут не «доска попутных передач», а «передать посылку варшава львов» —
 * под такие запросы делаем отдельную страницу на каждый популярный маршрут:
 * заголовок, честный текст (~500 слов, собран из вариативных блоков,
 * чтобы страницы не были копиями друг друга) и живые заявки из базы.
 *
 * Страницы рендерит воркер (см. /r/:slug в index.ts), в sitemap попадают
 * автоматически. Список маршрутов — ниже, порядок: Польша↔Украина,
 * Польша↔Беларусь, Беларусь↔Украина, Европа, внутри стран.
 */
import type { Env, Listing } from './types';
import { escapeHtml } from './util';
import { listListings } from './store';

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
  const cf = CITY_COUNTRY[r.from]?.name ?? '';
  const ct = CITY_COUNTRY[r.to]?.name ?? '';
  const between = cf && ct && cf !== ct ? ` между ${CITY_COUNTRY[r.from]!.inst} и ${CITY_COUNTRY[r.to]!.inst}` : '';
  return pick([
    `Маршрут ${r.from} → ${r.to} — один из самых частых на доске: люди регулярно едут${between ? between : ''} и берут посылки попутно, чтобы окупить бензин. На этой странице собраны действующие заявки водителей и просьбы передать посылку по этому направлению — обновляются сами, как только на доске появляется новое объявление.`,
    `Если нужно передать посылку из ${r.from} в ${r.to} — не обязательно искать курьерскую службу и платить за конверт как за груз. По этому направлению несколько раз в неделю едут обычные люди${between ? ` — маршрут соединяет ${cf} и ${ct}` : ''}, и большинство из них рады взять с собой конверт, коробку или сумку. Ниже — живые заявки с доски «попутка.».`,
    `Направление ${r.from} → ${r.to} живое круглый год: студенты, командировочные, водители-рекордсмены и просто попутчики. Каждый из них может стать вашим «курьером» — за символическую плату или просто в благодарность. Здесь видно, кто едет в ближайшие дни, что готов взять и как с ним связаться.`,
  ], seed + 'intro');
}

function howtoText(r: SeoRoute, seed: string): Array<[string, string]> {
  return pick([
    [
      ['1. Найдите заявку', `Откройте список ниже или доску с фильтром «${r.from} → ${r.to}». В каждой заявке видно дату выезда, сколько килограмм готов взять водитель и контакт.`],
      ['2. Напишите человеку', 'Связь — напрямую в Telegram или по телефону. Договоритесь о месте передачи, времени и вознаграждении: обычно это половина цены курьерской службы или просто «спасибо» и компенсация бензина.'],
      ['3. Передайте посылку', 'Взвешивайте, проверяйте содержимое вместе и не передавайте деньги вперёд: добросовестному водителю это не нужно.'],
    ],
    [
      ['Шаг 1. Разместите просьбу', `Если подходящего рейса сейчас нет, опишите, что и когда нужно передать по маршруту ${r.from} → ${r.to} — объявление бесплатное и появится на доске после проверки модератором.`],
      ['Шаг 2. Дождитесь отклика', 'Водители, которые планируют поездку, просматривают доску и список просьб: часто связываются в тот же день.'],
      ['Шаг 3. Договоритесь', 'Место, время, цена — всё решается в личной переписке. Доска только знакомит людей, посредников здесь нет.'],
    ],
  ], seed + 'howto');
}

function whatText(r: SeoRoute, seed: string): string {
  return pick([
    `По маршруту ${r.from} → ${r.to} чаще всего передают документы и бумаги для виз, лекарства из аптек, посылки родителям — кофе, чай, сладости, консервы, — а также одежду и небольшие коробки с вещами. Водители обычно указывают, сколько места есть: от «влезет конверт» до «могу взять чемодан». Тяжёлые и габаритные грузы честнее отправлять перевозчиком: попутка — для того, что можно передать из рук в руки.`,
    `Типичный груз на этом направлении — конверты с документами, аптечные позиции, продукты и небольшие подарки родственникам. Реже возят технику и одежду. Взвешивать «на глаз» не стоит: посмотрите в заявке лимит по весу и убедитесь, что посылка в него влезает — водителю ещё её нести. Всё запрещённое к перевозке через границу — от лекарств без рецепта до паспортов третьих лиц — на доске размещать нельзя, такие объявления снимаются.`,
    `Что обычно везут из ${r.from} в ${r.to}: документы, банковские карты (сами сообщаете номер — не передавайте!), продукты с долгим сроком хранения, вещи, книги, запчасти. Перед передачей упакуйте посылку так, чтобы её можно было открыть и показать содержимое на границе — водителя могут попросить. Ничего ценнее морального комфорта не кладите: попутная передача — это доверие, а не страхование груза.`,
  ], seed + 'what');
}

function priceText(r: SeoRoute, seed: string): string {
  return pick([
    `Цена договорная и зависит от веса и срочности: конверт с документами часто передают просто так или за 20–50 zł/€, коробка 5–10 кг — обычно заметно дешевле курьерской службы. Точную цифру называйте сразу в переписке, чтобы не тратить время ни себе, ни водителю. Если просят полную предоплату «за бронь места» — это мошенничество, на доске так не работают.`,
    `Сколько стоит передать посылку по маршруту ${r.from} → ${r.to}? Как договоритесь: чаще всего это символическая сумма — 20–100 zł за конверт или небольшую коробку, иногда передают бесплатно. Ориентир простой: попутная передача всегда дешевле курьера, потому что машина уже едет по этому пути. Деньги передают при получении посылки, а не до.`,
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
  return pick([
    [
      ['А если по маршруту сейчас пусто?', `Заявки появляются по мере того, как люди планируют поездки. Разместите просьбу «нужно передать ${r.from} → ${r.to}» — водители увидят её на доске и в боте, и часто откликаются в тот же день. Объявление бесплатное.`],
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

function listingCard(l: Listing, origin: string): string {
  const bits = [
    l.departureDate ? `выезд ${fmtDay(l.departureDate)}` : 'дата по договорённости',
    l.weightKg != null ? `${String(l.weightKg).replace('.', ',')} кг` : null,
    l.price,
    l.source === 'telegram' && l.sourceChat ? `из чата «${l.sourceChat}»` : 'с сайта',
  ].filter(Boolean).join(' · ');
  const contact = l.telegram
    ? `<a href="https://t.me/${escapeHtml(l.telegram.replace(/^@/, ''))}" target="_blank" rel="noopener">${escapeHtml(l.telegram)}</a>`
    : l.phone ? escapeHtml(l.phone) : 'контакт в карточке';
  return `<article class="row">
  <div class="row-main">
    <h3 class="route-line"><a href="/item/${encodeURIComponent(l.id)}">${escapeHtml(l.fromCity)} <span class="r-arrow">→</span> <span class="r-to">${escapeHtml(l.toCity)}</span></a></h3>
    <p class="desc">${escapeHtml(l.description.slice(0, 180))}${l.description.length > 180 ? '…' : ''}</p>
    <p class="meta-line">${escapeHtml(bits)} · контакт: ${contact}</p>
  </div>
  <div class="row-side">
    <span class="stamp stamp-${l.type}">${l.type === 'offer' ? 'водитель везёт' : 'ищу передачу'}</span>
    <a class="write-link" href="/item/${encodeURIComponent(l.id)}">открыть</a>
  </div>
</article>`;
}

function pageShell(opts: {
  title: string; description: string; canonical: string; origin: string; body: string;
}): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(opts.title)}</title>
  <meta name="description" content="${escapeHtml(opts.description)}" />
  <link rel="canonical" href="${opts.canonical}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="попутка." />
  <meta property="og:title" content="${escapeHtml(opts.title)}" />
  <meta property="og:description" content="${escapeHtml(opts.description)}" />
  <meta property="og:url" content="${opts.canonical}" />
  <meta property="og:image" content="${opts.origin}/og-cover.png" />
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' fill='%23f2eee5'/><text x='50' y='68' font-size='52' font-family='Georgia' text-anchor='middle' fill='%23201d17'>п</text></svg>" />
  <link rel="stylesheet" href="/styles.css" />
  <style>
    .lead { font-size: 19px; line-height: 1.55; color: var(--ink-soft); }
    .route-cities { font-size: 15px; color: var(--muted); margin: 4px 0 26px; }
    .seo-page .row { margin-bottom: 14px; }
    .cta-row { display: flex; gap: 12px; flex-wrap: wrap; margin: 26px 0 10px; }
    .related { margin-top: 34px; }
    .related a { display: inline-block; margin: 0 14px 8px 0; }
  </style>
</head>
<body>
  <header class="masthead">
    <div class="wrap masthead-grid">
      <a class="wordmark" href="/">попутка<span class="wordmark-dot">.</span></a>
      <nav class="topnav wrap" style="padding:0">
        <a href="/#/">Доска</a>
        <a href="/#/how">Как это работает</a>
        <a href="/routes">Маршруты</a>
        <a href="/#/new" class="btn btn-ink nav-cta">+ разместить</a>
      </nav>
    </div>
  </header>
  <main class="wrap narrow section-page seo-page">
${opts.body}
  </main>
  <footer class="colophon-foot wrap">
    <p class="foot-meta">попутка. — личная доска без посредников · <a href="/#/terms">условия</a> · <a href="/#/privacy">приватность</a></p>
  </footer>
</body>
</html>`;
}

/** Страница маршрута /r/:slug. null — маршрут не найден. */
export async function buildRoutePage(env: Env, slug: string, origin: string): Promise<string | null> {
  const r = findRoute(slug);
  if (!r) return null;
  const seed = r.slug;

  const [{ items: main }, { items: back }] = await Promise.all([
    listListings(env, { from: r.from, to: r.to, perPage: 15 }),
    listListings(env, { from: r.to, to: r.from, perPage: 5 }),
  ]);

  const reverseRoute = SEO_ROUTES.find((x) => x.from === r.to && x.to === r.from) ?? null;
  const related = SEO_ROUTES.filter((x) => x.slug !== r.slug && (x.from === r.from || x.to === r.to)).slice(0, 6);
  const boardUrl = `/?from=${encodeURIComponent(r.from)}&to=${encodeURIComponent(r.to)}#/`;

  const title = `Передать посылку ${r.from} → ${r.to} — заявки водителей | попутка.`;
  const description = `Нужно передать посылку ${r.from} → ${r.to}? Водители берут посылки попутно: даты выезда, вес, цена и контакт — напрямую, без посредников и комиссий. Обновляется каждый день.`;

  const listingsHtml = main.length > 0
    ? main.map((l) => listingCard(l, origin)).join('\n')
    : `<p class="empty-note">По этому маршруту сейчас нет активных заявок. Разместите просьбу — водители увидят её на доске и в боте, отклик обычно приходит в тот же день.</p>`;

  const backHtml = back.length > 0
    ? `\n<h2 class="rule-head">Обратные рейсы ${escapeHtml(r.to)} → ${escapeHtml(r.from)}</h2>\n<div class="rows">${back.map((l) => listingCard(l, origin)).join('\n')}</div>`
    : '';

  const relatedHtml = related.length > 0
    ? `<h2 class="rule-head">Смотрите также</h2><p class="related">${related.map((x) =>
        `<a href="/r/${x.slug}">${escapeHtml(x.from)} → ${escapeHtml(x.to)}</a>`).join('')}${
          reverseRoute ? `<a href="/r/${reverseRoute.slug}">${escapeHtml(reverseRoute.from)} → ${escapeHtml(reverseRoute.to)}</a>` : ''
        }</p>`
    : '';

  const steps = howtoText(r, seed).map(([h, t]) => `<li><b>${escapeHtml(h)}</b>: ${t}</li>`).join('\n');
  const faq = faqText(r, seed).map(([q, a]) =>
    `<details class="qa"><summary>${escapeHtml(q)}</summary><p>${a}</p></details>`).join('\n');

  const body = `    <p class="doc-date">популярный маршрут</p>
    <h1 class="page-title">Передать посылку ${escapeHtml(r.from)} <span class="r-arrow">→</span> ${escapeHtml(r.to)}</h1>
    <p class="route-cities">${CITY_COUNTRY[r.from]?.name ?? ''}${CITY_COUNTRY[r.to] && CITY_COUNTRY[r.from]?.name !== CITY_COUNTRY[r.to]?.name ? ' ↔ ' + CITY_COUNTRY[r.to]!.name : ''} · живые заявки с доски</p>

    <p class="lead">${introText(r, seed)}</p>

    <div class="cta-row">
      <a class="btn btn-ink btn-lg" href="/#/new">Разместить объявление</a>
      <a class="btn btn-line btn-lg" href="${boardUrl}">Открыть на доске</a>
    </div>

    <h2 class="rule-head">Заявки по маршруту сейчас</h2>
    <div class="rows">${listingsHtml}</div>${backHtml}

    <h2 class="rule-head">Как передать посылку ${escapeHtml(r.from)} → ${escapeHtml(r.to)}</h2>
    <ol class="steps">${steps}</ol>

    <h2 class="rule-head">Что обычно передают</h2>
    <p>${whatText(r, seed)}</p>

    <h2 class="rule-head">Сколько это стоит</h2>
    <p>${priceText(r, seed)}</p>

    <h2 class="rule-head">Безопасность</h2>
    <p>${safetyText(seed)}</p>

    <h2 class="rule-head">Частые вопросы</h2>
    ${faq}

    ${relatedHtml}

    <p class="colophon">Не нашли рейс на нужную дату? Разместите просьбу — это бесплатно и занимает минуту: <a href="/#/new">форма на сайте</a> или бот в Telegram.</p>`;

  return pageShell({ title, description, canonical: `${origin}/r/${r.slug}`, origin, body });
}

/** Каталог всех маршрутов /routes. */
export function buildRoutesIndexPage(origin: string): string {
  const groups = new Map<string, SeoRoute[]>();
  for (const r of SEO_ROUTES) {
    const key = CITY_COUNTRY[r.from]?.name && CITY_COUNTRY[r.to]?.name && CITY_COUNTRY[r.from]!.name !== CITY_COUNTRY[r.to]!.name
      ? `${CITY_COUNTRY[r.from]!.name} ↔ ${CITY_COUNTRY[r.to]!.name}`
      : 'Внутри страны';
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  const list = [...groups.entries()].map(([group, routes]) =>
    `<h2 class="rule-head">${escapeHtml(group)}</h2>
<p class="related">${routes.map((r) => `<a href="/r/${r.slug}">${escapeHtml(r.from)} → ${escapeHtml(r.to)}</a>`).join('')}</p>`
  ).join('\n');

  return pageShell({
    title: 'Популярные маршруты передачи посылок | попутка.',
    description: 'Все популярные направления передачи посылок попутно: Польша, Беларусь, Украина, Германия, Чехия и другие. Выберите маршрут и найдите водителя.',
    canonical: `${origin}/routes`,
    origin,
    body: `    <p class="doc-date">все направления</p>
    <h1 class="page-title">Популярные маршруты</h1>
    <p class="lead">Выберите направление — на странице маршрута собраны живые заявки водителей и просьбы передать посылку, а также подробности: что обычно везут, сколько это стоит и как не нарваться на мошенника.</p>
${list}
    <p class="colophon">Нет нужного маршрута? Откройте <a href="/#/">доску</a> и впишите города в поиск — заявки фильтруются по любому направлению.</p>`,
  });
}

/** Динамический sitemap: главная + страницы маршрутов + активные объявления. */
export async function buildSitemapXml(env: Env, origin: string): Promise<string> {
  const urls: string[] = [
    `  <url>\n    <loc>${origin}/</loc>\n    <changefreq>hourly</changefreq>\n    <priority>1.0</priority>\n  </url>`,
    ...SEO_ROUTES.map((r) =>
      `  <url>\n    <loc>${origin}/r/${r.slug}</loc>\n    <changefreq>daily</changefreq>\n    <priority>0.8</priority>\n  </url>`),
  ];
  try {
    const { items } = await listListings(env, { perPage: 200 });
    for (const l of items) {
      const lastmod = (l.publishedAt ?? l.createdAt).slice(0, 10);
      urls.push(`  <url>\n    <loc>${origin}/item/${encodeURIComponent(l.id)}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`);
    }
  } catch {
    // база недоступна — отдаём хотя бы статичные страницы
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
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

export { findRoute };
