/**
 * Подбор пар: «водитель везёт» (offer) ↔ «нужно передать» (request).
 *
 * Зачем: на доске лежат встречные по смыслу заявки — водитель едет
 * Варшава → Минск 25.09, а человеку нужно передать посылку Варшава → Минск 26.09.
 * Сами они друг друга не находят. Админ нажимает кнопку во вкладке «подбор»,
 * сервер сравнивает заявки (по маршруту, датам, весу, контактам), сохраняет
 * прогон в историю и присылает сводку в Telegram — дальше админ пишет людям.
 *
 * Всё детерминированно: без ИИ и внешних вызовов, поэтому прогон бесплатный
 * и повторяемый. Чистые функции (scorePair, pairListings) тестируются юнитами.
 */
import type { Env, Listing } from './types';
import { normalizeCity } from './parser';
import { escapeHtml, mskTodayIso, uniqueContacts } from './util';

export interface MatchFilters {
  /** Фильтр по городу: берём заявки, у которых город встречается в маршруте. */
  fromCity?: string | null;
  toCity?: string | null;
  /** Окно по дате, дней (по умолчанию 3). */
  days?: number;
  /** Учитывать архивные заявки (expired и с прошедшей датой). */
  includeArchive?: boolean;
  /** Считать пары, где совпал только один город маршрута. */
  partial?: boolean;
  /** Порог оценки (по умолчанию 30). */
  minScore?: number;
  /** Максимум пар в ответе (по умолчанию 50). */
  limit?: number;
}

export interface MatchPair {
  offer: Listing;
  request: Listing;
  score: number;
  reasons: string[];
}

export interface MatchStats {
  offers: number;
  requests: number;
  pairs: number;
  rejected: {
    route: number;
    date_gap: number;
    weight: number;
    same_contact: number;
    archived: number;
  };
}

export type RejectReason = keyof MatchStats['rejected'];

export interface PairVerdict {
  score: number;
  reasons: string[];
  reject: RejectReason | null;
}

/** Города сравниваем после нормализации: «минске» = «Минск» = «Minsk». */
function cityKey(s: string | null | undefined): string {
  if (!s) return '';
  return normalizeCity(s).toLowerCase().replace(/ё/g, 'е').trim();
}

function cityEq(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = cityKey(a);
  const kb = cityKey(b);
  return Boolean(ka) && ka === kb;
}

/** Заявка касается города (с любой стороны маршрута). Пустой фильтр — подходит всё. */
export function listingTouchesCity(l: Listing, city: string | null | undefined): boolean {
  if (!city || !city.trim()) return true;
  const key = cityKey(city);
  return cityKey(l.fromCity) === key || cityKey(l.toCity) === key;
}

/** Заявка уже не актуальна: архивный статус или дата выезда прошла. */
export function isArchivedListing(l: Listing, today: string = mskTodayIso()): boolean {
  return l.status === 'expired' || Boolean(l.departureDate && l.departureDate < today);
}

/** Контакты одного и того же человека (номер с точностью до цифр, юзернейм — до регистра). */
function contactKey(l: Listing): string | null {
  const [first] = uniqueContacts(l.telegram, l.phone);
  if (!first) return null;
  const digits = first.replace(/\D/g, '');
  return digits.length >= 9 ? `tel:${digits}` : `tg:${first.toLowerCase()}`;
}

function daysBetween(a: string, b: string): number | null {
  const ta = new Date(`${a}T00:00:00Z`).getTime();
  const tb = new Date(`${b}T00:00:00Z`).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round(Math.abs(ta - tb) / 86400_000);
}

/**
 * Оценка одной пары «водитель ↔ заявка на передачу».
 *
 * Логика: посылка едет туда, куда едет водитель, поэтому рабочий маршрут —
 * ТОТ ЖЕ (Варшава → Минск у обоих), а не встречный. Встречный рейс пару не даёт.
 * Дальше дата (чем ближе, тем лучше), вес (посылка должна влезать) и контакты
 * (без контакта с одной стороны пара бесполезна).
 */
