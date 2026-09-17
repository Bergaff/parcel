/**
 * Итоги месяца: сколько объявлений прошло через доску и по чём люди
 * договаривались. Нужно это не «для отчёта», а для постов в канал: раз в месяц
 * админ копирует готовый текст (/статистика в боте или вкладка «итоги»
 * в админке) и публикует — такие посты приводят людей лучше любой рекламы.
 *
 * Важная деталь: объявления удаляются кроном через 30 дней после выезда
 * (см. archiveExpired), поэтому посчитать «март» в июле по живым строкам
 * нельзя. Итоги складываются в снимки stats_months: текущий месяц
 * пересчитывается каждый день, прошлые — только если новых данных прибавилось.
 */
import type { Env } from './types';
import {
  ensureStatsTable, listMonthRows, listMonthsPresent, loadStatsSnapshots, saveStatsSnapshot,
  type MonthRow,
} from './store';
import { CURRENCY_LABEL, CURRENCY_ORDER, fmtAmount, parsePrice, type Currency } from './price';
import { fmtPeriod, fmtPeriodGen, plural } from './format';

export interface PriceBucket {
  /** 'EUR'…'CZK' либо 'none' — число есть, валюта не названа */
  currency: Currency | 'none';
  count: number;
  avg: number;
  min: number;
  max: number;
}

export interface MonthStat {
  month: string;
  /** «водитель везёт» */
  offers: number;
  /** «нужно передать» */
  requests: number;
  total: number;
  /** сколько разных городов участвовало */
  cities: number;
  /** сколько разных направлений */
  directions: number;
  topDirections: Array<{ pair: string; from: string; to: string; count: number }>;
  /** из телеграм-чатов (ботом) */
  fromChats: number;
  /** с сайта, через форму или вручную */
  fromSite: number;
  /** объявлений, где цену удалось разобрать */
  priced: number;
  /** написали «бесплатно» */
  free: number;
  prices: PriceBucket[];
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Подсчёт                                                             */
/* ------------------------------------------------------------------ */

/** Собрать итог месяца из строк. Чистая функция — её и тестируем. */
export function aggregateMonth(month: string, rows: MonthRow[], now = new Date()): MonthStat {
  const offers = rows.filter((r) => r.type === 'offer').length;
  const cities = new Set<string>();
  const pairs = new Map<string, { from: string; to: string; count: number }>();

  for (const r of rows) {
    if (r.fromCity) cities.add(r.fromCity.toLowerCase());
    if (r.toCity) cities.add(r.toCity.toLowerCase());
    const key = `${r.fromCity}|${r.toCity}`;
    const cur = pairs.get(key) ?? { from: r.fromCity, to: r.toCity, count: 0 };
    cur.count += 1;
    pairs.set(key, cur);
  }

  const topDirections = [...pairs.values()]
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from, 'ru'))
    .slice(0, 3)
    .map((d) => ({ ...d, pair: `${d.from} → ${d.to}` }));

  // цены: разбираем текст, складываем по валютам — среднее между евро и
  // рублями было бы бессмыслицей, поэтому корзина на каждую валюту своя
  const sums = new Map<Currency | 'none', { sum: number; count: number; min: number; max: number }>();
  let priced = 0;
  let free = 0;
  for (const r of rows) {
    const p = parsePrice(r.price);
    if (!p) continue;
    if (p.free) { free += 1; continue; }
    priced += 1;
    const key = p.currency ?? 'none';
    const b = sums.get(key) ?? { sum: 0, count: 0, min: Infinity, max: 0 };
    b.sum += p.amount;
    b.count += 1;
    b.min = Math.min(b.min, p.min);
    b.max = Math.max(b.max, p.max);
    sums.set(key, b);
  }

  const prices: PriceBucket[] = [];
  for (const code of [...CURRENCY_ORDER, 'none'] as Array<Currency | 'none'>) {
    const b = sums.get(code);
    if (!b) continue;
    prices.push({
      currency: code,
      count: b.count,
      avg: Math.round((b.sum / b.count) * 10) / 10,
      min: b.min === Infinity ? 0 : b.min,
      max: b.max,
    });
  }

  return {
    month,
    offers,
    requests: rows.length - offers,
    total: rows.length,
    cities: cities.size,
    directions: pairs.size,
    topDirections,
    fromChats: rows.filter((r) => r.source === 'telegram' || r.source === 'parser').length,
    fromSite: rows.filter((r) => r.source === 'site').length,
    priced,
    free,
    prices,
    updatedAt: now.toISOString(),
  };
}

/** Посчитать месяц по живым строкам базы. null — в этом месяце пусто. */
export async function computeMonthStat(env: Env, month: string, now = new Date()): Promise<MonthStat | null> {
  const rows = await listMonthRows(env, month);
  if (rows.length === 0) return null;
  return aggregateMonth(month, rows, now);
}

export interface RefreshResult {
  /** месяцы, которые пересчитали и сохранили */
  saved: string[];
  /** месяцы, которые оставили как есть (история уже полная) */
  kept: string[];
  months: MonthStat[];
}

/**
 * Пересчитать снимки. Прошлые месяцы не перезаписываем, если данных стало
 * меньше: объявление могло удалиться кроном, а итог месяца должен остаться.
 * `force` — пересчитать всё (нужно после исправлений в базе).
 */
