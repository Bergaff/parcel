/**
 * Защита от дублей: одно и то же объявление, пересланное несколько раз.
 *
 * Боль: водитель каждый день пишет «20 сентября еду Варшава — Минск, возьму
 * посылку», админ это пересылает боту и одобряет — на доске пять одинаковых
 * заявок. Отметка «уже обрабатывал» (tg_seen) тут не помогает: каждый день
 * это новое сообщение с новым id.
 *
 * Поэтому сравниваем не id сообщения, а смысл: тот же тип + тот же маршрут +
 * та же дата (±1 день) + признак «это тот же человек» — совпал контакт,
 * совпал автор пересылки или почти совпал текст. Такой набор сигналов
 * даёт 'duplicate' (новую заявку не создаём, существующую освежаем),
 * а совпадение маршрута и даты при слабом признаке — 'similar'
 * (создаём, но предупреждаем модератора: вдруг это правда другой человек).
 *
 * Всё чистые функции — сравнивать текст и контакты тестируется юнитами.
 */
import { normalizeCity } from './parser';
import { uniqueContacts } from './util';

/** Заявка или черновик заявки: всё, что нужно для сравнения. */
export interface DedupeSubject {
  id?: string;
  type: 'offer' | 'request';
  fromCity: string;
  toCity: string;
  departureDate?: string | null;
  /** «каждый четверг» — регулярный рейс; дата может катиться вперёд. */
  recurring?: string | null;
  weightKg?: number | null;
  telegram?: string | null;
  phone?: string | null;
  description: string;
  status?: string;
  sourceChat?: string | null;
  sourceChatId?: string | null;
  createdAt?: string;
  publishedAt?: string | null;
}

export type DuplicateKind = 'duplicate' | 'similar';

export interface DuplicateHit<T extends DedupeSubject> {
  listing: T;
  kind: DuplicateKind;
  why: string;
}

/** Текст почти тот же — не создаём вторую заявку. */
export const DUPLICATE_TEXT_SIMILARITY = 0.8;
/** Текст похож, но не совпадает: создаём, но показываем модератору. */
export const SIMILAR_TEXT_SIMILARITY = 0.55;

/* ------------------------------------------------------------------ */
/* Сравнение городов, дат, контактов                                    */
/* ------------------------------------------------------------------ */

function cityKey(s: string | null | undefined): string {
  if (!s) return '';
  return normalizeCity(s).toLowerCase().replace(/ё/g, 'е').trim();
}

export function sameRoute(a: DedupeSubject, b: DedupeSubject): boolean {
  return Boolean(cityKey(a.fromCity))
    && cityKey(a.fromCity) === cityKey(b.fromCity)
    && cityKey(a.toCity) === cityKey(b.toCity);
}

/** Разница в днях; null — если дата не указана хотя бы у одной из заявок. */
export function dateDiffDays(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const ta = new Date(`${a}T00:00:00Z`).getTime();
  const tb = new Date(`${b}T00:00:00Z`).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round(Math.abs(ta - tb) / 86400_000);
}

function digits(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '');
}

/** Телефоны считаем одинаковыми по последним 9 цифрам: +375 29 …, 37529…, 8029… */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = digits(a);
  const db = digits(b);
  if (da.length < 9 || db.length < 9) return false;
  const tailA = da.slice(-9);
  const tailB = db.slice(-9);
  return da === db || tailA === tailB;
}

/** Юзернеймы — без @ и регистра. */
export function sameUsername(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = (a ?? '').trim().toLowerCase().replace(/^@+/, '');
  const nb = (b ?? '').trim().toLowerCase().replace(/^@+/, '');
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Номер, попавший в поле telegram, не должен делать «разные» контакты
  return digits(na).length >= 9 && samePhone(na, nb);
}

/** Контакт один и тот же? false — если хотя бы у одной стороны контакта нет. */
export function sameContact(a: DedupeSubject, b: DedupeSubject): boolean {
  if (sameUsername(a.telegram, b.telegram)) return true;
  if (samePhone(a.phone, b.phone)) return true;
  // Контакты нормализуются при сохранении, но сравниваем и крест-накрест:
  // тот же номер мог попасть в другое поле
  if (samePhone(a.telegram, b.phone) || samePhone(a.phone, b.telegram)) return true;
  return false;
}

