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
  'кузница': 'Кузница', 'kuznica': 'Кузница', 'kuźnica': 'Кузница',
  'брузги': 'Брузги', 'bruzgi': 'Брузги', 'августов': 'Августов', 'augustow': 'Августов',
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
  'брест': 'Брест', 'гродно': 'Гродно', 'гомель': 'Гомель',
  'витебск': 'Витебск', 'могилев': 'Могилёв', 'могилёв': 'Могилёв',
  'бобруйск': 'Бобруйск', 'барановичи': 'Барановичи', 'пинск': 'Пинск',
  'житомир': 'Житомир', 'черкассы': 'Черкассы',
  'калининград': 'Калининград', 'кенигсберг': 'Калининград',
  'москва': 'Москва',
  'санкт-петербург': 'Санкт-Петербург', 'питер': 'Санкт-Петербург',
  'петербург': 'Санкт-Петербург',

  // Часто встречающиеся неправильные/краткие формы
  'варашава': 'Варшава',
  'краковое': 'Краков',
  'вроцлавь': 'Вроцлав',
  // частые латинские опечатки/транслитерации
  'warsawa': 'Варшава', 'warshawa': 'Варшава', 'warshava': 'Варшава',
  'krakov': 'Краков', 'krakiv': 'Краков',
  'lwow': 'Львов', 'lwów': 'Львов',

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

/**
 * Признаки намерения — двумя уровнями.
 *
 * Сильные (вес 2) говорят, КТО действует: автор едет и берёт посылку
 * («возьму», «везу», «есть место») либо автор ищет, кто передаст
 * («нужно передать», «кто-то занимается», «подскажите»).
 *
 * Слабые (вес 1) — просто тема перевозки: «перевоз», «доставка», «груз», «рейс»,
 * «попутка». Они встречаются и у водителей, и в просьбах, поэтому решение
 * по ним одним не принимается. Раньше «перевоз» перевешивал и просьба
 * «кто-то занимается перевозом посылок до 20 кг? варшава-брест?» получала
 * штамп «водитель везёт» — теперь такие сообщения уходят в «нужно передать».
 */
const OFFER_STRONG = [
  /возьму/i, /могу взять/i, /взять посылк/i, /могу передать/i, /могу забрать/i,
  /везу/i, /везём/i, /везем/i, /перевезу/i, /доставлю/i, /заберу/i, /отвезу/i, /повезу/i, /отвожу/i,
  /попутчик/i, /есть\s+мест\w*/i, /место есть/i, /мест\w*\s+свободн/i, /свободн\w* мест\w*/i,
  /погрузк/i, /загруж\w+\s*(?:сам|машину)/i, /выезжаю/i, /отправляю(?:сь|ю)\s+рейс/i,
  /еду/i, /поеду/i, /беру/i,
];

const OFFER_WEAK = [
  /везёт/i, /везет/i, /отвез/i, /попутк/i, /попутно/i, /доставк/i,
  /перевозк/i, /перевоз/i, /перевезти/i, /груз/i, /рейс/i, /маршрут/i,
  /бронь/i, /бронир/i, /выезд\w*/i, /заряд/i, /отвоз/i,
];

