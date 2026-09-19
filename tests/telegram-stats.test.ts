/**
 * Бот-команда /статистика: админ получает готовый текст поста.
 *
 * Telegram API здесь подменён — проверяем, что именно улетает в чат:
 * цифры, средние цены по валютам и текст в <pre> (его удобно копировать).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../src/types';
import type { MonthStat } from '../src/stats';

const db = vi.hoisted(() => ({
  months: [] as MonthStat[],
  refreshes: 0,
  forced: [] as boolean[],
}));

vi.mock('../src/stats', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/stats')>();
  return {
    ...real, // statsPostText остаётся настоящим — проверяем реальный текст
    listMonthStats: async () => db.months,
    refreshStats: async (_env: unknown, opts: { force?: boolean } = {}) => {
      db.refreshes += 1;
      db.forced.push(opts.force === true);
      return { saved: db.months.map((m) => m.month), kept: [], months: db.months };
    },
  };
});

import { handleTelegramUpdate } from '../src/telegram';

const env = {
  BOT_TOKEN: 'test-token',
  ADMIN_IDS: '42',
  SITE_URL: 'https://pop-utka.app/',
  // мастер диалога хранится в KV: команде статистики он не нужен, но /help его сбрасывает
  KV: { get: async () => null, put: async () => undefined, delete: async () => undefined },
} as unknown as Env;

interface Sent { method: string; text: string }
const sent: Sent[] = [];
const realFetch = global.fetch;

function month(over: Partial<MonthStat> = {}): MonthStat {
  return {
    month: '2026-09',
    offers: 9,
    requests: 2,
    total: 11,
    cities: 7,
    directions: 7,
    topDirections: [{ pair: 'Варшава → Минск', from: 'Варшава', to: 'Минск', count: 4 }],
    fromChats: 10,
    fromSite: 1,
    priced: 10,
    free: 1,
    prices: [
      { currency: 'EUR', count: 3, avg: 25, min: 20, max: 30 },
      { currency: 'BYN', count: 5, avg: 32, min: 30, max: 40 },
    ],
    updatedAt: '2026-09-17 10:00:00',
    ...over,
  } as MonthStat;
}

async function send(text: string, fromId = 42) {
  sent.length = 0;
  await handleTelegramUpdate(env, {
    update_id: 1,
    message: {
      message_id: 7,
      date: 1789000000,
      chat: { id: fromId, type: 'private' } as never,
      from: { id: fromId } as never,
      text,
    },
  });
  return sent.map((s) => s.text).join('\n');
}

beforeEach(() => {
  db.months = [month()];
  db.refreshes = 0;
  db.forced = [];
  sent.length = 0;
  global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
    const m = /api\.telegram\.org\/bot[^/]+\/(\w+)/.exec(u);
    if (m) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { text?: string };
      sent.push({ method: m[1] ?? '', text: body.text ?? '' });
      return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return realFetch(url as never, init);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = realFetch;
});

describe('/статистика', () => {
  it('админ получает готовый текст поста', async () => {
    const text = await send('/статистика');
    expect(text).toContain('Считаю итоги');
    expect(text).toContain('сентябрь 2026');
    expect(text).toContain('11 объявлений');
    expect(text).toContain('9 «везут» и 2 «нужно передать»');
    expect(text).toContain('Текст ниже готов к публикации');
  });

  it('сам пост приходит блоком <pre> — копируется без разметки', async () => {
    const text = await send('/статистика');
    expect(text).toContain('<pre>');
    // текущий месяц подписан как незакрытый — «Итоги …» будет после закрытия
    expect(text).toContain('сентябрь 2026 на доске «попутка.» — пока месяц идёт');
    expect(text).toContain('• евро — 25 по 3 объявлениям');
    expect(text).toContain('• белорусских рублей — 32 по 5 объявлениям');
    expect(text).toContain('https://pop-utka.app');
    // адрес сайта без лишнего слэша
    expect(text).not.toContain('pop-utka.app//');
  });

  it('текст поста экранирован для HTML-режима Telegram', async () => {
    db.months = [month({ topDirections: [{ pair: 'Минск <b>→</b> Вильнюс', from: 'Минск', to: 'Вильнюс', count: 2 }] })];
    const text = await send('/статистика');
    expect(text).not.toContain('Минск <b>→</b>');
    expect(text).toContain('&lt;b&gt;');
  });

  it('«прошлый» берёт последний закрытый месяц', async () => {
    db.months = [month(), month({ month: '2026-08', total: 20, offers: 12, requests: 8 })];
    const text = await send('/статистика прошлый');
    expect(text).toContain('Итоги августа 2026');
    expect(text).toContain('20 объявлений');
    expect(text).not.toContain('месяц ещё идёт');
  });

  it('текущий месяц помечен как незакрытый', async () => {
    const text = await send('/статистика');
    expect(text).toContain('месяц ещё идёт');
  });

  it('«force» пересчитывает все месяцы', async () => {
    await send('/статистика force');
    expect(db.refreshes).toBe(1);
    expect(db.forced).toEqual([true]);
  });

  it('обычный запуск пересчитывает без force', async () => {
    await send('/статистика');
    expect(db.forced).toEqual([false]);
  });

  it('не админ — вежливый отказ и никаких цифр', async () => {
    const text = await send('/статистика', 7);
    expect(text).toContain('команда администратора');
    expect(text).not.toContain('объявлений');
    expect(db.refreshes).toBe(0);
  });

  it('пустая база — честно пишет, что считать нечего', async () => {
    db.months = [];
    const text = await send('/статистика');
    expect(text).toContain('Пока считать нечего');
  });

  it('рядом — кликабельная ссылка на страницу месяца', async () => {
    const text = await send('/статистика');
    expect(text).toContain('<a href="https://pop-utka.app/itogi/2026-09">итоги сентября 2026 на сайте</a>');
    expect(text).toContain('ссылка уже в конце поста');
    // та же ссылка — простым текстом в конце самого поста
    expect(text).toContain('Направления и подробности месяца: https://pop-utka.app/itogi/2026-09');
  });

  it('«прошлый» — ссылка на страницу закрытого месяца', async () => {
    db.months = [month(), month({ month: '2026-08', total: 20, offers: 12, requests: 8 })];
    const text = await send('/статистика прошлый');
    expect(text).toContain('<a href="https://pop-utka.app/itogi/2026-08">итоги августа 2026 на сайте</a>');
  });

  it('команду знают и по коротким названиям', async () => {
    expect(await send('/итоги')).toContain('сентябрь 2026');
    expect(await send('/stats')).toContain('сентябрь 2026');
  });

  it('/help рассказывает про команду', async () => {
    const text = await send('/help');
    expect(text).toContain('/статистика');
    expect(text).toContain('итоги месяца');
  });
});
