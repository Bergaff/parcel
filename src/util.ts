import type { Env } from './types';

export function getIp(c: { req: { header: (name: string) => string | undefined } }): string {
  return (
    c.req.header('CF-Connecting-IP') ??
    c.req.header('X-Forwarded-For') ??
    'unknown'
  ).split(',')[0]!.trim();
}

/** Простой лимитер на KV: не более max запросов за окно windowSec. */
export async function rateLimit(
  env: Env,
  key: string,
  max: number,
  windowSec = 3600
): Promise<{ allowed: boolean; remaining: number }> {
  const bucket = Math.floor(Date.now() / (windowSec * 1000));
  const k = `rl:${key}:${bucket}`;
  const raw = await env.KV.get(k);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= max) return { allowed: false, remaining: 0 };
  await env.KV.put(k, String(count + 1), { expirationTtl: windowSec });
  return { allowed: true, remaining: max - count - 1 };
}

export function sanitizeText(s: unknown, maxLen: number, field = 'text'): string | null {
  if (typeof s !== 'string') return null;
  const clean = s.replace(/\s+/g, ' ').trim();
  if (clean.length === 0 || clean.length > maxLen) return null;
  return clean;
}

export function sanitizeCity(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const clean = s.replace(/[^А-ЯЁа-яёA-Za-z0-9\-\s,.]/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length < 1 || clean.length > 80) return null;
  return clean;
}

/** Название города — кириллицей: у нас русскоговорящая аудитория,
 *  и города в базе должны быть записаны единообразно (иначе поиск не найдёт). */
export function isRussianCity(s: string): boolean {
  return /^[А-Яа-яЁё][А-Яа-яЁё\s-]*$/.test(s.trim());
}

/** Сегодняшняя дата YYYY-MM-DD по Москве/Минску (UTC+3) —
 *  с ней сравнивается дата выезда заявки. */
export function mskTodayIso(): string {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

export function sanitizeContact(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const clean = s.trim();
  if (clean.length === 0 || clean.length > 64) return null;
  if (!/^(@[a-zA-Z0-9_]{4,32}|(?:https?:\/\/)?t\.me\/[a-zA-Z0-9_]{4,32}|\+?[\d][\d\s\-()]{8,16}[\d])$/.test(clean)) return null;
  return clean;
}

/* ------------------------------------------------------------------ */
/* Контакты: одно поле — один контакт, без дублей                       */
/* ------------------------------------------------------------------ */

const TG_USERNAME_RE = /(?:t\.me\/|@)([a-zA-Z0-9_]{4,32})/i;
const BARE_USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{3,31}$/;
const PHONE_RE = /\+?\d[\d\s\-()]{7,16}\d/;

export type ContactKind = 'telegram' | 'phone';

/** Что за строка: telegram-юзернейм, номер телефона или ни то ни другое. */
export function contactKind(raw: unknown): ContactKind | null {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) return null;
  if (TG_USERNAME_RE.test(v) || BARE_USERNAME_RE.test(v)) return 'telegram';
  const phone = v.match(PHONE_RE);
  if (phone) {
    const digits = phone[0].replace(/\D/g, '');
    if (digits.length >= 9 && digits.length <= 16) return 'phone';
  }
  return null;
}

/** Юзернейм Telegram из любой записи: «@user», «t.me/user», «user» → «@user». */
export function telegramUsername(raw: unknown): string | null {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) return null;
  const m = v.match(TG_USERNAME_RE);
  if (m) return `@${m[1]}`;
  if (BARE_USERNAME_RE.test(v)) return `@${v}`;
  return null;
}

/** Номер телефона из любой записи: «Vb+375256663703», «тел +48 579 264 254» → номер. */
export function phoneNumber(raw: unknown): string | null {
  const v = typeof raw === 'string' ? raw.trim() : '';
  if (!v) return null;
  const m = v.match(PHONE_RE);
  if (!m) return null;
  const digits = m[0].replace(/\D/g, '');
  if (digits.length < 9 || digits.length > 16) return null;
  return m[0].trim();
}

/**
 * Раскладывает контакты по своим полям и убирает дубли.
 *
 * Зачем: ИИ (да и люди в форме сайта) иногда кладут один и тот же номер и в
 * telegram, и в phone — тогда в карточке модератора «Контакты:» печатается
 * дважды, а на сайте строится несуществующая ссылка t.me/+48579264254.
 * Номер, попавший в поле telegram, переезжает в phone; юзернейм из phone — наоборот.
 */
