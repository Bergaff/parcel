/**
 * Автопубликация заявок от администратора.
 *
 * Зачем: через радар и пересылки приходит порядка трёхсот заявок в день, и
 * каждая ждёт ручного «Одобрить». Заявку от админского аккаунта (ADMIN_IDS)
 * уже посмотрел сам админ — он её переслал или relay-аккаунт принёс копию по
 * его настройке, — поэтому публикуем такие сразу. Но не все: правило владельца
 * «если сомневается — не публиковать, я сам посмотрю». Сомнение системы — это
 * конкретный, названный человеку признак (ниже), а не «что-то не то»: заявка
 * остаётся в очереди модерации, а в карточке написано, почему её не
 * опубликовали автоматически.
 *
 * Что НЕ считается сомнением (решение владельца от 2026-09-19):
 *  - «похожая» заявка — серое предупреждение в очереди, kind='similar'
 *    («пересылка от того же автора, но контакт другой», «текст почти тот же»):
 *    принимаем БЕЗ замены старой. Люди бывают разные, старая заявка остаётся
 *    жить, новая публикуется рядом;
 *  - точный дубль — красное предупреждение, kind='duplicate' — до автопубликации
 *    не доходит вовсе: новую заявку не создаём (см. createListingSafe), живую
 *    освежаем наверху доски;
 *  - нет даты выезда или короткое описание: обычное дело («ищу, кто едет
 *    Минск-Варшава, передам документы») — не повод задерживать.
 *
 * Публикация здесь — та же, что при ручном «Одобрить»: заявка попадает на доску,
 * уходит в «комнату» направления форум-канала и наблюдателям (см. notifyCreated).
 */
import type { Env, ListingInput } from './types';
import { hasContactHint, uniqueContacts } from './util';

/** Что именно не понравилось. `code` — для тестов и статистики, `note` — текст
 *  для карточки модератору (пишется по-человечески, без канцелярита). */
export interface Doubt {
  code:
    | 'ai_parsed'
    | 'city_garbage'
    | 'same_city'
    | 'date_bad'
    | 'date_past'
    | 'date_far'
    | 'contact_in_text';
  note: string;
}

/** Дальше этого горизонта дата выезда бессмысленна: cron уносит такие заявки
 *  в архив (archiveFarDepartures, 90 дней) — публиковать нечего. */
const FAR_DAYS = 90;

/** Короткие подписи признаков сомнения — для статистики в админке
 *  («итоги» → блок «Автоодобрение»), где длинные формулировки не влезают
 *  в таблицу. Единственный источник подписей: смысл тот же, что в карточке
 *  модератора («🤔 Автоматически не опубликовано: …»). */
export const DOUBT_LABELS: Record<Doubt['code'], string> = {
  ai_parsed: 'разбирал ИИ',
  city_garbage: 'город не похож на название',
  same_city: 'откуда и куда — один город',
  date_bad: 'дату не разобрать',
  date_past: 'дата выезда прошла',
  date_far: 'выезд дальше 90 дней',
  contact_in_text: 'контакт в тексте, не в поле',
};

/** Подпись признака для человека; незнакомый код показываем как есть. */
export function doubtLabel(code: string): string {
  return DOUBT_LABELS[code as Doubt['code']] ?? code;
}

/** Заявка или черновик заявки — всё, что нужно для проверки. Listing расширяет
 *  ListingInput, поэтому подходит и то и другое. */
export type AutoPublishSubject = Pick<ListingInput,
  | 'type' | 'fromCity' | 'toCity' | 'departureDate' | 'recurring'
  | 'description' | 'telegram' | 'phone' | 'source' | 'status' | 'byAdmin'>;

/**
 * Включена ли автопубликация. По умолчанию включена: настраивать ничего не
 * нужно (владелец просил не заставлять его заводить отдельные секреты).
 * AUTO_PUBLISH_ADMIN=0 — рубильник «выключить всё» без деплоя: переменная
 * окружения применяется сразу, полезно, если на доску полезет мусор.
 * AUTO_APPROVE=1 — прежний общий режим «публиковать всё подряд», он сильнее.
 */
export function autoPublishEnabled(env: Env): boolean {
  return env.AUTO_PUBLISH_ADMIN !== '0';
}

/**
 * Похоже ли значение на название города. Словарь CITY_GEO знает 69 городов,
 * а на доске их бывало 248, поэтому «не знаю такого города» сомнением НЕ
 * считается: иначе половина настоящих заявок осталась бы в очереди. Ловим
 * мусор, из которого сайт построил бы страницу-пустышку (а мусорные URL жгут
 * крауловый бюджет — это видно в отчёте Search Console).
 */