const REQUEST_STRONG = [
  /нужно передать/i, /надо передать/i, /нужн\w* (?:передать|отправить|забрать)/i,
  /необходим\w*\s*(?:передать|отправить|забрать)/i, /осталось передать/i,
  /ищу/i, /ищ[уе] (?:водителя|курьера|попутку)/i, /нужн\w* (?:водитель|курьер)/i,
  /кто[\s-]*(?:то|нибудь|либо)/i, /есть\s+кто/i, /может\s+кто/i, /кто-нибудь/i,
  /кто\s+(?:может|сможет|возьм[её]т|перевез[её]т|привез[её]т|едет|поедет|летит|вез[её]т|возит|занимает|помож[её]т|помогает|переда[её]т|отвез|подвез|довез|забер|доставит|отправит|приедет)/i,
  /(?:занимает|возит|возмёт|берет|берёт|доставляет|помогает)\s+(?:ли\s+)?кто/i,
  // «занимаетесь доставкой?» — вопрос чату (1-е лицо «занимаюсь перевозкой» — водитель)
  /занимает(?:есь|ся)\s+(?:ли\s+)?(?:перевоз\w*|доставк\w*|посылк\w*|передач\w*|груз\w*)/i,
  /(?:кто|куда|где)\s+(?:обратиться|писать|кидать)/i,
  /помогите/i, /помощь с передачей/i, /подскаж/i, /не\s+подскаж/i, /посоветуй/i,
  /передайте/i, /прошу/i, /хочу (?:передать|отправить|переслать)/i,
  /нужно (?:доставить|отправить|переслать)/i, /надо (?:доставить|отправить|переслать)/i,
];

const REQUEST_WEAK = [
  /передать посылк/i, /посылк\w* (?:передать|доставить)/i, /привезти/i,
  /подвезти/i, /переслать/i, /помож[её]т/i, /кто передаёт/i, /кто передает/i,
  /перевоз\w*\s+посылок/i, /доставк\w*\s+посылок/i,
];

/** Вес признака: сильный — 2, слабый (тематический) — 1. */
const STRONG_WEIGHT = 2;
const WEAK_WEIGHT = 1;

function scoreHints(text: string, strong: RegExp[], weak: RegExp[]): number {
  let score = 0;
  for (const re of strong) if (re.test(text)) score += STRONG_WEIGHT;
  for (const re of weak) if (re.test(text)) score += WEAK_WEIGHT;
  return score;
}

const WEEKDAYS: Record<string, number> = {
  'понедельник': 1, 'вторник': 2, 'среда': 3, 'среду': 3, 'четверг': 4,
  'пятница': 5, 'пятницу': 5, 'суббота': 6, 'субботу': 6, 'воскресенье': 0, 'воскресенья': 0,
};

/* ------------------------------------------------------------------ */
/* Регулярные рейсы: «каждый четверг», «по вторникам», «ежедневно»     */
/* ------------------------------------------------------------------ */

/** Канонические подписи дней: что показывать в карточке и на доске.
 *  Сокращения (пн, вт, чт…) — с явными границами: \b в JS не работает
 *  с кириллицей (см. WEEKDAYS выше). Текст приходит уже в нижнем регистре, ё→е. */
const WEEKDAY_LABELS: Array<[RegExp, string, number]> = [
  [/понедельни|(?:^|[^а-я\d])пн(?![а-я\d])/, 'понедельникам', 1],
  [/вторник|вторникам|(?:^|[^а-я\d])вт(?![а-я\d])/, 'вторникам', 2],
  [/сред[ауы]|средам|(?:^|[^а-я\d])ср(?![а-я\d])/, 'средам', 3],
  [/четверг|четвергам|(?:^|[^а-я\d])чт(?![а-я\d])/, 'четвергам', 4],
  [/пятниц|пятницам|(?:^|[^а-я\d])пт(?![а-я\d])/, 'пятницам', 5],
  [/суббот|субботам|(?:^|[^а-я\d])сб(?![а-я\d])/, 'субботам', 6],
  [/воскресень|(?:^|[^а-я\d])вс(?![а-я\d])/, 'воскресеньям', 0],
];

/** «каждый четверг» / «каждую пятницу» — согласуем «каждый» с днём. */
const WEEKDAY_EVERY: string[] = [
  'каждое воскресенье', 'каждый понедельник', 'каждый вторник',
  'каждую среду', 'каждый четверг', 'каждую пятницу', 'каждую субботу',
];

/**
 * Расписание регулярного рейса из текста сообщения: «каждый четверг»,
 * «по вторникам и пятницам», «ежедневно», «по будням», «раз в неделю».
 * Разовый рейс — null. Возвращает короткую каноническую подпись,
 * которую видно и в карточке Telegram, и на доске: сразу ясно,
 * что заявка не «на один раз», а возит постоянно.
 */
