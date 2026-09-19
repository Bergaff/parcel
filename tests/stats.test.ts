/**
 * Итоги месяца: подсчёт, снимки и готовый текст для поста.
 *
 * Отдельно проверяем правило снимков — прошлые месяцы не должны «худеть»,
 * когда cron удаляет старые объявления.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../src/types';
import type { MonthRow } from '../src/store';

const db = vi.hoisted(() => ({
  rows: new Map<string, MonthRow[]>(),
  snapshots: new Map<string, { total: number; payload: string; summary?: string | null }>(),
  saves: [] as string[],
  summarySaves: [] as string[],
}));

vi.mock('../src/store', () => ({
  ensureStatsTable: async () => undefined,
  listMonthRows: async (_env: unknown, month: string) => db.rows.get(month) ?? [],
  listMonthsPresent: async () => [...db.rows.keys()].sort().reverse(),
  loadStatsSnapshots: async () => [...db.snapshots.entries()].map(([month, s]) => ({
    month, total: s.total, payload: s.payload, summary: s.summary ?? null, updatedAt: '2026-09-17 10:00:00',
  })),
  getMonthSnapshot: async (_env: unknown, month: string) => {
    const s = db.snapshots.get(month);
    return s ? { month, total: s.total, payload: s.payload, summary: s.summary ?? null, updatedAt: '2026-09-17 10:00:00' } : null;
  },
  saveStatsSnapshot: async (_env: unknown, month: string, total: number, payload: unknown, summary?: string | null) => {
    db.snapshots.set(month, { total, payload: JSON.stringify(payload), summary: summary ?? db.snapshots.get(month)?.summary ?? null });
    db.saves.push(month);
  },
  saveMonthSummary: async (_env: unknown, month: string, summary: string) => {
    const s = db.snapshots.get(month);
    if (!s) return false;
    s.summary = summary;
    db.summarySaves.push(month);
    return true;
  },
}));

import { aggregateMonth, computeMonthStat, fallbackSummary, listMonthStats, refreshStats, statsPostText, statsSummaryLine } from '../src/stats';

const env = {} as Env;

function row(over: Partial<MonthRow> = {}): MonthRow {
  return {
    id: 'id-1',
    type: 'offer',
    fromCity: 'Варшава',
    toCity: 'Минск',
    price: '30 EUR',
    source: 'telegram',
    ...over,
  };
}

beforeEach(() => {
  db.rows = new Map();
  db.snapshots = new Map();
  db.saves = [];
});

describe('подсчёт месяца', () => {
  it('типы, города, направления и откуда пришли', () => {
    const stat = aggregateMonth('2026-09', [
      row(),
      row({ id: 'id-2', type: 'request', fromCity: 'Минск', toCity: 'Варшава', price: 'договорная', source: 'site' }),
      row({ id: 'id-3', type: 'offer', fromCity: 'Краков', toCity: 'Киев', price: '50 zł', source: 'parser' }),
      row({ id: 'id-4', type: 'request', fromCity: 'Варшава', toCity: 'Минск', price: 'бесплатно', source: 'site' }),
    ]);
    expect(stat.total).toBe(4);
    expect(stat.offers).toBe(2);
    expect(stat.requests).toBe(2);
    expect(stat.cities).toBe(4); // Варшава, Минск, Краков, Киев
    expect(stat.directions).toBe(3); // обратное направление — отдельная пара
    expect(stat.fromChats).toBe(2); // telegram + parser
    expect(stat.fromSite).toBe(2);
    expect(stat.topDirections[0]).toMatchObject({ pair: 'Варшава → Минск', from: 'Варшава', to: 'Минск', count: 2 });
    expect(stat.free).toBe(1);
  });

  it('средняя цена — своя корзина на каждую валюту', () => {
    const stat = aggregateMonth('2026-09', [
      row({ id: '1', price: '20 EUR' }),
      row({ id: '2', price: '30 EUR' }),
      row({ id: '3', price: '20-30 EUR' }),
      row({ id: '4', price: '100 BYN' }),
      row({ id: '5', price: '50' }),
      row({ id: '6', price: 'бесплатно' }),
      row({ id: '7', price: 'договорная' }),
      row({ id: '8', price: null }),
    ]);
    const eur = stat.prices.find((p) => p.currency === 'EUR')!;
    expect(eur.count).toBe(3);
    expect(eur.avg).toBe(25); // (20 + 30 + 25) / 3
    expect(eur.min).toBe(20);
    expect(eur.max).toBe(30);
    expect(stat.prices.find((p) => p.currency === 'BYN')?.avg).toBe(100);
    expect(stat.prices.find((p) => p.currency === 'none')?.avg).toBe(50);
    // валюта без названия идёт последней — не путать с реальными деньгами
    expect(stat.prices[stat.prices.length - 1]!.currency).toBe('none');
    expect(stat.priced).toBe(5);
    expect(stat.free).toBe(1);
  });

  it('порядок валют: евро раньше злотых, злотые раньше рублей', () => {
    const stat = aggregateMonth('2026-09', [
      row({ id: '1', price: '100 RUB' }),
      row({ id: '2', price: '50 zł' }),
      row({ id: '3', price: '20 EUR' }),
    ]);
    expect(stat.prices.map((p) => p.currency)).toEqual(['EUR', 'PLN', 'RUB']);
  });

  it('пустой месяц — null', async () => {
    expect(await computeMonthStat(env, '2020-01')).toBeNull();
  });
});

describe('текст для поста', () => {
  const stat = aggregateMonth('2026-09', [
    row({ id: '1', price: '20 EUR' }),
    row({ id: '2', price: '30 EUR' }),
    row({ id: '3', type: 'request', price: 'бесплатно', source: 'site' }),
    row({ id: '4', type: 'request', price: 'договорная', source: 'site' }),
  ]);

  it('заголовок с месяцем в родительном падеже', () => {
    const text = statsPostText(stat);
    expect(text).toContain('Итоги сентября 2026');
    expect(text).toContain('4 объявления');
    expect(text).toContain('2 «водитель везёт» и 2 «нужно передать»');
    expect(text).toContain('из телеграм-чатов');
    expect(text).toContain('https://pop-utka.app');
  });

  it('средние цены по валютам — словами, чтобы пост можно было копировать', () => {
    const text = statsPostText(stat);
    expect(text).toContain('Средняя цена передачи:');
    expect(text).toContain('• евро — 25 по 2 объявлениям');
    expect(text).toContain('1 человек предложил передать бесплатно');
    expect(text).toContain('1 цену не указали');
  });

  it('текущий месяц помечен как незакрытый', () => {
    expect(statsPostText(stat, { month: 'current' })).toContain('пока месяц идёт');
  });

  it('свой адрес сайта подставляется', () => {
    expect(statsPostText(stat, { site: 'https://example.com' })).toContain('https://example.com');
  });

  it('короткая строка для админки', () => {
    expect(statsSummaryLine(stat)).toContain('сентябрь 2026: 4 заявки');
    expect(statsSummaryLine(stat)).toContain('25 EUR');
  });
});

describe('снимки итогов', () => {
  it('первый прогон сохраняет все месяцы из базы', async () => {
    db.rows.set('2026-08', [row({ id: '1' })]);
    db.rows.set('2026-09', [row({ id: '2' }), row({ id: '3' })]);
    const res = await refreshStats(env, { now: new Date('2026-09-17T12:00:00Z') });
    expect(res.saved.sort()).toEqual(['2026-08', '2026-09']);
    expect(res.months[0]!.month).toBe('2026-09');
    expect(res.months[0]!.total).toBe(2);
  });

  it('прошлый месяц не худеет, когда объявления удалил cron', async () => {
    db.rows.set('2026-08', [row({ id: '1' }), row({ id: '2' }), row({ id: '3' })]);
    await refreshStats(env, { now: new Date('2026-08-20T12:00:00Z') });
    expect(db.snapshots.get('2026-08')?.total).toBe(3);

    // сентябрь: август уже почистили, осталась одна строка
    db.rows.set('2026-08', [row({ id: '1' })]);
    db.rows.set('2026-09', [row({ id: '9' })]);
    db.saves = [];
    const res = await refreshStats(env, { now: new Date('2026-09-17T12:00:00Z') });
    expect(res.kept).toContain('2026-08');
    expect(db.snapshots.get('2026-08')?.total).toBe(3);
    expect(res.saved).toContain('2026-09');
  });

  it('текущий месяц пересчитывается всегда', async () => {
    db.rows.set('2026-09', [row({ id: '1' }), row({ id: '2' })]);
    await refreshStats(env, { now: new Date('2026-09-17T12:00:00Z') });
    db.rows.set('2026-09', [row({ id: '1' })]); // одно сняли за фейк
    const res = await refreshStats(env, { now: new Date('2026-09-18T12:00:00Z') });
    expect(res.saved).toContain('2026-09');
    expect(db.snapshots.get('2026-09')?.total).toBe(1);
  });

  it('force пересчитывает всё', async () => {
    db.rows.set('2026-08', [row({ id: '1' }), row({ id: '2' })]);
    await refreshStats(env, { now: new Date('2026-08-20T12:00:00Z') });
    db.rows.set('2026-08', [row({ id: '1' })]);
    const res = await refreshStats(env, { now: new Date('2026-09-17T12:00:00Z'), force: true });
    expect(res.saved).toContain('2026-08');
    expect(db.snapshots.get('2026-08')?.total).toBe(1);
  });

  it('побитый снимок пропускается, а не роняет страницу', async () => {
    db.snapshots.set('2026-07', { total: 5, payload: '{не json' });
    db.rows.set('2026-09', [row({ id: '1' })]);
    await refreshStats(env, { now: new Date('2026-09-17T12:00:00Z') });
    const months = await listMonthStats(env);
    expect(months.map((m) => m.month)).toEqual(['2026-09']);
  });

  it('месяцы идут свежими вперёд', async () => {
    db.rows.set('2026-07', [row({ id: '1' })]);
    db.rows.set('2026-09', [row({ id: '2' })]);
    db.rows.set('2026-08', [row({ id: '3' })]);
    await refreshStats(env, { now: new Date('2026-09-17T12:00:00Z') });
    const months = await listMonthStats(env);
    expect(months.map((m) => m.month)).toEqual(['2026-09', '2026-08', '2026-07']);
  });
});

describe('аналитическая заметка месяца', () => {
  const stat: import('../src/stats').MonthStat = {
    month: '2026-09', offers: 30, requests: 12, total: 42, cities: 18, directions: 25,
    topDirections: [
      { pair: 'Варшава → Минск', from: 'Варшава', to: 'Минск', count: 15 },
      { pair: 'Краков → Киев', from: 'Краков', to: 'Киев', count: 4 },
    ],
    fromChats: 35, fromSite: 7, priced: 20, free: 3,
    prices: [{ currency: 'EUR', count: 8, avg: 25, min: 10, max: 40 }],
    updatedAt: '2026-10-01T00:00:00Z',
  };

  it('шаблон говорит о направлениях и частоте, не выдумывая цифр', () => {
    const text = fallbackSummary(stat);
    expect(text).toContain('42');
    expect(text).toContain('Варшава → Минск');
    expect(text).toContain('36%');   // 15 из 42 — ядро месяца
    expect(text).toContain('Водителей на доске заметно больше');
    expect(text).toContain('бесплатно');
    // без markdown, живые абзацы
    expect(text).not.toMatch(/[*#]/);
    expect(text.split(/\n{2,}/).length).toBeGreaterThanOrEqual(2);
  });

  it('сравнение с прошлым месяцем — проценты и тренд', () => {
    const text = fallbackSummary(stat, { ...stat, month: '2026-08', total: 30, directions: 20 });
    expect(text).toContain('выросло на 40%');
    expect(text).toContain('август 2026');
  });

  it('refreshStats закрывает месяц заметкой (ИИ нет — шаблон), текущий не трогает', async () => {
    // август закрыт и без заметки, сентябрь ещё идёт
    db.rows.set('2026-08', [row(), row({ id: 'r2', fromCity: 'Краков', toCity: 'Киев' })]);
    db.rows.set('2026-09', [row(), row({ id: 'r3' }), row({ id: 'r4' })]);
    db.snapshots.set('2026-08', { total: 2, payload: JSON.stringify({ total: 2 }) });
    db.snapshots.set('2026-09', { total: 3, payload: JSON.stringify({ total: 3 }) });
    db.summarySaves = [];

    const res = await refreshStats(env, { now: new Date('2026-09-20T12:00:00Z') });
    expect(res.summaries).toEqual(['2026-08']);
    expect(db.summarySaves).toEqual(['2026-08']);
    // заметка сохранилась и не перезаписывается при следующем прогоне
    const again = await refreshStats(env, { now: new Date('2026-09-21T12:00:00Z') });
    expect(again.summaries).toEqual([]);
  });
});