/** Оба контакта известны и они разные — значит, люди разные. */
export function differentContacts(a: DedupeSubject, b: DedupeSubject): boolean {
  const hasA = uniqueContacts(a.telegram ?? null, a.phone ?? null).length > 0;
  const hasB = uniqueContacts(b.telegram ?? null, b.phone ?? null).length > 0;
  return hasA && hasB && !sameContact(a, b);
}

/** Как назвать человека в объяснении: @username, телефон или «без контакта». */
export function whoLabel(l: DedupeSubject): string {
  const [contact] = uniqueContacts(l.telegram ?? null, l.phone ?? null);
  if (contact) return contact;
  if (l.sourceChat) return l.sourceChat;
  return 'без контакта';
}

/* ------------------------------------------------------------------ */
/* Сравнение текста                                                     */
/* ------------------------------------------------------------------ */

const STOPWORDS = new Set([
  'и', 'в', 'во', 'не', 'что', 'на', 'я', 'с', 'со', 'как', 'а', 'то', 'все', 'она', 'так',
  'его', 'но', 'да', 'ты', 'к', 'у', 'же', 'вы', 'за', 'бы', 'по', 'только', 'её', 'ее',
  'мне', 'вот', 'от', 'меня', 'ещё', 'еще', 'нет', 'о', 'из', 'ему', 'теперь', 'когда',
  'даже', 'ну', 'вдруг', 'ли', 'если', 'уже', 'или', 'ни', 'быть', 'был', 'до', 'вас',
  'опять', 'уж', 'вам', 'ведь', 'потом', 'себя', 'ничего', 'ей', 'может', 'они', 'тут',
  'где', 'есть', 'надо', 'ней', 'для', 'мы', 'тебя', 'их', 'чем', 'была', 'сам', 'чтоб',
  'без', 'будто', 'раз', 'тоже', 'под', 'будет', 'ж', 'тогда', 'кто', 'этот', 'того',
  'потому', 'совсем', 'ним', 'здесь', 'этом', 'один', 'почти', 'мой', 'тем', 'чтобы',
  'нее', 'сейчас', 'были', 'куда', 'зачем', 'всех', 'никогда', 'сегодня', 'можно',
  'при', 'наконец', 'два', 'об', 'другой', 'после', 'над', 'больше', 'тот', 'через',
  'эти', 'нас', 'про', 'всего', 'них', 'много', 'три', 'эту', 'моя', 'хорошо', 'свою',
  'этой', 'перед', 'иногда', 'лучше', 'чуть', 'том', 'нельзя', 'такой', 'им', 'более',
  'всегда', 'конечно', 'всю', 'между', 'это', 'могу', 'можем', 'нужно', 'нужен', 'очень',
  'кто-то', 'что-то', 'там', 'сюда', 'туда', 'ваш', 'наш', 'свой', 'этих', 'тех',
]);

/** Слова к сравнению: строчные, без знаков препинания, первые 5 букв
 *  («варшавы» и «варшава», «посылку» и «посылки» становятся одним словом). */
export function compareTokens(raw: string | null | undefined): Set<string> {
  const words = (raw ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && !STOPWORDS.has(w))
    .map((w) => w.slice(0, 5));
  return new Set(words);
}

/** Похожесть двух текстов: коэффициент Дайса по словам (0…1). */
export function textSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const ta = compareTokens(a);
  const tb = compareTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return (2 * shared) / (ta.size + tb.size);
}

/* ------------------------------------------------------------------ */
/* Вердикет                                                             */
/* ------------------------------------------------------------------ */

/** Автор пересылки: «Переслано от sergei» — это имя человека, а не название чата. */
function forwardedFrom(l: DedupeSubject): string | null {
  const m = /^Переслано от (.+)$/i.exec((l.sourceChat ?? '').trim());
  return m ? m[1]!.trim().toLowerCase() : null;
}