export function normalizeContacts(
  telegram?: unknown,
  phone?: unknown
): { telegram: string | null; phone: string | null } {
  const usernames: string[] = [];
  const phones: string[] = [];
  for (const raw of [telegram, phone]) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const username = telegramUsername(raw);
    if (username) {
      usernames.push(username);
      continue;
    }
    const num = phoneNumber(raw);
    if (num) phones.push(num);
  }
  // Один и тот же контакт (с точностью до регистра/пробелов) держим один раз
  const tg = dedupeBy(usernames, (s) => s.toLowerCase())[0] ?? null;
  const ph = dedupeBy(phones, (s) => s.replace(/\D/g, ''))[0] ?? null;
  return { telegram: tg, phone: ph };
}

/** Контакты заявки для показа: без дублей, telegram первым. Пусто — контактов нет. */
export function uniqueContacts(
  telegram?: unknown,
  phone?: unknown
): string[] {
  const { telegram: tg, phone: ph } = normalizeContacts(telegram, phone);
  return [tg, ph].filter((v): v is string => Boolean(v));
}

function dedupeBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Описание: не повторять то, что уже есть в полях карточки             */
/* ------------------------------------------------------------------ */

/** Границы слов для кириллицы: \b в JS не работает с «а-я». */
const NB = String.raw`(?<![а-яёa-z0-9])`;
const NE = String.raw`(?![а-яёa-z0-9])`;

const MONTH_WORDS = String.raw`(?:январ|феврал|март|апрел|ма[йяе]|июн|июл|август|сентябр|октябр|ноябр|декабр|січен|лют|березн|квітн|травн|черв|лип|серп|вересн|жовтн|листопад|грудн)`;
const WEEKDAY_WORDS = String.raw`(?:понедельник|вторник|сред[ауы]|четверг|пятниц[ауы]|суббот[ауы]|воскресень[ея]| понеділок|вівторок|серед[ау]|четвер|п.?ятниц[яі]|субот[ау]|неділ[яі])`;

/** Токены, которые дублируют поля карточки: маршрут, дата, вес, цена, тип, контакты. */
function redundantTokenPatterns(ctx: DescriptionContext): RegExp[] {
  const res: RegExp[] = [];

  // Контакты вычёркиваем всегда: они показаны строкой «Контакты:»
  for (const contact of [ctx.telegram, ctx.phone]) {
    const value = typeof contact === 'string' ? contact.trim() : '';
    if (!value) continue;
    const digits = value.replace(/\D/g, '');
    if (digits.length >= 9) {
      // номер с любыми разделителями: «+48 579 264 254» = «+48579264254»
      const flex = digits.split('').join(String.raw`[\s\-()]*`);
      res.push(new RegExp(String.raw`(?<!\d)\+?${flex}(?!\d)`, 'g'));
    } else {
      const esc = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      res.push(new RegExp(String.raw`${NB}${esc}${NE}`, 'gi'));
    }
  }

  // Исходный текст сообщения (его не сочинял ИИ) показываем дословно:
  // маршрут, дату и вес из него не вычёркиваем — модератор сверяет разбор с оригиналом
  if (ctx.stripFields === false) return res;

  // Города маршрута (с окончаниями: «Варшаву», «Минска»)
  for (const city of [ctx.fromCity, ctx.toCity]) {
    if (!city) continue;
    for (const part of city.split(/[\s-]+/).filter((p) => p.length >= 3)) {
      const esc = part.toLowerCase().replace(/ё/g, 'е').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      res.push(new RegExp(`${NB}${esc}[а-яёa-z]{0,2}${NE}`, 'gi'));
    }
  }

  // Дата во всех записях: 25.09.2026, 2026-09-25, 25 сентября, завтра, в пятницу, 15:00
  res.push(
    new RegExp(String.raw`\d{4}-\d{1,2}-\d{1,2}`, 'g'),
    new RegExp(String.raw`${NB}\d{1,2}\s*[./-]\s*\d{1,2}\s*(?:[./-]\s*\d{2,4})?${NE}`, 'g'),
    new RegExp(String.raw`${NB}\d{1,2}\s*(?:числа|го)?\s*${MONTH_WORDS}\w*${NE}`, 'gi'),
    new RegExp(String.raw`${MONTH_WORDS}\w*`, 'gi'),
    new RegExp(String.raw`${NB}(?:сегодня|завтра|послезавтра|вчера|сьогодні|завтра)${NE}`, 'gi'),
    new RegExp(String.raw`${NB}(?:в\s+|на\s+|до\s+)?${WEEKDAY_WORDS}${NE}`, 'gi'),
    new RegExp(String.raw`${NB}\d{1,2}[:.]\d{2}${NE}`, 'g')
  );

  // Вес и цена — они в строке «Детали»
  res.push(
    new RegExp(String.raw`${NB}(?:до\s+)?\d{1,3}(?:[.,]\d{1,2})?\s*(?:кг|kg|кілограм\w*|килограмм\w*|кило|тонн\w*)${NE}`, 'gi'),
    new RegExp(String.raw`${NB}\d{1,3}(?:\s?\d{3})*(?:[.,]\d{1,2})?\s*(?:зл|злот\w*|zl|zł|pln|евро|eur|€|\$|грн|грив\w*|uah|руб|₽|р\.)${NE}`, 'gi')
  );

  // «Шапка» типа заявки: её показывает штамп «водитель везёт» / «ищу передачу»
  res.push(
    new RegExp(String.raw`${NB}водитель(?:ь|я|ю|ем|и)?\s*(?:вез[её]т|везу|везем|везём)?${NE}`, 'gi'),
    new RegExp(String.raw`${NB}(?:нужно|надо|нужн\w*)\s+передать${NE}`, 'gi'),
    new RegExp(String.raw`${NB}ищу\s+передач\w*${NE}`, 'gi')
  );

  // Стрелки и предлоги маршрута: «Варшава — Минск», «из Варшавы до Бреста»
  res.push(
    new RegExp(String.raw`->|=>|>>|→|⇒|—|–|−`, 'g'),
    new RegExp(String.raw`${NB}(?:до|в|во|на|из|с|со|от|к|-)${NE}`, 'gi')
  );

  return res;
}

