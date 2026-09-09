import type { ParsedMessage } from './types';

/**
 * Локальный парсер сообщений из чатов Telegram.
 * Распознаёт: маршрут «Город — Город», дату, вес, цену, контакт
 * и определяет, что это: «водитель везёт» (offer) или «нужно передать» (request).
 *
 * Парсер — эвристический, без внешних сервисов. Работает полностью в Worker'е.
 */

/** Канонические названия городов и распространённые варианты написания. */
const CITY_FORMS: Record<string, string> = {
  // Польша
  'варшава': 'Варшава', 'варшав': 'Варшава',
  'краков': 'Краков', 'краковов': 'Краков',
  'гданськ': 'Гданьск', 'гданск': 'Гданьск', 'гданьск': 'Гданьск', 'данциг': 'Гданьск',
  'вроцлав': 'Вроцлав', 'вроцлавов': 'Вроцлав',
  'познань': 'Познань', 'познани': 'Познань',
  'лодзь': 'Лодзь', 'лодзи': 'Лодзь',
  'катовице': 'Катовице', 'катовицы': 'Катовице', 'катовиц': 'Катовице',
  'люблин': 'Люблин',
  'белосток': 'Белосток', 'билосток': 'Белосток', 'бялысток': 'Белосток',
  'щецин': 'Щецин', 'шчецин': 'Щецин',
  'быдгощ': 'Быдгощ', 'быдгощь': 'Быдгощ',
  'торунь': 'Торунь', 'торуні': 'Торунь',
  'ченстохова': 'Ченстохова', 'ченстохово': 'Ченстохова',
  'радом': 'Радом',
  'сосновец': 'Сосновец', 'сосновєц': 'Сосновец',
  'гдыня': 'Гдыня', 'гдиня': 'Гдыня',
  'ольштын': 'Ольштын',
  'жешув': 'Жешув', 'ржешув': 'Жешув',
  'зелена-гура': 'Зелёна-Гура',
  'ополе': 'Ополе',
  'бельско-бяла': 'Бельско-Бяла',
  'кельце': 'Кельце',
  'гливице': 'Гливице', 'гливицы': 'Гливице',
  'забже': 'Забже',
  'бытом': 'Бытом',
  'тыхы': 'Тыхы',
  'плоцк': 'Плоцк',
  'эльблонг': 'Эльблонг',
  'валбжих': 'Валбжих',
  'влоцлавек': 'Влоцлавек',
  'тарнув': 'Тарнув',
  'кошалин': 'Кошалин',
  'калиш': 'Калиш',
  'легинца': 'Легница', 'легница': 'Легница',
  'грудзёндз': 'Грудзёндз', 'грудзендз': 'Грудзёндз',
  'слупск': 'Слупск',
  'хожув': 'Хожув',

  // Украина
  'киев': 'Киев', 'київ': 'Киев',
  'львов': 'Львов', 'льві': 'Львов',
  'харьков': 'Харьков', 'харків': 'Харьков',
  'одесса': 'Одесса', 'одеса': 'Одесса',
  'днепр': 'Днепр', 'дніпро': 'Днепр', 'днепропетровск': 'Днепр',
  'запорожье': 'Запорожье', 'запоріжжя': 'Запорожье',
  'винница': 'Винница', 'вінниця': 'Винница',
  'полтава': 'Полтава',
  'чернигов': 'Чернигов', 'чернігів': 'Чернигов',
  'сумы': 'Сумы',
  'ивано-франковск': 'Ивано-Франковск', 'івано-франківськ': 'Ивано-Франковск',
  'луцк': 'Луцк', 'луцьк': 'Луцк',
  'ровно': 'Ровно', 'рівне': 'Ровно',
  'тернополь': 'Тернополь', 'тернопіль': 'Тернополь',
  'хмельницкий': 'Хмельницкий', 'хмельницький': 'Хмельницкий',
  'черновцы': 'Черновцы', 'чернівці': 'Черновцы',
  'ужгород': 'Ужгород',
  'мукачево': 'Мукачево', 'мукачеве': 'Мукачево',
  'николаев': 'Николаев', 'миколаїв': 'Николаев',
  'херсон': 'Херсон',
  'кривой рог': 'Кривой Рог', 'кривий ріг': 'Кривой Рог',
  'мариуполь': 'Мариуполь', 'маріуполь': 'Мариуполь',

  // Европа и СНГ
  'берлин': 'Берлин', 'берлін': 'Берлин',
  'мюнхен': 'Мюнхен',
  'гамбург': 'Гамбург',
  'франкфурт': 'Франкфурт',
  'ганновер': 'Ганновер',
  'дрезден': 'Дрезден', 'дрездн': 'Дрезден',
  'кёльн': 'Кёльн', 'кельн': 'Кёльн',
  'вена': 'Вена', 'віден': 'Вена',
  'прага': 'Прага',
  'братислава': 'Братислава',
  'будапешт': 'Будапешт',
  'амстердам': 'Амстердам',
  'брюссель': 'Брюссель',
  'париж': 'Париж',
  'лондон': 'Лондон',
  'милан': 'Милан',
  'рим': 'Рим',
  'мадрид': 'Мадрид',
  'барселона': 'Барселона',
  'вильнюс': 'Вильнюс',
  'каунас': 'Каунас',
  'клайпеда': 'Клайпеда', 'клaйпеда': 'Клайпеда',
  'рига': 'Рига',
  'таллин': 'Таллин', 'таллинн': 'Таллин',
  'минск': 'Минск', 'мінск': 'Минск',
  'калининград': 'Калининград', 'кенигсберг': 'Калининград',
  'москва': 'Москва',
  'санкт-петербург': 'Санкт-Петербург', 'питер': 'Санкт-Петербург',
  'петербург': 'Санкт-Петербург',

  // Часто встречающиеся неправильные/краткие формы
  'варашава': 'Варшава',
  'краковое': 'Краков',
  'вроцлавь': 'Вроцлав',

  // Латиницей — в чатах релокантов часто пишут локальными именами
  // Польша
  'warszawa': 'Варшава', 'warsaw': 'Варшава',
  'krakow': 'Краков', 'kraków': 'Краков',
  'wroclaw': 'Вроцлав', 'wrocław': 'Вроцлав',
  'gdansk': 'Гданьск', 'gdańsk': 'Гданьск',
  'poznan': 'Познань', 'poznań': 'Познань',
  'lodz': 'Лодзь', 'łódź': 'Лодзь',
  'katowice': 'Катовице', 'lublin': 'Люблин',
  'bialystok': 'Белосток', 'szczecin': 'Щецин',
  'bydgoszcz': 'Быдгощ', 'torun': 'Торунь', 'toruń': 'Торунь',
  'olsztyn': 'Ольштын', 'rzeszow': 'Жешув',
  'czestochowa': 'Ченстохова', 'gdynia': 'Гдыня',
  'sosnowiec': 'Сосновец', 'gliwice': 'Гливице',
  // Украина
  'kyiv': 'Киев', 'kiev': 'Киев',
  'lviv': 'Львов', 'lvov': 'Львов',
  'kharkiv': 'Харьков', 'kharkov': 'Харьков',
  'odessa': 'Одесса', 'odesa': 'Одесса',
  'dnipro': 'Днепр', 'zaporizhzhia': 'Запорожье',
  'zhytomyr': 'Житомир', 'vinnytsia': 'Винница',
  'ivano-frankivsk': 'Ивано-Франковск', 'ternopil': 'Тернополь',
  'chernivtsi': 'Черновцы', 'uzhhorod': 'Ужгород', 'uzhorod': 'Ужгород',
  'rivne': 'Ровно', 'lutsk': 'Луцк',
  'khmelnytskyi': 'Хмельницкий', 'mykolaiv': 'Николаев',
  'kherson': 'Херсон', 'poltava': 'Полтава',
  'cherkasy': 'Черкассы', 'chernihiv': 'Чернигов', 'sumy': 'Сумы',
  'mukachevo': 'Мукачево',
  // Европа
  'berlin': 'Берлин', 'munich': 'Мюнхен', 'munchen': 'Мюнхен',
  'hamburg': 'Гамбург', 'frankfurt': 'Франкфурт',
  'hannover': 'Ганновер', 'dresden': 'Дрезден',
  'koln': 'Кёльн', 'köln': 'Кёльн', 'bremen': 'Бремен',
  'stuttgart': 'Штутгарт', 'dusseldorf': 'Дюссельдорф',
  'dortmund': 'Дортмунд', 'leipzig': 'Лейпциг',
  'wien': 'Вена', 'prague': 'Прага', 'praha': 'Прага', 'brno': 'Брно',
  'bratislava': 'Братислава', 'budapest': 'Будапешт',
  'vilnius': 'Вильнюс', 'kaunas': 'Каунас', 'klaipeda': 'Клайпеда',
  'riga': 'Рига', 'tallinn': 'Таллин',
  'amsterdam': 'Амстердам', 'brussels': 'Брюссель',
  'paris': 'Париж', 'london': 'Лондон',
  'milan': 'Милан', 'milano': 'Милан', 'rome': 'Рим', 'roma': 'Рим',
  'madrid': 'Мадрид', 'barcelona': 'Барселона',
};

