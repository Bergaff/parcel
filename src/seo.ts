/**
 * Общая SEO-мелочь: слаги городов и маршрутов, JSON-LD, блоки <head>.
 *
 * Нужно нескольким местам сразу: страницам маршрутов (/r/:slug), страницам
 * городов (/gorod/:slug), карточке объявления (/item/:id) и оболочке сайта
 * (src/ssr.ts) — поэтому живёт отдельным модулем, а не копипастой.
 */

export const SITE_NAME = 'попутка.';
export const SITE_ORIGIN_FALLBACK = 'https://pop-utka.app';

/* Транслитерация для ЧПУ. Специально подобрана так, чтобы совпадать со
   слагами, которые уже проиндексированы (varshava-lvov, kiev, harkov,
   vilnyus, parizh, koln…) — иначе получатся дубли страниц. */
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', ґ: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh',
  з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  є: 'ye', і: 'i', ї: 'i', apostrophe: '',
  a: 'a', b: 'b', c: 'c', d: 'd', e: 'e', f: 'f', g: 'g', h: 'h', i: 'i',
  j: 'j', k: 'k', l: 'l', m: 'm', n: 'n', o: 'o', p: 'p', q: 'q', r: 'r',
  s: 's', t: 't', u: 'u', v: 'v', w: 'w', x: 'x', y: 'y', z: 'z',
};

/** «Ивано-Франковск» → «ivano-frankovsk», «Санкт-Петербург» → «sankt-peterburg». */
export function translit(text: string): string {
  const lower = text.trim().toLowerCase().replace(/'/g, '');
  let out = '';
  for (const ch of lower) {
    if (TRANSLIT[ch] !== undefined) out += TRANSLIT[ch];
    else if (/[\s_·/\\,.]/.test(ch)) out += '-';
    else if (ch === '-' || ch === '—' || ch === '–') out += '-';
    // прочее (цифры оставляем, экзотику выбрасываем)
    else if (/[0-9]/.test(ch)) out += ch;
  }
  return out.replace(/-+/g, '-').replace(/^-|-$/g, '');
}

export function citySlug(city: string): string {
  return translit(city);
}

export function routeSlug(from: string, to: string): string {
  return `${citySlug(from)}-${citySlug(to)}`;
}

/**
 * JSON для вставки в <script>: экранируем «<», «>» и «&», чтобы содержимое
 * не могло закрыть тег или сломать парсер HTML.
 */
export function jsonForScript(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** Один блок <script type="application/ld+json">. */
export function jsonLd(data: unknown): string {
  return `<script type="application/ld+json">${jsonForScript(data)}</script>`;
}

/** Несколько блоков разметки одной строкой. */
export function jsonLdAll(blocks: Array<unknown | null | undefined>): string {
  return blocks.filter(Boolean).map((b) => jsonLd(b)).join('\n');
}

/* ------------------------- схемы schema.org ------------------------- */

export interface Crumb {
  name: string;
  /** относительный путь ('/r/varshava-minsk'); у последнего элемента пути нет */
  path?: string;
}

export function breadcrumbsLd(origin: string, trail: Crumb[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((c, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: c.name,
      ...(c.path ? { item: `${origin}${c.path}` } : {}),
    })),
  };
}

export function itemListLd(origin: string, name: string, items: Array<{ path: string; name: string }>): Record<string, unknown> | null {
  if (items.length === 0) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name,
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      url: `${origin}${it.path}`,
    })),
  };
}

export function faqPageLd(qa: Array<[string, string]>): Record<string, unknown> | null {
  if (qa.length === 0) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: qa.map(([q, a]) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  };
}

/** Название сайта + поиск: помогает поисковику связать домен с брендом. */
export function webSiteLd(origin: string): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE_NAME,
    alternateName: 'попутка — доска попутных передач',
    url: `${origin}/`,
    inLanguage: 'ru',
    publisher: { '@type': 'Organization', name: SITE_NAME, url: `${origin}/` },
  };
}

/**
 * Объявление как запись списка (не Product/Offer: выдумывать цену и наличие
 * нельзя, а за недостоверную разметку Google снимает страницы с индекса).
 */
export function listingLd(origin: string, l: {
  id: string; fromCity: string; toCity: string; description: string;
  departureDate?: string | null; createdAt: string; publishedAt?: string | null;
}): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'ListItem',
    name: `${l.fromCity} → ${l.toCity}`,
    url: `${origin}/item/${encodeURIComponent(l.id)}`,
    description: l.description.slice(0, 300),
    dateCreated: l.createdAt,
    ...(l.publishedAt ? { datePublished: l.publishedAt } : {}),
  };
}

/* --------------------------- блоки <head> --------------------------- */

export interface HeadMeta {
  title: string;
  description: string;
  /** абсолютный URL канонической страницы */
  canonical: string;
  origin: string;
  /** 'noindex,follow' — для архива, фильтров, админки */
  robots?: string;
  image?: string;
  imageAlt?: string;
  type?: 'website' | 'article';
}

/** OG + Twitter + robots + canonical одним блоком (без <title> и description). */
export function headMeta(m: HeadMeta): string {
  const image = m.image ?? `${m.origin}/og-cover.png?v=3`;
  const lines = [
    m.robots ? `<meta name="robots" content="${m.robots}" />` : null,
    `<link rel="canonical" href="${m.canonical}" />`,
    `<meta property="og:type" content="${m.type ?? 'website'}" />`,
    `<meta property="og:site_name" content="${SITE_NAME}" />`,
    `<meta property="og:locale" content="ru_RU" />`,
    `<meta property="og:title" content="${escapeAttr(m.title)}" />`,
    `<meta property="og:description" content="${escapeAttr(m.description)}" />`,
    `<meta property="og:url" content="${m.canonical}" />`,
    `<meta property="og:image" content="${image}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${escapeAttr(m.imageAlt ?? m.title)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escapeAttr(m.title)}" />`,
    `<meta name="twitter:description" content="${escapeAttr(m.description)}" />`,
    `<meta name="twitter:image" content="${image}" />`,
  ];
  return lines.filter(Boolean).join('\n  ');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
