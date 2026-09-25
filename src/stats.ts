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
  saveMonthSummary, type MonthRow, listModerationCounts, listDailyStats, upsertDailyCounts} from './store';
import { aiMonthSummary } from './ai';
import { CURRENCY_LABEL, CURRENCY_ORDER, fmtAmount, parsePrice, type Currency } from './price';
import { fmtPeriod, fmtPeriodGen, plural, prevPeriod } from './format';

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

/* ------------------ Поток заявок: дни, недели, месяцы ------------------- */

export interface DailyFlow {
  key: string;      // день / понедельник недели / месяц — для группировки
  label: string;    // человекочитаемая метка
  arrived: number;
  approved: number;
  rejected: number;
  offers: number;   // «водитель везёт»
  requests: number; // «нужно передать»
}

/**
 * Обновить дневные счётчики потока заявок. Пересчитываем из живых строк:
 *  - пропущенные дни (cron простаивал, первый запуск — бэкфилл за 90 дней);
 *  - вчера и сегодня (цифры ещё могут расти: заявки приходят, модератор
 *    решает). Историю не трогаем — удалённые заявки не должны «худить»
 *    уже зафиксированные дни.
 */
export async function refreshDailyStats(env: Env, now = new Date()): Promise<void> {
  const msk = new Date(now.getTime() + 3 * 3600 * 1000);
  const today = msk.toISOString().slice(0, 10);
  const yesterday = new Date(msk.getTime() - 86400_000).toISOString().slice(0, 10);
  const since = new Date(msk.getTime() - 89 * 86400_000).toISOString().slice(0, 10);
  const [rows, stored] = await Promise.all([
    listModerationCounts(env, since),
    listDailyStats(env, 400),
  ]);
  const byDay = new Map(stored.map((d) => [d.day, d]));
  const toUpsert = rows.filter((r) => {
    const prev = byDay.get(r.day);
    if (!prev) return true; // нового дня ещё нет — пишем
    if (r.day === today || r.day === yesterday) return true; // цифры ещё растут
    // старый снимок без разбивки по типам (arrived есть, offers/requests нули) —
    // догоняем, пока живые строки есть
    return prev.arrived > 0 && prev.offers + prev.requests === 0 && r.offers + r.requests > 0;
  });
  await upsertDailyCounts(env, toUpsert);
}

/** Понедельник недели, к которой относится день (YYYY-MM-DD → YYYY-MM-DD). */
function weekStart(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const shift = (d.getUTCDay() + 6) % 7; // Mon=0
  return new Date(d.getTime() - shift * 86400_000).toISOString().slice(0, 10);
}

/** Дни → недели или месяцы: счётчики суммируются, порядок — новые сверху. */
export function aggregateDaily(
  days: Array<{ day: string; arrived: number; approved: number; rejected: number; offers?: number; requests?: number }>,
  unit: 'week' | 'month'
): DailyFlow[] {
  const byKey = new Map<string, DailyFlow>();
  for (const d of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.day)) continue;
    const key = unit === 'month' ? d.day.slice(0, 7) : weekStart(d.day);
    const label = unit === 'month' ? key : `${key} · неделя`;
    const acc = byKey.get(key) ?? { key, label, arrived: 0, approved: 0, rejected: 0, offers: 0, requests: 0 };
    acc.arrived += d.arrived;
    acc.approved += d.approved;
    acc.rejected += d.rejected;
    acc.offers += d.offers ?? 0;
    acc.requests += d.requests ?? 0;
    byKey.set(key, acc);
  }
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? 1 : -1));
}

export interface RefreshResult {
  /** месяцы, которые пересчитали и сохранили */
  saved: string[];
  /** месяцы, которые оставили как есть (история уже полная) */
  kept: string[];
  /** месяцы, для которых в этом прогоне написали аналитическую заметку */
  summaries: string[];
  months: MonthStat[];
}