const CITY_KEYS = Object.keys(CITY_FORMS).sort((a, b) => b.length - a.length);

const OFFER_HINTS = [
  /возьму/i, /могу взять/i, /взять посылк/i, /могу передать/i, /везу/i,
  /везём/i, /везем/i, /везёт/i, /везет/i, /перевезу/i, /доставлю/i, /заберу/i,
  /попутк/i, /попутно/i, /есть место/i, /место есть/i, /свободн\w* мест\w*/i, /доставк/i,
  /перевозк/i, /перевоз/i, /груз/i, /погрузк/i, /загруж\w+\s*(?:сам|машину)/i,
  /выезжаю/i, /выезд\w*/i, /рейс/i, /маршрут/i, /бронь/i, /бронир/i,
  /могу забрать/i, /отвожу/i, /заряд/i,
  /еду/i, /поеду/i, /беру/i, /отвез/i,
];

const REQUEST_HINTS = [
  /нужно передать/i, /надо передать/i, /нужн\w* (?:передать|отправить|забрать)/i,
  /ищу/i, /кто (?:может|возьм[её]т|перевез[её]т|привез[её]т|едет|поедет|летит|везет|везёт)/i,
  /может кто/i, /кто-нибудь/i, /помогите/i, /помож[её]т/i, /переслать/i,
  /передать посылк/i, /посылк\w* (?:передать|доставить)/i, /привезти/i,
  /подвезти/i, /нужн\w* (?:водитель|курьер)/i, /ищ[уе] (?:водителя|курьера|попутку)/i,
  /кто передаёт/i, /кто передает/i, /осталось передать/i, /помощь с передачей/i,
  /передайте/i, /прошу/i, /необходим\w*\s*(?:передать|отправить|забрать)/i,
];