export function scorePair(
  offer: Listing,
  request: Listing,
  opts: { days?: number; partial?: boolean } = {}
): PairVerdict {
  const days = opts.days ?? 3;
  const reasons: string[] = [];
  let score = 0;

  // Один человек не должен «находить» сам себя: обе заявки от одного контакта — не пара
  const offerContact = contactKey(offer);
  const requestContact = contactKey(request);
  if (offerContact && offerContact === requestContact) {
    return { score: 0, reasons: ['один и тот же контакт у обеих заявок'], reject: 'same_contact' };
  }

  // Маршрут
  const sameFrom = cityEq(offer.fromCity, request.fromCity);
  const sameTo = cityEq(offer.toCity, request.toCity);
  if (sameFrom && sameTo) {
    score += 60;
    reasons.push(`маршрут совпадает: ${offer.fromCity} → ${offer.toCity}`);
  } else if (sameFrom || sameTo) {
    if (!opts.partial) {
      return {
        score: 0,
        reasons: [`совпал только один город (${sameFrom ? offer.fromCity : offer.toCity})`],
        reject: 'route',
      };
    }
    score += 25;
    reasons.push(sameFrom
      ? `совпадает город отправления (${offer.fromCity}), назначение разное`
      : `совпадает город назначения (${offer.toCity}), отправление разное`);
  } else {
    return { score: 0, reasons: ['маршруты не совпадают'], reject: 'route' };
  }

  // Дата выезда
  if (offer.departureDate && request.departureDate) {
    const diff = daysBetween(offer.departureDate, request.departureDate);
    if (diff == null) {
      score += 5;
      reasons.push('дату не удалось сравнить');
    } else if (diff > days) {
      return {
        score: 0,
        reasons: [`даты расходятся на ${diff} дн. (окно ${days})`],
        reject: 'date_gap',
      };
    } else if (diff === 0) {
      score += 30;
      reasons.push('выезд в один день');
    } else {
      score += Math.max(10, 25 - 5 * (diff - 1));
      reasons.push(`даты рядом: разница ${diff} дн.`);
    }
  } else {
    score += 5;
    reasons.push('дата не у всех указана — договориться');
  }

  // Вес: посылка должна влезать в то, что водитель готов взять
  if (offer.weightKg != null && request.weightKg != null) {
    if (request.weightKg > offer.weightKg) {
      return {
        score: 0,
        reasons: [`посылка ${request.weightKg} кг тяжелее, чем берёт водитель (${offer.weightKg} кг)`],
        reject: 'weight',
      };
    }
    score += 5;
    reasons.push(`вес подходит (${request.weightKg} кг из ${offer.weightKg} кг)`);
  }

  // Контакты: пара полезна, только если есть кому писать
  const offerContacts = uniqueContacts(offer.telegram, offer.phone).length;
  const requestContacts = uniqueContacts(request.telegram, request.phone).length;
  if (offerContacts && requestContacts) {
    score += 5;
    reasons.push('контакт есть у обоих');
  } else if (!offerContacts || !requestContacts) {
    score -= 10;
    reasons.push(!offerContacts && !requestContacts
      ? 'ни у кого нет контакта — нужно уточнить'
      : `${!offerContacts ? 'у водителя' : 'у автора заявки'} нет контакта`);
  }

  return { score, reasons, reject: null };
}

/** Отсеять заявки, которые не участвуют в подборе (архив, не те города). */
export function selectCandidates(
  listings: Listing[],
  filters: MatchFilters,
  today: string = mskTodayIso()
): { offers: Listing[]; requests: Listing[]; archived: number } {
  const fromCity = filters.fromCity ?? null;
  const toCity = filters.toCity ?? null;
  const offers: Listing[] = [];
  const requests: Listing[] = [];
  let archived = 0;

  for (const l of listings) {
    if (!listingTouchesCity(l, fromCity) || !listingTouchesCity(l, toCity)) continue;
    if (isArchivedListing(l, today) && !filters.includeArchive) { archived++; continue; }
    if (l.type === 'offer') offers.push(l);
    else if (l.type === 'request') requests.push(l);
  }
  return { offers, requests, archived };
}

/**
 * Подбор: все пары «водитель ↔ нужно передать» по списку заявок.
 * Отсортированы по убыванию оценки, затем по ближайшей дате выезда.
 */