/** Разобрать payload снимка в MonthStat. null — снимок побился. */
export function parseMonthPayload(payload: string, fallbackMonth: string): MonthStat | null {
  try {
    const p = JSON.parse(payload) as Partial<MonthStat>;
    if (!p || typeof p.total !== 'number') return null;
    return {
      month: p.month ?? fallbackMonth,
      offers: Number(p.offers ?? 0),
      requests: Number(p.requests ?? 0),
      total: Number(p.total ?? 0),
      cities: Number(p.cities ?? 0),
      directions: Number(p.directions ?? 0),
      topDirections: Array.isArray(p.topDirections) ? p.topDirections : [],
      fromChats: Number(p.fromChats ?? 0),
      fromSite: Number(p.fromSite ?? 0),
      priced: Number(p.priced ?? 0),
      free: Number(p.free ?? 0),
      prices: Array.isArray(p.prices) ? p.prices : [],
      updatedAt: String(p.updatedAt ?? ''),
    };
  } catch {
    return null;
  }
}

/**
 * Пересчитать снимки. Прошлые месяцы не перезаписываем, если данных стало
 * меньше: объявление могло удалиться кроном, а итог месяца должен остаться.
 * `force` — пересчитать всё (нужно после исправлений в базе).
 */
export async function refreshStats(env: Env, opts: { force?: boolean; now?: Date } = {}): Promise<RefreshResult> {
  const now = opts.now ?? new Date();
  await ensureStatsTable(env);
  // дневные счётчики потока (пришло/одобрено/отклонено) — та же дисциплина
  // снимков, что и у месяцев: история фиксируется, вчера-сегодня пересчитываются
  await refreshDailyStats(env, now).catch((e) => console.error('refreshDailyStats failed', e));
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

  // Месяц закрылся — пишем аналитическую заметку один раз (ИИ; без ключа —
  // шаблон из цифр). За прогон не больше трёх: после деплоя догоняем
  // накопившиеся месяцы, дальше каждый месяц закрывается сам собой.
  const summaries: string[] = [];
  const fresh = await loadStatsSnapshots(env);
  for (const snap of fresh) {
    if (summaries.length >= 3) break;
    if (snap.month === currentMonth || snap.summary) continue;
    const done = await regenerateMonthSummary(env, snap.month);
    if (done) summaries.push(snap.month);
  }

  return { saved, kept, summaries, months: await listMonthStats(env) };
}

/**
 * Написать (переписать) аналитическую заметку месяца: сначала DeepSeek,
 * не вышло — уверенный шаблон из цифр. Страница /itogi/:month без текста
 * не останется никогда. null — месяца нет в снимках.
 */
export async function regenerateMonthSummary(
  env: Env,
  month: string
): Promise<{ summary: string; ai: boolean } | null> {
  const months = await listMonthStats(env);
  const stat = months.find((m) => m.month === month);
  if (!stat) return null;
  const prev = months.find((m) => m.month === prevPeriod(month)) ?? null;
  const ai = await aiMonthSummary(env, stat, prev);
  const summary = ai ?? fallbackSummary(stat, prev);
  await saveMonthSummary(env, month, summary);
  return { summary, ai: Boolean(ai) };
}