const WEEKDAYS: Record<string, number> = {
  'понедельник': 1, 'вторник': 2, 'среда': 3, 'среду': 3, 'четверг': 4,
  'пятница': 5, 'пятницу': 5, 'суббота': 6, 'субботу': 6, 'воскресенье': 0, 'воскресенья': 0,
};

/** Названия месяцев (рус./укр.) по префиксу: «15 сентября», «5 жовтня». */
const MONTHS: Array<[string, number]> = [
  ['январ', 1], ['феврал', 2], ['март', 3], ['апрел', 4], ['ма[йея]', 5],
  ['июн', 6], ['июл', 7], ['август', 8], ['сентябр', 9], ['октябр', 10],
  ['ноябр', 11], ['декабр', 12],
  ['січен', 1], ['лют', 2], ['березн', 3], ['квітн', 4], ['травн', 5],
  ['черв', 6], ['лип', 7], ['серп', 8], ['вересн', 9], ['жовтн', 10],
  ['листопад', 11], ['грудн', 12],
];

function normalize(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9\- ]/gi, ' ').replace(/\s+/g, ' ').trim();
}

/** Ищет упоминания всех известных городов, возвращает позиции. */
const CYRILLIC = 'а-яёa-z';

/**
 * Ищет города с учётом русских окончаний («в Варшаве», «до Кракова»).
 * После ключа допускается ровно одна буква-окончание.
 */