export interface DescriptionContext {
  fromCity?: string | null;
  toCity?: string | null;
  departureDate?: string | null;
  type?: 'offer' | 'request' | null;
  /** Контакты, которые карточка показывает отдельной строкой. */
  telegram?: string | null;
  phone?: string | null;
  /**
   * false — вычёркивать только контакты и повторы, не трогая маршрут/дату/вес.
   * Так обрабатываем дословный текст сообщения (его не сочинял ИИ).
   */
  stripFields?: boolean;
}

function tidy(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/([,;:])\1+/g, '$1')
    .replace(/\s+([,;:.!?])/g, '$1')
    .replace(/[,;:]\s*([.!?])/g, '$1')
    .replace(/^[^\p{L}\d]+/u, '')
    .replace(/[,;:\s-]+$/u, '')
    .trim();
}

/** Букв в строке — «остаток смысла» после вычёркивания известных токенов. */
function lettersCount(s: string): number {
  return (s.match(/\p{L}/gu) ?? []).length;
}

function residualOf(chunk: string, patterns: RegExp[]): string {
  let residual = chunk;
  for (const re of patterns) residual = residual.replace(re, ' ');
  return residual;
}

/** Кусок между запятыми целиком состоит из того, что уже есть в полях карточки. */
function isRedundant(chunk: string, patterns: RegExp[]): boolean {
  return lettersCount(residualOf(chunk, patterns)) < 2;
}

