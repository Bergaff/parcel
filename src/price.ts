/**
 * Разбор цены из объявления.
 *
 * Цену люди пишут как попало: «30 BYN», «20-30 евро», «1000 руб», «50 zł»,
 * «договорная», «бесплатно». Для итогов месяца нужна одна функция, которая
 * достаёт из этого число и валюту — иначе «средняя цена» превратится в
 * среднее между евро и рублями.
 *
 * Валюту определяем по ключевым словам, порядок проверки важен:
 * «бел руб» — это BYN, хотя слово «руб» там тоже есть.
 */

export type Currency = 'BYN' | 'EUR' | 'USD' | 'PLN' | 'RUB' | 'UAH' | 'GBP' | 'CZK';

export interface ParsedPrice {
  /** null — число есть, а валюта не названа */
  currency: Currency | null;
  /** середина диапазона либо единственное число */
  amount: number;
  min: number;
  max: number;
  /** «бесплатно» / «даром»: ноль без валюты */
  free: boolean;
}

/** Названия валют для отчётов — порядок вывода. */
export const CURRENCY_ORDER: Currency[] = ['EUR', 'PLN', 'USD', 'BYN', 'RUB', 'UAH', 'GBP', 'CZK'];

/** Подписи валют: как их показывать людям. */
export const CURRENCY_LABEL: Record<Currency | 'none', string> = {
  EUR: 'евро',
  PLN: 'злотых',
  USD: 'долларов',
  BYN: 'белорусских рублей',
  RUB: 'российских рублей',
  UAH: 'гривен',
  GBP: 'фунтов',
  CZK: 'чешских крон',
  none: 'валюта не указана',
};

const FREE_WORDS = /бесплатн|даром|безвозмездн|без оплат|за спасибо|не возьму денег/i;
/** «договорная», «по договорённости», «уточняйте» — числа нет и не будет. */
const NO_PRICE_WORDS = /договорн|по договор|уточн|обсужда|цена не указана|\?/i;

/** Правила валют: порядок имеет значение (BYN раньше RUB, PLN раньше «зл»). */
const CURRENCY_RULES: Array<[Currency, RegExp]> = [
  // \b с кириллицей не работает, поэтому границы «бр» и «byn» пишем явно
  ['BYN', /(?:^|[^а-яёa-z0-9])byn(?:[^а-яёa-z0-9]|$)|бел\.?\s*руб|(?:^|[^а-яёa-z0-9])бр(?:[^а-яёa-z0-9]|$)|рублей\s*(?:рб|беларус)|белорусск/i],
  ['PLN', /\bzł|\bzl\b|\bpln\b|злот/i],
  ['UAH', /грн|гривен|\buah\b|₴/i],
  ['EUR', /евро|\beur\b|€/i],
  ['USD', /доллар|\busd\b|\$/i],
  ['GBP', /фунт|\bgbp\b|£/i],
  ['CZK', /чешск|крон|\bczk\b|kč/i],
  ['RUB', /руб|\brub\b|₽|\brur\b/i],
];

/** Приводим текст к виду, где числа читаются однозначно. */
function normalize(raw: string): string {
  return raw
    .replace(/(\d)[\s\u00A0\u2009\u202F]+(?=\d{3}(?!\d))/g, '$1') // 1 000 → 1000
    .replace(/(\d),(\d{1,2})(?!\d)/g, '$1.$2') // 27,5 → 27.5 (запятая-разделитель)
    .replace(/(\d)\s*[-–—]\s*(\d)/g, '$1-$2'); // 20 - 30 → 20-30
}

/**
 * Разобрать цену. null — цены в тексте нет («договорная», пусто).
 */
export function parsePrice(raw: string | null | undefined): ParsedPrice | null {
  const text = (raw ?? '').trim();
  if (!text) return null;

  const currency = detectCurrency(text);

  if (FREE_WORDS.test(text)) {
    // «бесплатно» важнее любых чисел рядом («бесплатно, только бензин 20 евро»)
    const numbers = numbersOf(normalize(text));
    if (numbers.length === 0) return { currency: null, amount: 0, min: 0, max: 0, free: true };
  }
  if (NO_PRICE_WORDS.test(text)) {
    // «договорная» — но если рядом всё же есть число, берём его («цена договорная, от 20 евро»)
    const hasNumber = /\d/.test(text);
    if (!hasNumber) return null;
  }

  const numbers = numbersOf(normalize(text));
  if (numbers.length === 0) return null;

  // Отбрасываем мусор: даты, вес, «2 человека» ловятся тем, что берём только
  // первые два числа — диапазон цены всегда в начале фразы.
  const [first, second] = numbers;
  const min = first!;
  const max = second != null && second > first! ? second : first!;
  const amount = Math.round(((min + max) / 2) * 100) / 100;

  if (FREE_WORDS.test(text) && !/\d/.test(text.replace(/[.,]/g, ''))) {
    return { currency: null, amount: 0, min: 0, max: 0, free: true };
  }
  if (amount <= 0) return null;

  return { currency, amount, min, max, free: false };
}

function detectCurrency(text: string): Currency | null {
  for (const [code, re] of CURRENCY_RULES) {
    if (re.test(text)) return code;
  }
  return null;
}

/** Все числа в тексте, по порядку. */
function numbersOf(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\d+(?:\.\d+)?/g)) {
    const n = parseFloat(m[0]);
    if (Number.isFinite(n) && n > 0) out.push(n);
    if (out.length >= 2) break;
  }
  return out;
}

/** Красивое число для отчётов: 27.5 → «27,5», 30 → «30». */
export function fmtAmount(n: number): string {
  const rounded = Math.round(n * 10) / 10;
  return String(rounded).replace('.', ',');
}

/** «30 евро», «20–30 злотых». */
export function fmtPrice(p: ParsedPrice): string {
  if (p.free) return 'бесплатно';
  const short = p.currency ? currencyShort(p.currency) : 'ед.';
  const value = p.min === p.max ? fmtAmount(p.amount) : `${fmtAmount(p.min)}–${fmtAmount(p.max)}`;
  return `${value} ${short}`;
}

function currencyShort(c: Currency): string {
  return { EUR: '€', PLN: 'zł', USD: '$', BYN: 'BYN', RUB: '₽', UAH: 'грн', GBP: '£', CZK: 'Kč' }[c];
}