export function parseRecurring(text: string): string | null {
  const lower = text.toLowerCase().replace(/ё/g, 'е');
  // Пускаем дальше только тексты про повторяемость: «кажд…», «ежедн…»,
  // «по будням», «раз в неделю», «по пн/вт/чт…», «пн-пт», «сб-вс».
  // Остальное — разовый рейс.
  if (!/(кажд|ежедн|еженедел|по будням|раз в недел|по\s+(пн|вт|ср|чт|пт|сб|вс|понедел|вторник|сред|четверг|пятниц|суббот|воскрес)|(?:^|\s)(пн|вт|ср|чт|пт|сб|вс)\s*[-–—])/.test(lower)) {
    return null;
  }

  // Порядок важен: «пн-пт» — это будни, а не «понедельник и пятница»
  if (/ежедн|кажд[а-я]*\s*день(?![а-я])/.test(lower)) return 'ежедневно';
  if (/по будням|пн\s*[-–—]\s*пт/.test(lower)) return 'по будням';

  // «каждый четверг», «каждую пятницу», «по вторникам», «вт и чт», «сб-вс»
  const days: number[] = [];
  for (const [re, , weekday] of WEEKDAY_LABELS) {
    if (re.test(lower)) days.push(weekday);
  }
  if (days.length > 0) {
    days.sort((a, b) => a - b);
    if (days.length === 1) return WEEKDAY_EVERY[days[0]!]!;
    const labels = days.map((d) => WEEKDAY_LABELS.find(([, , w]) => w === d)![1]!);
    return `по ${labels.slice(0, -1).join(', ')} и ${labels[labels.length - 1]}`;
  }

  if (/кажд[а-я]*\s*недел|раз в недел|еженедел/.test(lower)) return 'раз в неделю';
  return null;
}