/** После среза шапки («25.09 Варшава-Минск, возьму…») начинаем предложение с большой буквы. */
function capitalize(s: string): string {
  const trimmed = s.replace(/^[^\p{L}\d]+/u, '');
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * Срезает с краёв предложения куски, которые полностью дублируют поля карточки:
 * «25.09 Варшава-Минск, возьму посылки» → «Возьму посылки».
 * Середина предложения не трогается — осмысленный текст важнее чистоты.
 */
function stripRedundantEdges(sentence: string, patterns: RegExp[]): string {
  const parts = sentence.split(/([,;])/);
  let start = 0;
  while (start < parts.length) {
    const part = parts[start] ?? '';
    if (!part.trim() || part === ',' || part === ';') { start++; continue; }
    if (!isRedundant(part, patterns)) break;
    start += 2; // кусок + разделитель после него
  }
  let end = parts.length - 1;
  while (end >= start) {
    const part = parts[end] ?? '';
    if (!part.trim() || part === ',' || part === ';') { end--; continue; }
    if (!isRedundant(part, patterns)) break;
    end -= 2; // кусок + разделитель перед ним
  }
  const rest = tidy(parts.slice(Math.min(start, parts.length), end + 1).join(''));
  return rest && lettersCount(rest) >= 2 ? capitalize(rest) : sentence;
}

/**
 * Убирает из описания дубли информации:
 * 1) предложения и «шапки» предложений, полностью состоящие из того, что уже
 *    показано полями карточки (маршрут, дата, вес, цена, «Водитель», контакты);
 * 2) повторяющиеся предложения (копипаста одного и того же рейса);
 * 3) номера и юзернеймы, которые уже выведены в строке «Контакты:».
 *
 * Текст, который остался бессмысленным после чистки, не трогается:
 * если удалить удалось всё — возвращаем исходное описание.
 */
/** Текст без различий в регистре/пробелах — чтобы понять, изменила ли чистка что-то. */
function squash(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

/** Одно предложение описания: '' — если оно целиком дублирует поля карточки. */
function cleanSentence(
  rawSentence: string,
  patterns: RegExp[],
  ctx: DescriptionContext,
  seen: Set<string>
): string {
  const sentence = rawSentence.trim();
  if (!sentence) return '';

  const signature = squash(sentence).replace(/[^\p{L}\d]+/gu, '');
  if (!signature) return '';
  if (seen.has(signature)) return ''; // точный повтор предложения
  seen.add(signature);

  // Предложение целиком дублирует поля карточки — не показываем его второй раз
  if (lettersCount(residualOf(sentence, patterns)) < 3) return '';

  // Шапка/хвост предложения из маршрута, даты и веса — тоже дубль полей
  let trimmed = stripRedundantEdges(sentence, patterns);

  // Внутри осмысленного предложения вычёркиваем контакты
  for (const contact of [ctx.telegram, ctx.phone]) {
    const value = typeof contact === 'string' ? contact.trim() : '';
    if (!value) continue;
    const digits = value.replace(/\D/g, '');
    const re = digits.length >= 9
      ? new RegExp(String.raw`(?<!\d)\+?${digits.split('').join(String.raw`[\s\-()]*`)}(?!\d)`, 'g')
      : new RegExp(`${NB}${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${NE}`, 'gi');
    trimmed = trimmed.replace(re, ' ');
  }

  const piece = tidy(trimmed);
  // Конец предложения (. ! ?) сохраняем: без него текст слипается в кашу
  const endMark = sentence.match(/[.!?…]$/);
  return piece && endMark && !/[.!?…,;:]$/.test(piece) ? piece + endMark[0] : piece;
}

export function dedupeDescription(description: unknown, ctx: DescriptionContext = {}): string {
  if (typeof description !== 'string') return '';
  const original = description.trim();
  if (!original) return '';

  const patterns = redundantTokenPatterns(ctx);
  const seen = new Set<string>();
  const lines: string[] = [];

  // Переносы строк сообщения сохраняем: чистим по предложениям внутри каждой строки
  for (const rawLine of original.split(/\r?\n/)) {
    const line = rawLine.replace(/[ \t]+/g, ' ').trim();
    if (!line) continue;
    const pieces: string[] = [];
    for (const rawSentence of line.split(/(?<=[.!?…])\s+/)) {
      const piece = cleanSentence(rawSentence, patterns, ctx, seen);
      if (piece) pieces.push(piece);
    }
    const joined = tidy(pieces.join(' '));
    if (joined) lines.push(joined);
  }

  const result = lines.join('\n');
  // Нечего было чистить — возвращаем текст дословно (включая авторские переносы строк)
  if (squash(result) === squash(original)) return original;
  // Чистка съела всё описание — оставляем как было (лучше дубль, чем пустота)
  return lettersCount(result) >= 3 ? result : original;
}

export function normalizeTelegram(s: string): string {
  const m = s.match(/(?:t\.me\/|@)([a-zA-Z0-9_]{4,32})$/);
  return m ? `@${m[1]!}` : s;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

export function tgLink(username: string | null | undefined): string | null {
  if (!username) return null;
  const u = username.replace(/^@/, '');
  return `https://t.me/${u}`;
}

export function admins(env: Env): string[] {
  return (env.ADMIN_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
