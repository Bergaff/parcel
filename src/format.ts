/**
 * Форматирование дат и чисел по-русски — одно место для серверного рендера
 * (страницы маршрутов, городов, карточка объявления, итоги месяца).
 * Клиент форматирует сам в public/app.js: там свои правила («3 часа назад»).
 */

export const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
export const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const WEEKDAY_NAMES = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

export const MONTHS_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

export function plural(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const d = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (d > 1 && d < 5) return few;
  if (d === 1) return one;
  return many;
}

/** '2026-09-20' → '20 сен' (короткая подпись в списках). */
export function fmtDayShort(iso: string | null | undefined): string {
  const m = /^(20\d\d)-(\d\d)-(\d\d)/.exec(iso ?? '');
  if (!m) return iso ?? '';
  const month = MONTHS_SHORT[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month}` : (iso ?? '');
}

/** '2026-09-20' → '20 сентября' (текст страниц и OG-картинки). */
export function fmtDayFull(iso: string | null | undefined): string {
  const m = /^(20\d\d)-(\d\d)-(\d\d)/.exec(iso ?? '');
  if (!m) return iso ?? '';
  const month = MONTHS_GEN[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month}` : (iso ?? '');
}

/** '2026-09-20' → '20 сентября 2026' */
export function fmtDateWithYear(iso: string | null | undefined): string {
  const m = /^(20\d\d)-(\d\d)-(\d\d)/.exec(iso ?? '');
  if (!m) return iso ?? '';
  const month = MONTHS_GEN[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month} ${m[1]}` : (iso ?? '');
}

/** '2026-09' → 'сентябрь 2026' (заголовки итогов месяца). */
export function fmtPeriod(period: string): string {
  const m = /^(20\d\d)-(\d\d)$/.exec(period);
  if (!m) return period;
  const month = MONTHS_NOM[Number(m[2]) - 1];
  return month ? `${month} ${m[1]}` : period;
}

/** '2026-09' → 'сентября 2026' («итоги сентября», родительный падеж). */
export function fmtPeriodGen(period: string): string {
  const m = /^(20\d\d)-(\d\d)$/.exec(period);
  if (!m) return period;
  const month = MONTHS_GEN[Number(m[2]) - 1];
  return month ? `${month} ${m[1]}` : period;
}

/** '2026-09' → 'в сентябре 2026' (текст сводки). */
export function fmtPeriodIn(period: string): string {
  const m = /^(20\d\d)-(\d\d)$/.exec(period);
  if (!m) return period;
  const month = MONTHS_GEN[Number(m[2]) - 1];
  return month ? `в ${month} ${m[1]}` : period;
}

/** Текущий период 'YYYY-MM' по МСК (совпадает с mskTodayIso по смыслу). */
export function currentPeriod(now = new Date()): string {
  return new Date(now.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 7);
}

/** Период предыдущего месяца: '2026-09' → '2026-08'. */
export function prevPeriod(period: string): string {
  const m = /^(20\d\d)-(\d\d)$/.exec(period);
  if (!m) return period;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 2, 1));
  return d.toISOString().slice(0, 7);
}

/** 8 → '8 кг', 7.5 → '7,5 кг' */
export function fmtWeight(kg: number | null | undefined): string | null {
  if (kg == null) return null;
  return `${String(kg).replace('.', ',')} кг`;
}