function dateNote(a: DedupeSubject, b: DedupeSubject): string {
  if (!a.departureDate || !b.departureDate) return 'дата не у всех указана';
  const diff = dateDiffDays(a.departureDate, b.departureDate);
  if (!diff) return `дата та же (${a.departureDate})`;
  return `дата рядом (${a.departureDate} и ${b.departureDate})`;
}

/**
 * Сравнить новую заявку с уже существующей.
 *
 * Обязательное основание — тот же тип, тот же маршрут и дата в пределах дня:
 * без этого сравнивать нечего (разные рейсы). Дальше ищем признак
 * «это тот же человек»: контакт, автор пересылки или почти тот же текст.
 */
export function compareForDuplicate(
  input: DedupeSubject,
  existing: DedupeSubject
): { kind: DuplicateKind; why: string } | null {
  if (input.type !== existing.type) return null;
  if (!sameRoute(input, existing)) return null;

  // Оба рейса регулярные («каждый четверг»): дата — ближайший заезд, она
  // катится cron'ом и у новой пересылки может быть другой. Один и тот же
  // человек на том же маршруте с расписанием — это одна заявка, не две.
  const bothRecurring = Boolean(input.recurring) && Boolean(existing.recurring);

  const diff = dateDiffDays(input.departureDate, existing.departureDate);
  if (diff != null && diff > 1 && !bothRecurring) return null; // другой день — другой рейс

  const route = `${existing.fromCity} → ${existing.toCity}`;
  const sim = textSimilarity(input.description, existing.description);

  // 1. Тот же контакт — самый надёжный признак
  if (sameContact(input, existing)) {
    return {
      kind: 'duplicate',
      why: `тот же человек (${whoLabel(existing)}), тот же маршрут ${route}, ${bothRecurring ? `оба рейса регулярные (${existing.recurring})` : dateNote(input, existing)}`,
    };
  }

  // Контакты известны у обоих и они разные — значит, люди разные: дальше
  // «дубль» уже не ставим, только предупреждаем модератора.
  const different = differentContacts(input, existing);

  // 2. Та же пересылка от того же автора (контакта Telegram не отдал)
  const fromA = forwardedFrom(input);
  const fromB = forwardedFrom(existing);
  if (fromA && fromA === fromB) {
    return different
      ? {
          kind: 'similar',
          why: `пересылка от того же автора (${fromA}), но контакт другой (${whoLabel(existing)}) — проверьте`,
        }
      : {
          kind: 'duplicate',
          why: `та же пересылка от ${fromA}, маршрут ${route}, ${dateNote(input, existing)}`,
        };
  }

  // 3. Почти тот же текст (скопированное сообщение, повторная пересылка)
  if (sim >= DUPLICATE_TEXT_SIMILARITY) {
    return different
      ? {
          kind: 'similar',
          why: `текст почти тот же (совпадение ${Math.round(sim * 100)}%), но контакт другой (${whoLabel(existing)}) — возможно, копия чужого объявления`,
        }
      : {
          kind: 'duplicate',
          why: `тот же текст объявления (совпадение ${Math.round(sim * 100)}%), маршрут ${route}, ${dateNote(input, existing)}`,
        };
  }

  // 4. Слабые признаки: заявку создаём, но модератора предупреждаем.
  //    Контакты у обоих известны и разные — это точно разные люди, молчим:
  //    на один рейс бывает несколько водителей, это не дубль.
  if (different) return null;

  // Одного маршрута и даты мало. Нужен ещё признак: текст похож или источник тот же
  // (один и тот же человек пересылает объявление, профиль которого скрыт).
  const sameSource = Boolean(input.sourceChatId) && input.sourceChatId === existing.sourceChatId;
  if (sim >= SIMILAR_TEXT_SIMILARITY) {
    return {
      kind: 'similar',
      why: `похоже на уже имеющуюся заявку (${whoLabel(existing)}, текст совпадает на ${Math.round(sim * 100)}%) — проверьте, не один ли это человек`,
    };
  }
  if (sameSource) {
    return {
      kind: 'similar',
      why: `тот же источник, маршрут ${route}, ${dateNote(input, existing)} — проверьте, не один ли это человек`,
    };
  }
  return null;
}

/**
 * Выбрать лучшего кандидата из списка: сначала уверенные дубликаты
 * (свежие раньше), затем «похожие».
 */