function findCities(text: string): Array<{ city: string; index: number; end: number }> {
  const found: Array<{ city: string; index: number; end: number }> = [];
  const lower = text.toLowerCase().replace(/ё/g, 'е');
  for (const key of CITY_KEYS) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![${CYRILLIC}0-9])${escaped}[${CYRILLIC}]?(?![${CYRILLIC}0-9])`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower)) !== null) {
      found.push({ city: CITY_FORMS[key]!, index: m.index, end: m.index + key.length });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

const SEPARATORS = /^(?:\s*(?:->|=>|>>|→|⇒|—|–|−|-|до|в|на|из|с|от)\s*(?:[а-яёa-z]{0,12}\s*)?)$/;

/** Извлекает маршрут «Город A — Город B» из текста. */
function extractRoute(text: string): { from: string; to: string } | null {
  const cities = findCities(text);
  // Небольшой запас: если между городами есть "->" / "—" / "до" / "в" и т.п., это маршрут.
  for (let i = 0; i < cities.length; i++) {
    for (let j = i + 1; j < cities.length; j++) {
      const a = cities[i]!;
      const b = cities[j]!;
      // Пропускаем дубли на одной позиции (сокращённая форма + полная форма)
      if (b.index < a.end) continue;
      if (a.city === b.city) continue;
      const between = text.slice(a.end, b.index);
      if (between.length > 40) continue;
      const clean = between.trim();
      if (clean === '' || SEPARATORS.test(clean)) {
        return { from: a.city, to: b.city };
      }
    }
  }
  return null;
}

/** Преобразует «завтра», день недели или «15.09» в YYYY-MM-DD. */
function hasWord(text: string, word: string): boolean {
  return new RegExp(`(^|[^${CYRILLIC}0-9])${word}([^${CYRILLIC}0-9]|$)`).test(text);
}

export function parseDate(text: string, now: Date = new Date()): string | null {
  const lower = text.toLowerCase().replace(/ё/g, 'е');
  if (hasWord(lower, 'послезавтра')) return toIso(addDays(now, 2));
  if (hasWord(lower, 'завтра')) return toIso(addDays(now, 1));
  if (hasWord(lower, 'сегодня')) return toIso(now);

  for (const [name, weekday] of Object.entries(WEEKDAYS)) {
    // \b в JS не работает с кириллицей — используем явные границы
    const re = new RegExp(`(^|[^${CYRILLIC}0-9])${name}([^${CYRILLIC}0-9]|$)`);
    if (re.test(lower)) {
      const d = new Date(now);
      const diff = (weekday! - d.getDay() + 7) % 7 || 7; // следующий такой день
      d.setDate(d.getDate() + diff);
      return toIso(d);
    }
  }

  const m = lower.match(/(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/);
  if (m) {
    const day = parseInt(m[1]!, 10);
    const month = parseInt(m[2]!, 10);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      let year = m[3] ? parseInt(m[3]!, 10) : now.getFullYear();
      if (year < 100) year += 2000;
      const candidate = new Date(year, month - 1, day);
      if (candidate.getDate() === day && candidate.getMonth() === month - 1) {
        // Если дата без года уже прошла — предполагаем следующий год (актуально для анонсов).
        if (!m[3] && candidate < startOfDay(now)) candidate.setFullYear(candidate.getFullYear() + 1);
        return toIso(candidate);
      }
    }
  }

  // «15 сентября», «5 жовтня» — число + название месяца
  for (const [prefix, month] of MONTHS) {
    const re = new RegExp(`(\\d{1,2})[^\\dа-яё]{0,3}${prefix}`);
    const mm = lower.match(re);
    if (mm) {
      const day = parseInt(mm[1]!, 10);
      if (day >= 1 && day <= 31) {
        const candidate = new Date(now.getFullYear(), month - 1, day);
        if (candidate.getDate() === day) {
          if (candidate < startOfDay(now)) candidate.setFullYear(candidate.getFullYear() + 1);
          return toIso(candidate);
        }
      }
    }
  }
  return null;
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function extractWeight(text: string): number | null {
  const m = text.match(/(?:до\s*)?(\d{1,3}(?:[.,]\d{1,2})?)\s*(?:кг|kg|кило|килограмм)/i);
  if (!m) return null;
  const value = parseFloat(m[1]!.replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0 || value > 1000) return null;
  return Math.round(value * 100) / 100;
}

function extractPrice(text: string): string | null {
  const m = text.match(/(\d{1,3}(?:\s?\d{3})*(?:[.,]\d{1,2})?)\s*(зл|злот|zl|zł|pln|евро|eur|€|\$|грн|грив|uah|руб|₽|р\.)/i);
  if (!m) return null;
  const number = m[1]!.trim();
  const currency = m[2]!.trim().toUpperCase();
  const label =
    currency === 'ЗЛ' || currency === 'ZŁ' || currency === 'ZL' || currency === 'PLN' ? 'zł'
    : currency === 'ЕВРО' || currency === 'EUR' || currency === '€' ? '€'
    : currency === '$' ? '$'
    : currency === 'ГРН' || currency === 'ГРИВ' || currency === 'UAH' ? 'грн'
    : currency === 'РУБ' || currency === 'RUB' || currency === '₽' || currency === 'Р.' ? '₽'
    : '';
  return `${number} ${label}`.trim();
}

function extractPhone(text: string): string | null {
  const m = text.match(/\+?[\d][\d\s\-()]{8,17}[\d]/);
  if (!m) return null;
  const digits = m[0].replace(/[^\d+]/g, '');
  if (digits.replace(/\D/g, '').length < 9 || digits.replace(/\D/g, '').length > 16) return null;
  return m[0].trim();
}

function extractTelegram(text: string): string | null {
  const m = text.match(/(?:t\.me\/|https?:\/\/t\.me\/|@)([a-zA-Z0-9_]{4,32})/);
  return m ? `@${m[1]!}` : null;
}

function detectIntent(text: string): 'offer' | 'request' | null {
  let offerScore = 0;
  let requestScore = 0;
  for (const re of OFFER_HINTS) if (re.test(text)) offerScore++;
  for (const re of REQUEST_HINTS) if (re.test(text)) requestScore++;
  if (offerScore === requestScore) {
    if (offerScore === 0) return null;
    return /передать/i.test(text) ? 'request' : 'offer';
  }
  return offerScore > requestScore ? 'offer' : 'request';
}

/** Главная точка входа: разбор текста сообщения из чата. now передаётся в тестах. */
export function parseTelegramMessage(text: string, now: Date = new Date()): ParsedMessage {
  const route = extractRoute(text);
  const intent = detectIntent(text) ?? (route ? 'offer' : null);
  return {
    intent,
    fromCity: route?.from ?? null,
    toCity: route?.to ?? null,
    departureDate: parseDate(text, now),
    weightKg: extractWeight(text),
    price: extractPrice(text),
    telegram: extractTelegram(text),
    phone: extractPhone(text),
    confidence: route && intent ? 0.9 : route ? 0.7 : intent ? 0.5 : 0,
  };
}

/** Должен ли бот вообще реагировать на сообщение (нет маршрута и нет явных подсказок — игнор). */
export function looksLikeListing(text: string, now: Date = new Date()): boolean {
  const p = parseTelegramMessage(text, now);
  return p.intent !== null && (p.fromCity !== null || p.toCity !== null);
}

export { extractRoute };