export function pairListings(
  listings: Listing[],
  filters: MatchFilters = {},
  today: string = mskTodayIso()
): { pairs: MatchPair[]; stats: MatchStats } {
  const minScore = filters.minScore ?? 30;
  const limit = filters.limit ?? 50;
  const days = filters.days ?? 3;
  const { offers, requests, archived } = selectCandidates(listings, filters, today);

  const rejected: MatchStats['rejected'] = { route: 0, date_gap: 0, weight: 0, same_contact: 0, archived };
  const pairs: MatchPair[] = [];

  for (const offer of offers) {
    for (const request of requests) {
      const verdict = scorePair(offer, request, { days, partial: filters.partial });
      if (verdict.reject) {
        rejected[verdict.reject]++;
        continue;
      }
      if (verdict.score < minScore) continue;
      pairs.push({ offer, request, score: verdict.score, reasons: verdict.reasons });
    }
  }

  pairs.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const da = a.offer.departureDate ?? '9999-12-31';
    const db = b.offer.departureDate ?? '9999-12-31';
    if (da !== db) return da < db ? -1 : 1;
    return (b.offer.createdAt ?? '').localeCompare(a.offer.createdAt ?? '');
  });

  const limited = pairs.slice(0, limit);
  return {
    pairs: limited,
    stats: { offers: offers.length, requests: requests.length, pairs: limited.length, rejected },
  };
}

/* ------------------------------------------------------------------ */
/* История прогонов: снимки заявок (сами заявки кроном удаляются)        */
/* ------------------------------------------------------------------ */

export interface ListingSnapshot {
  id: string;
  type: 'offer' | 'request';
  fromCity: string;
  toCity: string;
  departureDate: string | null;
  /** «каждый четверг» — регулярный рейс (показ в сводке /подбор). */
  recurring?: string | null;
  weightKg: number | null;
  price: string | null;
  contacts: string[];
  description: string;
  status: string;
  sourceChat: string | null;
  createdAt: string;
}

/** Снимок заявки для истории: заявка удалится кроном, а пара останется читаемой. */
export function listingSnapshot(l: Listing): ListingSnapshot {
  return {
    id: l.id,
    type: l.type,
    fromCity: l.fromCity,
    toCity: l.toCity,
    departureDate: l.departureDate ?? null,
    recurring: l.recurring ?? null,
    weightKg: l.weightKg ?? null,
    price: l.price ?? null,
    contacts: uniqueContacts(l.telegram, l.phone),
    description: (l.description ?? '').slice(0, 160),
    status: l.status,
    sourceChat: l.sourceChat ?? null,
    createdAt: l.createdAt,
  };
}

export function parseSnapshot(raw: string | null): ListingSnapshot | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as ListingSnapshot;
    return typeof v?.id === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** Короткая строка пары — для сводки в Telegram и списка в админке. */
export function pairLine(
  pair: { offer: ListingSnapshot | Listing; request: ListingSnapshot | Listing; score: number },
  opts: { dayFmt?: (iso: string | null) => string } = {}
): string {
  const day = opts.dayFmt ?? ((iso: string | null) => iso ?? 'без даты');
  const side = (l: ListingSnapshot | Listing): string => {
    const contacts = 'contacts' in l ? (l as ListingSnapshot).contacts : uniqueContacts(l.telegram, l.phone);
    const weight = l.weightKg != null ? ` · до ${String(l.weightKg).replace('.', ',')} кг` : '';
    return `${l.fromCity} → ${l.toCity} · ${day(l.departureDate ?? null)}${weight} · ${contacts[0] ?? 'нет контакта'} · № ${l.id.slice(0, 8)}`;
  };
  return `🚗 ${side(pair.offer)}\n📦 ${side(pair.request)}\n   оценка ${pair.score}`;
}