export function pickDuplicate<T extends DedupeSubject>(
  candidates: T[],
  input: DedupeSubject
): DuplicateHit<T> | null {
  const hits: Array<DuplicateHit<T>> = [];
  for (const c of candidates) {
    if (c.id && input.id && c.id === input.id) continue; // себя дублем не считаем
    const verdict = compareForDuplicate(input, c);
    if (verdict) hits.push({ listing: c, ...verdict });
  }
  if (hits.length === 0) return null;
  const rank = (h: DuplicateHit<T>): number => (h.kind === 'duplicate' ? 0 : 1);
  const statusRank = (h: DuplicateHit<T>): number => (h.listing.status === 'published' ? 0 : 1);
  // sort() устойчив: кандидаты приходят из базы уже отсортированными от новых к старым
  hits.sort((a, b) => (rank(a) - rank(b)) || (statusRank(a) - statusRank(b)));
  return hits[0]!;
}

/* ------------------------------------------------------------------ */
/* Разбор уже накопившихся дублей                                       */
/* ------------------------------------------------------------------ */

/** Группа одинаковых заявок: какую оставить и какие удалить. */
export interface DuplicateGroup<T extends DedupeSubject> {
  keep: T;
  duplicates: T[];
  why: string;
}

/**
 * Какую заявку оставить: сначала та, что на доске (не в очереди и не в архиве),
 * затем та, у которой есть контакт (по ней людям писать), затем самая свежая.
 */
export function keepRank(l: DedupeSubject): number[] {
  const status = l.status === 'published' ? 0 : l.status === 'pending' ? 1 : 2;
  const contact = uniqueContacts(l.telegram ?? null, l.phone ?? null).length > 0 ? 0 : 1;
  const when = new Date(l.publishedAt || l.createdAt || 0).getTime() || 0;
  return [status, contact, -when];
}

function betterToKeep<T extends DedupeSubject>(a: T, b: T): T {
  const ra = keepRank(a);
  const rb = keepRank(b);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i]! !== rb[i]!) return ra[i]! < rb[i]! ? a : b;
  }
  return a;
}

/**
 * Разложить список заявок на группы дублей — чтобы разобрать завалы, которые
 * накопились до появления защиты (одно и то же объявление одобряли каждый день).
 *
 * В группу попадают только уверенные совпадения ('duplicate'): тот же человек
 * и тот же рейс. «Похожие» (kind === 'similar') не группируем — там люди разные,
 * решать должен модератор.
 */
export function groupDuplicates<T extends DedupeSubject>(listings: T[]): Array<DuplicateGroup<T>> {
  const parent = listings.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const union = (i: number, j: number): void => {
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[b] = a;
  };

  const whyByRoot = new Map<number, string>();
  for (let i = 0; i < listings.length; i++) {
    for (let j = i + 1; j < listings.length; j++) {
      const v = compareForDuplicate(listings[i]!, listings[j]!);
      if (!v || v.kind !== 'duplicate') continue;
      union(i, j);
      const root = find(i);
      if (!whyByRoot.has(root)) whyByRoot.set(root, v.why);
    }
  }

  const buckets = new Map<number, T[]>();
  listings.forEach((l, i) => {
    const root = find(i);
    const bucket = buckets.get(root);
    if (bucket) bucket.push(l);
    else buckets.set(root, [l]);
  });

  const groups: Array<DuplicateGroup<T>> = [];
  for (const [root, bucket] of buckets) {
    if (bucket.length < 2) continue;
    let keep = bucket[0]!;
    for (const item of bucket.slice(1)) keep = betterToKeep(keep, item);
    const duplicates = bucket.filter((l) => l !== keep);
    // удалить сначала самые старые копии — свежая остаётся на доске
    duplicates.sort((a, b) => keepRank(a)[2]! - keepRank(b)[2]!);
    const other = duplicates[0]!;
    groups.push({
      keep,
      duplicates,
      why: whyByRoot.get(root)
        ?? compareForDuplicate(keep, other)?.why
        ?? 'тот же человек и тот же рейс',
    });
  }
  groups.sort((a, b) => b.duplicates.length - a.duplicates.length);
  return groups;
}