export async function refreshStats(env: Env, opts: { force?: boolean; now?: Date } = {}): Promise<RefreshResult> {
  const now = opts.now ?? new Date();
  await ensureStatsTable(env);
  const [present, stored] = await Promise.all([listMonthsPresent(env), loadStatsSnapshots(env)]);
  const storedByMonth = new Map(stored.map((s) => [s.month, s]));
  const currentMonth = now.toISOString().slice(0, 7);
  const saved: string[] = [];
  const kept: string[] = [];

  for (const month of present) {
    const stat = await computeMonthStat(env, month, now);
    if (!stat) continue;
    const prev = storedByMonth.get(month);
    if (!prev) {
      await saveStatsSnapshot(env, month, stat.total, stat);
      saved.push(month);
      continue;
    }
    if (opts.force || month === currentMonth || stat.total > prev.total) {
      await saveStatsSnapshot(env, month, stat.total, stat);
      saved.push(month);
    } else {
      kept.push(month);
    }
  }
  return { saved, kept, months: await listMonthStats(env) };
}

/** Сохранённые итоги, свежими вперёд. */
export async function listMonthStats(env: Env): Promise<MonthStat[]> {
  const snapshots = await loadStatsSnapshots(env);
  const out: MonthStat[] = [];
  for (const s of snapshots) {
    try {
      const parsed = JSON.parse(s.payload) as Partial<MonthStat>;
      if (!parsed || typeof parsed.total !== 'number') continue;
      out.push({
        month: s.month,
        offers: Number(parsed.offers ?? 0),
        requests: Number(parsed.requests ?? 0),
        total: Number(parsed.total ?? 0),
        cities: Number(parsed.cities ?? 0),
        directions: Number(parsed.directions ?? 0),
        topDirections: Array.isArray(parsed.topDirections) ? parsed.topDirections : [],
        fromChats: Number(parsed.fromChats ?? 0),
        fromSite: Number(parsed.fromSite ?? 0),
        priced: Number(parsed.priced ?? 0),
        free: Number(parsed.free ?? 0),
        prices: Array.isArray(parsed.prices) ? parsed.prices : [],
        updatedAt: s.updatedAt || String(parsed.updatedAt ?? ''),
      });
    } catch {
      // снимок побился — пропускаем, следующий пересчёт его перезапишет
    }
  }
  return out.sort((a, b) => (a.month < b.month ? 1 : -1));
}

/* ------------------------------------------------------------------ */
/* Тексты                                                              */
/* ------------------------------------------------------------------ */

/** Подпись валюты в множественном числе: «евро», «злотых», «белорусских рублей». */
export function currencyWord(code: Currency | 'none'): string {
  return CURRENCY_LABEL[code];
}

/**
 * Готовый текст поста в канал. Копируется как есть: админ ничего не
 * дописывает руками, иначе постов не будет совсем.
 */
export function statsPostText(stat: MonthStat, opts: { site?: string; month?: 'current' | 'past' } = {}): string {
  const site = opts.site ?? 'https://pop-utka.app';
  const lines: string[] = [];
  const headline = opts.month === 'current'
    ? `📦 ${fmtPeriod(stat.month)} на доске «попутка.» — пока месяц идёт`
    : `📦 Итоги ${fmtPeriodGen(stat.month)} на доске «попутка.»`;
  lines.push(headline, '');

  lines.push(
    `${stat.total} ${plural(stat.total, 'объявление', 'объявления', 'объявлений')}: `
    + `${stat.offers} «водитель везёт» и ${stat.requests} «нужно передать».`
  );
  if (stat.fromChats + stat.fromSite > 0) {
    lines.push(
      `${stat.fromChats} ${plural(stat.fromChats, 'пришло', 'пришли', 'пришло')} из телеграм-чатов, `
      + `${stat.fromSite} — с сайта.`
    );
  }
  lines.push(
    `Городов: ${stat.cities}. Направлений: ${stat.directions}.`
  );
  if (stat.topDirections.length > 0) {
    lines.push(
      `Самые живые направления: ${stat.topDirections
        .map((d) => `${d.pair} (${d.count})`)
        .join(', ')}.`
    );
  }
  lines.push('');

  if (stat.prices.length > 0) {
    lines.push('Средняя цена передачи:');
    for (const b of stat.prices) {
      const word = currencyWord(b.currency);
      const range = b.min !== b.max ? ` (от ${fmtAmount(b.min)} до ${fmtAmount(b.max)})` : '';
      lines.push(`• ${word} — ${fmtAmount(b.avg)} по ${b.count} ${plural(b.count, 'объявлению', 'объявлениям', 'объявлениям')}${range}`);
    }
  } else {
    lines.push('Цену в этом месяце почти никто не указывал — договаривались в переписке.');
  }
  const tails: string[] = [];
  if (stat.free > 0) tails.push(`${stat.free} ${plural(stat.free, 'человек предложил', 'человека предложили', 'человек предложили')} передать бесплатно`);
  const withoutPrice = stat.total - stat.priced - stat.free;
  if (withoutPrice > 0) tails.push(`${withoutPrice} цену не указали`);
  if (tails.length > 0) lines.push(`Ещё ${tails.join(', ')}.`);

  lines.push('', 'Передать посылку попутно — без посредников и комиссий:', site);
  return lines.join('\n');
}

/** Короткая сводка для админки: одна строка на месяц. */
export function statsSummaryLine(stat: MonthStat): string {
  const price = stat.prices.length > 0
    ? stat.prices.map((b) => `${fmtAmount(b.avg)} ${b.currency === 'none' ? 'ед.' : b.currency}`).join(', ')
    : 'цен нет';
  return `${fmtPeriod(stat.month)}: ${stat.total} ${plural(stat.total, 'заявка', 'заявки', 'заявок')} (${price})`;
}
