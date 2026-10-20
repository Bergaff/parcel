/**
 * Выгрузка заявок в таблицу (CSV) — кнопка «экспорт в CSV» в админке.
 *
 * Про кодировку и разделитель. Файл открывают двойным кликом в Excel и в
 * Google Таблицах, поэтому:
 * - UTF-8 **с BOM**: без BOM Excel на Windows показывает кириллицу как
 *   «ÐÐÐ°Ñ» и не даёт это исправить ничем, кроме импорта через мастер;
 * - разделитель — **точка с запятой**: в русской/белорусской/польской локали
 *   Windows список в Excel разделён «;», а запятая оставила бы всю строку в
 *   одной колонке;
 * - переносы строк — CRLF, как ждёт Excel;
 * - каждая ячейка в кавычках, внутренние кавычки удвоены: в описаниях заявок
 *   встречаются и «;», и кавычки, и переносы строк.
 */
import type { Listing, ListingStatus } from './types';

/** Шапка таблицы — по-русски, так её и будут читать. */
export const CSV_HEADERS: readonly string[] = [
  'id', 'статус', 'тип', 'откуда', 'куда', 'дата выезда', 'дней до выезда',
  'расписание', 'вес, кг', 'цена', 'телефон', 'телеграм', 'источник',
  'чат-источник', 'кто подал', 'создано', 'опубликовано', 'просмотров',
  'скрыта', 'закреплена до', 'описание',
];

export const STATUS_LABEL: Record<ListingStatus, string> = {
  published: 'на доске',
  expired: 'в архиве',
  pending: 'на модерации',
  rejected: 'отклонена',
};

export const TYPE_LABEL: Record<Listing['type'], string> = {
  offer: 'водитель везёт',
  request: 'ищу передачу',
};

export const SOURCE_LABEL: Record<Listing['source'], string> = {
  site: 'с сайта',
  telegram: 'из бота',
  parser: 'из чата',
};

/** Одна ячейка CSV: всегда в кавычках, внутренние кавычки удваиваем. */
export function csvCell(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? '' : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Сколько дней от `todayIso` до даты выезда. Отрицательное — дата уже прошла
 * (такие заявки на доске и есть главный мусор, ради которого смотрят таблицу).
 * Null — даты нет вовсе или она не разобралась.
 */
export function daysUntil(dateIso: string | null, todayIso: string): number | null {
  if (!dateIso) return null;
  const target = Date.parse(`${dateIso.slice(0, 10)}T00:00:00Z`);
  const today = Date.parse(`${todayIso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(target) || Number.isNaN(today)) return null;
  return Math.round((target - today) / 86_400_000);
}

/** «2026-10-19T13:14:15Z» → «2026-10-19 13:14»: секунды в таблице только мешают. */
export function fmtStamp(raw: string | null): string {
  if (!raw) return '';
  return raw.replace('T', ' ').slice(0, 16);
}

/** Кто подал заявку — как штамп происхождения в админке. */
function submittedBy(l: Listing): string {
  if (l.byAdmin) return 'админ';
  if (l.fromPerson) return 'сам человек';
  return '';
}

/** Строка таблицы: порядок значений обязан совпадать с CSV_HEADERS. */
export function listingCsvRow(l: Listing, todayIso: string): Array<string | number | null> {
  return [
    l.id,
    STATUS_LABEL[l.status] ?? l.status,
    TYPE_LABEL[l.type] ?? l.type,
    l.fromCity,
    l.toCity,
    l.departureDate ?? '',
    daysUntil(l.departureDate ?? null, todayIso),
    l.recurring ?? '',
    l.weightKg ?? null,
    l.price ?? '',
    l.phone ?? '',
    l.telegram ?? '',
    SOURCE_LABEL[l.source] ?? l.source,
    l.sourceChat ?? '',
    submittedBy(l),
    fmtStamp(l.createdAt),
    fmtStamp(l.publishedAt),
    l.views,
    l.hidden ? 'да' : '',
    fmtStamp(l.pinnedUntil ?? null),
    l.description,
  ];
}

/** Вся таблица: BOM, шапка, строки, CRLF в конце каждой. */
export function renderListingsCsv(items: Listing[], todayIso: string): string {
  const lines = [CSV_HEADERS.map(csvCell).join(';')];
  for (const l of items) lines.push(listingCsvRow(l, todayIso).map(csvCell).join(';'));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
