/**
 * Склонение названий городов и стран для SEO-страниц.
 *
 * Страницы городов читают люди, а «Передачи из Варшава» и «Варшава в Польша»
 * режут глаз и снижают доверие к доске. Полноценного морфологического
 * анализатора у воркера нет, поэтому: правила по окончанию + таблица
 * исключений для городов, которые реально встречаются на доске.
 *
 * Нужны три формы:
 *  - родительный (из чего): «из Варшавы», «из Гродно», «из Черновцов»;
 *  - винительный (в куда):  «в Варшаву», «в Минск» (неодушевлённые = им. п.);
 *  - предложный для стран: «в Польше», «в Беларуси», «в Нидерландах».
 */

/** Города, где правило по окончанию даёт неверную форму. */
const CITY_GEN_OVERRIDES: Record<string, string> = {
  'Москва': 'Москвы', // к → и не работает: Москвы, но «в Москву»
  'Феодосия': 'Феодосии',
  'Марьина Горка': 'Марьиной Горки',
  'Белая Церковь': 'Белой Церкви',
  'Великие Луки': 'Великих Лук',
  'Ростов-на-Дону': 'Ростова-на-Дону',
  'Комсомольск-на-Амуре': 'Комсомольска-на-Амуре',
};

/** Женский род на -ь (родительный -и), всё остальное на -ь — мужской (-я). */
const FEMININE_SOFT = new Set([
  'Казань', 'Тверь', 'Рязань', 'Пермь', 'Тюмень', 'Астрахань', 'Керчь',
  'Познань', 'Лодзь', 'Сморгонь', 'Любань', 'Слонимь',
]);

/** Города, которые не склоняются (иностранные на -о/-е/-и, славянские на -ы). */
const INDECLINABLE_ENDINGS = ['о', 'е', 'и', 'э', 'у', 'ы'];

const HUSHING = ['к', 'г', 'х', 'ш', 'щ', 'ч', 'ж'];

/** Последняя буква слова (для составных названий — последнего слова). */
function lastChar(word: string): string {
  return word.slice(-1).toLowerCase();
}

function stemLast(word: string): string {
  return word.slice(-2, -1).toLowerCase();
}

/**
 * Родительный падеж: «из …».
 * Минск → Минска, Варшава → Варшавы, Прага → Праги, Черновцы → Черновцов,
 * Гродно/Катовице → без изменений.
 */
export function genitiveCity(city: string): string {
  const name = city.trim();
  if (!name) return name;
  if (CITY_GEN_OVERRIDES[name]) return CITY_GEN_OVERRIDES[name];

  const last = lastChar(name);

  // множественное число: Черновцы → Черновцов, Барановичи → Барановичей
  if (/цы$/i.test(name)) return name.replace(/цы$/i, 'цов');
  if (/чи$/i.test(name)) return name.replace(/чи$/i, 'чей');
  if (/сы$/i.test(name)) return name.replace(/сы$/i, 'с');
  if (/ны$/i.test(name)) return name.replace(/ны$/i, 'н');

  if (last === 'а') {
    // Прага → Праги, Варшава → Варшавы; Москва — в исключениях
    return HUSHING.includes(stemLast(name)) ? name.slice(0, -1) + 'и' : name.slice(0, -1) + 'ы';
  }
  if (/ия$/i.test(name)) return name.replace(/ия$/i, 'ии'); // Александрия → Александрии
  if (last === 'я') return name.slice(0, -1) + 'и';
  if (/ье$/i.test(name)) return name.replace(/ье$/i, 'ья'); // Запорожье → Запорожья

  if (last === 'ь') {
    return FEMININE_SOFT.has(name) ? name.slice(0, -1) + 'и' : name.slice(0, -1) + 'я';
  }

  if (INDECLINABLE_ENDINGS.includes(last)) return name;

  // мужской род на согласный: Минск → Минска, Киев → Киева, Гомель см. выше
  return name + 'а';
}

/**
 * Винительный падеж: «в …». Неодушевлённые совпадают с именительным,
 * меняются только женские формы на -а/-я.
 */
export function accusativeCity(city: string): string {
  const name = city.trim();
  if (!name) return name;
  if (/ия$/i.test(name)) return name.replace(/ия$/i, 'ию'); // в Феодосию
  const last = lastChar(name);
  if (last === 'а') return name.slice(0, -1) + 'у';
  if (last === 'я') return name.slice(0, -1) + 'ю';
  return name;
}

/** «во Львов», «во Вроцлав», но «в Варшаву». */
export function intoCity(city: string): string {
  const name = city.trim();
  const first = name.slice(0, 1).toLowerCase();
  const second = name.slice(1, 2).toLowerCase();
  const consonants = 'бвгджзклмнпрстфхцчшщ';
  const vo = name.toLowerCase() === 'львов'
    || ((first === 'в' || first === 'ф') && consonants.includes(second));
  return `${vo ? 'во' : 'в'} ${accusativeCity(name)}`;
}

/** «из Варшавы» — предлог всегда «из». */
export function fromCity(city: string): string {
  return `из ${genitiveCity(city)}`;
}

/** Предложный падеж стран: Польша → Польше, Беларусь → Беларуси. */
const COUNTRY_LOC_OVERRIDES: Record<string, string> = {
  'Беларусь': 'Беларуси',
  'Израиль': 'Израиле',
  'Нидерланды': 'Нидерландах',
  'США': 'США',
  'ОАЭ': 'ОАЭ',
  'Великобритания': 'Великобритании',
  'Венгрия': 'Венгрии',
};

export function locativeCountry(country: string): string {
  const name = country.trim();
  if (!name) return name;
  if (COUNTRY_LOC_OVERRIDES[name]) return COUNTRY_LOC_OVERRIDES[name];
  if (/ия$/i.test(name)) return name.replace(/ия$/i, 'ии');
  const last = lastChar(name);
  if (last === 'а' || last === 'я') return name.slice(0, -1) + 'е';
  if (last === 'ь') return name.slice(0, -1) + 'и';
  if (last === 'ы') return name; // plural — редкий случай, не портим
  return name + 'е';
}

/** «в Польше» — с правильным предлогом. */
export function inCountry(country: string): string {
  const loc = locativeCountry(country);
  return `${/^[вф]/i.test(loc) ? 'во' : 'в'} ${loc}`;
}