function utcIso(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Ближайшая будущая дата регулярного рейса: cron каждый день катит
 * departure_date вперёд, чтобы водитель «каждый четверг» не падал
 * в архив в пятницу утром. after — дата, СТРОГО после которой ищем.
 */
export function nextRecurringDate(recurring: string, after: string): string | null {
  const m = /^(20\d\d)-(\d\d)-(\d\d)$/.exec(after);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return null;
  const label = recurring.toLowerCase().replace(/ё/g, 'е');

  if (label === 'ежедневно') {
    d.setUTCDate(d.getUTCDate() + 1);
    return utcIso(d);
  }
  if (label === 'по будням') {
    for (let i = 1; i <= 7; i++) {
      const day = new Date(d);
      day.setUTCDate(day.getUTCDate() + i);
      const wd = day.getUTCDay();
      if (wd >= 1 && wd <= 5) return utcIso(day);
    }
    return null;
  }

  // Конкретные дни: «каждый четверг», «по вторникам и пятницам»
  const days: number[] = [];
  for (const [re, , weekday] of WEEKDAY_LABELS) {
    if (re.test(label)) days.push(weekday);
  }
  if (days.length > 0) {
    for (let i = 1; i <= 7; i++) {
      const day = new Date(d);
      day.setUTCDate(day.getUTCDate() + i);
      if (days.includes(day.getUTCDay())) return utcIso(day);
    }
    return null;
  }

  // «раз в неделю» и нераспознанное расписание — катим на неделю вперёд:
  // лучше живая регулярная заявка, чем упавшая в архив раньше времени
  d.setUTCDate(d.getUTCDate() + 7);
  return utcIso(d);
}

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
/** Найти в тексте знакомые города (в любом падеже), по порядку появления.
 *  Наружу нужна, например, команде /подбор: «Варшава Минск» → два города. */
export function findCities(text: string): Array<{ city: string; index: number; end: number }> {
  const found: Array<{ city: string; index: number; end: number }> = [];
  const lower = text.toLowerCase().replace(/ё/g, 'е');
  for (const key of CITY_KEYS) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![${CYRILLIC}0-9])${escaped}[${CYRILLIC}]?(?![${CYRILLIC}0-9])`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower)) !== null) {
      // end — конец найденного слова вместе с окончанием («Бреста», «Варшавы»):
      // тогда между городами остаётся только разделитель («из Бреста в Варшаву»)
      found.push({ city: CITY_FORMS[key]!, index: m.index, end: m.index + m[0].length });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

const SEPARATORS = /^(?:\s*(?:->|=>|>>|→|⇒|—|–|−|-|до|в|на|из|с|от)\s*(?:[а-яёa-z]{0,12}\s*)?)$/;

/**
 * Каноническое имя города по любому написанию:
 * «warsawa», «Warsaw», «Варшаве» → «Варшава».
 * Используется в мастере /post и в форме сайта, чтобы одинаковые города
 * в базе всегда были записаны одинаково (и поиск их находил).
 * Неизвестный город возвращается очищенным, как ввели.
 */
export function normalizeCity(raw: string): string {
  const clean = raw
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\- ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return raw.trim();

  const direct = CITY_FORMS[clean];
  if (direct) return direct;

  // «варшаве», «до кракова»: findCities допускает одну букву-окончание
  const found = findCities(clean);
  if (found.length > 0) return found[0]!.city;

  // Неизвестный город: вернём с заглавной буквы, в разумных пределах
  const capped = clean
    .split(' ')
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
  return capped.slice(0, 60);
}

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

export interface IntentScore {
  offer: number;
  request: number;
  /** Сколько баллов дали сильные признаки (первое лицо / явная просьба). */
  offerStrong: number;
  requestStrong: number;
}

/** Баллы намерения: сильные признаки весят вдвое больше тематических слов. */
export function scoreIntent(text: string): IntentScore {
  const offerStrong = scoreHints(text, OFFER_STRONG, []);
  const requestStrong = scoreHints(text, REQUEST_STRONG, []);
  return {
    offerStrong,
    requestStrong,
    offer: offerStrong + scoreHints(text, [], OFFER_WEAK),
    request: requestStrong + scoreHints(text, [], REQUEST_WEAK),
  };
}

function pickIntent(scores: IntentScore, text: string): 'offer' | 'request' | null {
  const { offer, request } = scores;
  if (offer === request) {
    if (offer === 0) return null;
    // Ничья: вопрос («кто везёт в Минск?», «занимаетесь перевозом?») — скорее просьба
    if (/\?/.test(text)) return 'request';
    return /передать/i.test(text) ? 'request' : 'offer';
  }
  return offer > request ? 'offer' : 'request';
}

export function detectIntent(text: string): 'offer' | 'request' | null {
  return pickIntent(scoreIntent(text), text);
}

/**
 * Правила уверены в типе заявки? Неуверенность — когда признаки обеих сторон
 * набрали баллы и разница меньше одного сильного признака: такие сообщения
 * (confidence < 0.7) каскад отдаёт ИИ, а не штампует наугад.
 */
export function isIntentConfident(textOrScores: string | IntentScore): boolean {
  const s = typeof textOrScores === 'string' ? scoreIntent(textOrScores) : textOrScores;
  if (s.offer === 0 && s.request === 0) return true; // признаков нет — спорить нечему
  if (s.offer === s.request) return false;
  // Победитель назван сильным признаком, а у второй стороны сильных нет вовсе:
  // «занимаетесь доставкой посылок?» — просьба, хотя «доставка» тема нейтральная.
  const winner = s.offer > s.request ? 'offer' : 'request';
  if (winner === 'offer' && s.offerStrong > 0 && s.requestStrong === 0) return true;
  if (winner === 'request' && s.requestStrong > 0 && s.offerStrong === 0) return true;
  return Math.abs(s.offer - s.request) >= STRONG_WEIGHT;
}

/** Главная точка входа: разбор текста сообщения из чата. now передаётся в тестах. */
/** Несколько направлений/дат в одном сообщении (туда-обратно, два рейса) —
 *  работа для ИИ: правила оформят только первое. Слова «обратно» или два и
 *  более фрагмента «день[-день][.месяц]» (диапазоны веса «5-10 кг» не в счёт). */
export function isMultiRoute(text: string): boolean {
  if (/обратно|туда[-\u2013 ]?обратно/i.test(text)) return true;
  // (?<!\d) и (?!\d) не дают откатиться внутрь числа (иначе «5-10 кг» матчится как «5-1»)
  const dateish = text.match(/(?<!\d)\d{1,2}[-\u2013.]\d{1,2}(?:\.\d{1,2})?(?!\d)(?!\s*(?:кг|kg|тонн))/gi) ?? [];
  return dateish.length >= 2;
}

export function parseTelegramMessage(text: string, now: Date = new Date()): ParsedMessage {
  const route = extractRoute(text);
  const scores = scoreIntent(text);
  const intent = pickIntent(scores, text) ?? (route ? 'offer' : null);
  // Признаки есть, но спорят («перевоз» + «кто-то занимается») — правила не уверены,
  // такое сообщение каскад отправит ИИ вместо угадывания типа заявки.
  const disputed = !isIntentConfident(scores);
  return {
    intent,
    fromCity: route?.from ?? null,
    toCity: route?.to ?? null,
    departureDate: parseDate(text, now),
    // «каждый четверг» — заявка не разовая; дата при этом = ближайший заезд
    recurring: parseRecurring(text),
    weightKg: extractWeight(text),
    price: extractPrice(text),
    telegram: extractTelegram(text),
    phone: extractPhone(text),
    confidence: route && intent ? (disputed ? 0.6 : 0.9) : route ? 0.7 : intent ? 0.5 : 0,
  };
}

/** Пассажирские попутки доска не публикует: «попутка.» — про посылки и вещи.
 *  Правило: есть явный пассажирский признак и ни одного посылочного слова. */
const PASSENGER_HINTS = [
  /пассажир/i,
  /(?:довез|подвез|подброс|доехать|проехать)/i,
  /ищ[уе]\s+попутк/i,
];
const PARCEL_HINTS = /посылк|бандерол|переда|груз|вещи|коробк|документ|печат|лекарств|медикамент|запечат/i;

/** Похоже ли сообщение на пассажирскую попутку (а не на передачу посылки). */
export function isPassengerOnly(text: string): boolean {
  if (!PASSENGER_HINTS.some((re) => re.test(text))) return false;
  return !PARCEL_HINTS.test(text);
}

/** Есть ли слова-признаки объявления (везу, нужно передать, ищу…). */
export function hasIntent(text: string): boolean {
  return detectIntent(text) !== null;
}

/** «Человеческие» формулировки, которые правила не ловят, а ИИ оформит:
 *  «есть кто из Бреста в Варшаву», «надо коробку передать»… */
const AI_TRIGGERS = /(?:\bкто\b|ищ[уи]|надо|нужн|можно|переда[йът]|отвез|забер|привез|подвез|довез|мест[ао]?\b)/i;

/**
 * Стоит ли отправлять сообщение в ИИ, если правила не справились:
 * есть известный город, посылочное слово, слова-признаки объявления
 * или явная «живая» формулировка запроса. Остальное (привет, спасибо,
 * мемы) ИИ не беспокоит — дневной лимит и деньги не тратим.
 */
export function worthAiCheck(text: string): boolean {
  if (detectIntent(text) !== null) return true;
  if (PARCEL_HINTS.test(text)) return true;
  if (findCities(text).length > 0) return true;
  return AI_TRIGGERS.test(text);
}

/** Должен ли бот вообще реагировать на сообщение (нет маршрута и нет явных подсказок — игнор). */
export function looksLikeListing(text: string, now: Date = new Date()): boolean {
  const p = parseTelegramMessage(text, now);
  return p.intent !== null && (p.fromCity !== null || p.toCity !== null);
}

export { extractRoute };