/** Сохранённые итоги, свежими вперёд. */
export async function listMonthStats(env: Env): Promise<MonthStat[]> {
  const snapshots = await loadStatsSnapshots(env);
  const out: MonthStat[] = [];
  for (const s of snapshots) {
    const parsed = parseMonthPayload(s.payload, s.month);
    if (!parsed) continue; // снимок побился — следующий пересчёт перезапишет
    out.push({ ...parsed, month: s.month, updatedAt: s.updatedAt || parsed.updatedAt });
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
 * Шаблонное «мнение» месяца из одних цифр — без ИИ. Страница /itogi/:month
 * показывает его, пока DeepSeek не задан или не справился: страница без
 * текста не останется, а цифры врёт только последняя.
 */
export function fallbackSummary(stat: MonthStat, prev?: MonthStat | null): string {
  const paragraphs: string[] = [];

  const share = (n: number) => Math.round((n / Math.max(1, stat.total)) * 100);
  paragraphs.push(
    `${fmtPeriod(stat.month)}: ${stat.total} ${plural(stat.total, 'объявление', 'объявления', 'объявлений')} — `
    + `${stat.offers} ${plural(stat.offers, 'водитель предлагал', 'водителя предлагали', 'водителей предлагало')} место `
    + `и ${stat.requests} ${plural(stat.requests, 'человек искал', 'человека искали', 'человек искало')}, кому передать. `
    + `География — ${stat.cities} ${plural(stat.cities, 'город', 'города', 'городов')} и ${stat.directions} `
    + plural(stat.directions, 'направление', 'направления', 'направлений') + '.'
  );

  const opinion: string[] = [];
  const top = stat.topDirections[0];
  if (top) {
    const dominance = share(top.count);
    opinion.push(
      dominance >= 25
        ? `Направление ${top.pair} — ядро месяца (${dominance}% всех заявок): коридор живой, шансы найти попутную передачу там самые высокие.`
        : `Даже самое частое направление, ${top.pair}, заняло лишь ${dominityWord(dominance)} заявок — доской пользуются на разных маршрутах, а не на одной магистрали.`
    );
  }
  if (stat.offers > stat.requests * 1.5 && stat.requests > 0) {
    opinion.push('Водителей на доске заметно больше, чем заявок на передачу: место в машине найти проще, чем попутчика для посылки — если нужно передать, месяц для этого подходил.');
  } else if (stat.requests > stat.offers * 1.5 && stat.offers > 0) {
    opinion.push('Заявок на передачу было больше, чем водителей: посылки копились в очереди, и каждый новый рейс был востребован.');
  } else if (stat.offers > 0 && stat.requests > 0) {
    opinion.push('Водителей и заявок на передачу примерно поровну — доска жила в обе стороны: и места искали пассажиры посылок, и посылки искали места.');
  }
  if (stat.prices.length > 0) {
    const p = stat.prices.map((b) => `${fmtAmount(b.avg)} ${b.currency === 'none' ? 'у.е.' : CURRENCY_LABEL[b.currency]}`).join(', ');
    opinion.push(`Средняя договорная цена — ${p} (считали отдельно по каждой валюте: смешивать евро со злотыми было бы бессмыслицей).`);
  } else {
    opinion.push('Цену в этом месяце почти никто не называл — договаривались в переписке, что для некоммерческой доски скорее норма.');
  }
  if (stat.free > 0) opinion.push(`${stat.free} ${plural(stat.free, 'человек предлагал', 'человека предлагали', 'человек предлагали')} передать бесплатно — просто по пути.`);
  paragraphs.push(opinion.join(' '));

  if (prev && prev.total > 0) {
    const diff = Math.round(((stat.total - prev.total) / prev.total) * 100);
    const trend = diff >= 10 ? `выросло на ${diff}%` : diff <= -10 ? `просело на ${Math.abs(diff)}%` : 'осталось примерно на том же уровне';
    paragraphs.push(
      `К ${fmtPeriod(prev.month)} поток ${trend}: ${prev.total} → ${stat.total} ${plural(stat.total, 'объявление', 'объявления', 'объявлений')}, `
      + `направлений ${prev.directions} → ${stat.directions}. Живую картину по любому маршруту видно на доске — итоги лишь срез.`
    );
  }

  return paragraphs.join('\n\n');
}

/** «треть»/«пятую часть» — доля в процентах словами без длинных дробей. */
function dominityWord(percent: number): string {
  if (percent >= 40) return 'почти половину';
  if (percent >= 20) return 'около трети';
  return `лишь ${percent}%`;
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

  // Ссылки — простым текстом: пост уходит в канал копированием, Telegram
  // сам делает такие адреса кликабельными. Страница месяца даёт возвратный
  // трафик из канала на сайт.
  lines.push(
    '',
    `Направления и подробности месяца: ${site}/itogi/${stat.month}`,
    `Передать посылку попутно — без посредников и комиссий: ${site}`
  );
  return lines.join('\n');
}

/** Короткая сводка для админки: одна строка на месяц. */
export function statsSummaryLine(stat: MonthStat): string {
  const price = stat.prices.length > 0
    ? stat.prices.map((b) => `${fmtAmount(b.avg)} ${b.currency === 'none' ? 'ед.' : b.currency}`).join(', ')
    : 'цен нет';
  return `${fmtPeriod(stat.month)}: ${stat.total} ${plural(stat.total, 'заявка', 'заявки', 'заявок')} (${price})`;
}