export function looksLikeCityName(raw: string | null | undefined): boolean {
  const s = String(raw ?? '').trim();
  if (s.length < 2 || s.length > 40) return false;
  if (/\d/.test(s)) return false;                            // «Брест 20.11», «дом 5»
  if (/[\/\\@#*_|~`<>{}[\]$^+=]/.test(s)) return false;       // ссылки и разметка
  if (/\s{2,}/.test(s)) return false;                         // склейка двух строк
  const letters = s.replace(/[^\p{L}]/gu, '');
  if (letters.length < 2) return false;                       // «-», «...», «Б»
  // «Ростов-на-Дону», «Франкфурт на Майне» — нормально; предложение — нет
  if (s.split(/[\s-]+/).filter(Boolean).length > 4) return false;
  return true;
}

/** Дата в формате YYYY-MM-DD и реально существующая (не 31 февраля). */
export function isValidDate(raw: string | null | undefined): boolean {
  const s = String(raw ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const p = s.split('-');
  const y = Number(p[0] ?? 0);
  const m = Number(p[1] ?? 0);
  const d = Number(p[2] ?? 0);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** День в ISO (YYYY-MM-DD) — тот же формат, что хранится в departure_date. */
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Дата выезда: существует, не прошла и не дальше горизонта архивации.
 *  Нет даты — не сомнение: регулярные рейсы и «ищу, кто едет» живут без даты. */
function dateDoubt(input: AutoPublishSubject, now: Date): Doubt | null {
  const raw = (input.departureDate ?? '').trim();
  if (!raw) return null;
  if (!isValidDate(raw)) {
    return { code: 'date_bad', note: `дата выезда «${raw}» не похожа на настоящую` };
  }
  const today = isoDay(now);
  if (raw < today) {
    return { code: 'date_past', note: `дата выезда (${raw}) уже прошла — поездка не актуальна` };
  }
  // Регулярный рейс cron катит вперёд, а в архив по дальности он не уходит —
  // далёкая дата у него законная.
  if (!input.recurring && raw > isoDay(new Date(now.getTime() + FAR_DAYS * 86_400_000))) {
    return {
      code: 'date_far',
      note: `выезд дальше ${FAR_DAYS} дней (${raw}) — cron сразу унесёт такую заявку в архив`,
    };
  }
  return null;
}

/**
 * Признаки сомнения в заявке. Пустой список — публиковать можно.
 * Проверяем только то, что видно в самой заявке: разбор (кем собрано),
 * города, дату и контакт.
 */
export function doubtsFor(input: AutoPublishSubject, now: Date = new Date()): Doubt[] {
  const doubts: Doubt[] = [];

  // source='parser' ставит cascade(), когда правила не были уверены (confidence
  // < 0.7 или несколько маршрутов в одном сообщении) и поля собрала модель.
  // Это и есть «система сомневается» её собственными словами.
  if (input.source === 'parser') {
    doubts.push({ code: 'ai_parsed', note: 'сообщение разбирал ИИ — правила разбора не были уверены' });
  }

  const from = String(input.fromCity ?? '').trim();
  const to = String(input.toCity ?? '').trim();
  if (!looksLikeCityName(from)) {
    doubts.push({ code: 'city_garbage', note: `«${from || '—'}» не похоже на город отправления` });
  }
  if (!looksLikeCityName(to)) {
    doubts.push({ code: 'city_garbage', note: `«${to || '—'}» не похоже на город назначения` });
  }
  if (from && to && from.toLowerCase() === to.toLowerCase()) {
    doubts.push({ code: 'same_city', note: `откуда и куда — один и тот же город (${from})` });
  }

  const date = dateDoubt(input, now);
  if (date) doubts.push(date);

  // Контакт в поле — заявка самодостаточна. Контакт, написанный в тексте,
  // работает для читателя, но карточка показывает его отдельной строкой:
  // перенести его в поле — работа модератора, поэтому не публикуем сами.
  if (uniqueContacts(input.telegram, input.phone).length === 0 && hasContactHint(input.description)) {
    doubts.push({ code: 'contact_in_text', note: 'контакт написан в тексте, а не в поле — его нужно перенести' });
  }

  return doubts;
}

/** Вердикт: публиковать ли заявку автоматически и почему нет. */
export interface AutoPublishVerdict {
  publish: boolean;
  doubts: Doubt[];
}

/**
 * Публиковать ли заявку без модератора.
 * Условия: автопубликация не выключена рубильником, заявку подал админ
 * (byAdmin — личка админа, его пересылки, копии радара) и она ещё не решена
 * другим правилом (статус 'pending': при AUTO_APPROVE=1 она уже published,
 * а заявку без контакта отклоняет autoStatusFor — до автопубликации дело
 * не доходит).
 */
export function autoPublishVerdict(
  env: Env,
  input: AutoPublishSubject,
  now: Date = new Date()
): AutoPublishVerdict {
  if (!autoPublishEnabled(env)) return { publish: false, doubts: [] };
  if (!input.byAdmin) return { publish: false, doubts: [] };
  if (input.status !== 'pending') return { publish: false, doubts: [] };
  const doubts = doubtsFor(input, now);
  return { publish: doubts.length === 0, doubts };
}

/** Причины сомнения одной строкой — для карточки модератору. */
export function doubtNote(doubts: Doubt[]): string {
  return doubts.map((d) => d.note).join('; ');
}