/** Сводка прогона для админов в Telegram (HTML, как остальные сообщения бота). */
export function formatMatchDigest(opts: {
  fromCity: string | null;
  toCity: string | null;
  days: number;
  pairs: MatchPair[];
  stats: MatchStats;
  siteUrl?: string | null;
  maxPairs?: number;
}): string {
  const max = opts.maxPairs ?? 10;
  const where = opts.fromCity || opts.toCity
    ? [opts.fromCity, opts.toCity].filter(Boolean).join(' — ')
    : 'все города';
  const head = `🧩 <b>Подбор пар:</b> ${escapeHtml(where)} · окно ${opts.days} дн.\n` +
    `Просмотрено: водителей ${opts.stats.offers}, заявок ${opts.stats.requests}. ` +
    `Пар: <b>${opts.stats.pairs}</b>.`;
  if (opts.pairs.length === 0) {
    return `${head}\n\nПар не нашлось: маршруты не совпадают, даты расходятся больше чем на ${opts.days} дн. или заявки уже в архиве.`;
  }
  const site = (opts.siteUrl ?? '').replace(/\/+$/, '');
  const day = (iso: string | null): string => (iso ? iso.slice(8, 10) + '.' + iso.slice(5, 7) : 'без даты');
  const lines = opts.pairs.slice(0, max).map((p, i) => {
    const contacts = (l: Listing) => uniqueContacts(l.telegram, l.phone)[0] ?? 'нет контакта';
    const links = site
      ? `\n   <a href="${site}/item/${p.offer.id}">водитель</a> · <a href="${site}/item/${p.request.id}">заявка</a>`
      : '';
    return `${i + 1}. 🚗 ${escapeHtml(p.offer.fromCity)} → ${escapeHtml(p.offer.toCity)}, ${day(p.offer.departureDate ?? null)}, ${escapeHtml(contacts(p.offer))}\n` +
      `   📦 ${escapeHtml(p.request.fromCity)} → ${escapeHtml(p.request.toCity)}, ${day(p.request.departureDate ?? null)}, ${escapeHtml(contacts(p.request))}\n` +
      `   ${escapeHtml(p.reasons[0] ?? '')} · оценка ${p.score}${links}`;
  });
  const more = opts.pairs.length > max ? `\n…и ещё ${opts.pairs.length - max} — во вкладке «подбор».` : '';
  return `${head}\n\n${lines.join('\n\n')}${more}`;
}

/* ---------- скрытые контакты подбора ---------- */

/** Ключ контакта-строки для скрытия в подборе: юзернейм — нормализованный
 *  без @, телефон — последние 9 цифр. Один и тот же человек, записанный
 *  по-разному (@Ivan, ivan, t.me/ivan), даёт один ключ.
 *  (Приватная contactKey выше работает с Listing и ключами дедупликации.) */
export function contactKeyOf(c: string): string | null {
  const s = String(c ?? '').trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 9) return `ph:${digits.slice(-9)}`;
  const uname = s.replace(/^@/, '').replace(/^t\.me\//i, '').toLowerCase();
  return uname ? `tg:${uname}` : null;
}

/** Ключи контактов одной стороны пары: снимок пары хранит contacts[],
 *  живая заявка — telegram/phone. */
export function sideContactKeys(side: {
  contacts?: string[] | null;
  telegram?: string | null;
  phone?: string | null;
}): string[] {
  const list = Array.isArray(side.contacts) && side.contacts.length > 0
    ? side.contacts.map(String)
    : uniqueContacts(side.telegram ?? null, side.phone ?? null);
  return Array.from(new Set(list.map(contactKeyOf).filter((k): k is string => !!k)));
}

/** Убрать пары со скрытыми контактами: скрыли юзернейм — из подбора уходит
 *  каждая пара, где он водитель или заявка. Сами заявки не трогаем. */
export function filterHiddenPairs<T extends { offer: unknown; request: unknown }>(
  pairs: T[],
  hidden: Set<string>
): { pairs: T[]; hiddenCount: number } {
  if (hidden.size === 0) return { pairs, hiddenCount: 0 };
  const kept: T[] = [];
  let hiddenCount = 0;
  for (const p of pairs) {
    const offer = p.offer as Parameters<typeof sideContactKeys>[0] | null;
    const request = p.request as Parameters<typeof sideContactKeys>[0] | null;
    const keys = [...(offer ? sideContactKeys(offer) : []), ...(request ? sideContactKeys(request) : [])];
    if (keys.some((k) => hidden.has(k))) hiddenCount += 1;
    else kept.push(p);
  }
  return { pairs: kept, hiddenCount };
}

export interface HiddenContact { key: string; label: string }

const HIDDEN_CONTACTS_KV = 'match:hidden-contacts';

export async function loadHiddenContacts(env: Env): Promise<HiddenContact[]> {
  const raw = await env.KV.get(HIDDEN_CONTACTS_KV).catch(() => null);
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as HiddenContact[];
    return Array.isArray(v) ? v.filter((x) => x && typeof x.key === 'string') : [];
  } catch {
    return [];
  }
}

export async function setHiddenContacts(env: Env, list: HiddenContact[]): Promise<void> {
  await env.KV.put(HIDDEN_CONTACTS_KV, JSON.stringify(list.slice(0, 200)));
}
