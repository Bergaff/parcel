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

import { handleTelegramUpdate, listingStatusNote, notifyAdminsRepeat } from '../src/telegram';
import type { Listing } from '../src/types';

const env = {
  BOT_TOKEN: 'test-token',
  ADMIN_IDS: '42',
  SITE_URL: 'https://pop-utka.app/',
  // мастер диалога хранится в KV: команде статистики он не нужен, но /help его сбрасывает
  KV: { get: async () => null, put: async () => undefined, delete: async () => undefined },
} as unknown as Env;

interface Sent { method: string; text: string; chatId: number }
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
      const body = JSON.parse(String(init?.body ?? '{}')) as { text?: string; chat_id?: number };
      sent.push({ method: m[1] ?? '', text: body.text ?? '', chatId: body.chat_id ?? 0 });
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

describe('ответ после создания заявки — по реальному статусу', () => {
  const mk = (over: Partial<Listing>): Listing => ({ status: 'pending', hidden: false, ...over } as Listing);

  it('отклонённый оффер без контакта объясняет, чего не хватило', () => {
    const note = listingStatusNote(mk({ status: 'rejected' }));
    expect(note).toContain('Не принято');
    expect(note).toContain('нет контакта');
  });

  it('скрытый «ищу передачу» — «подбираю попутчика», без слов про модерацию', () => {
    const note = listingStatusNote(mk({ status: 'published', hidden: true }));
    expect(note).toContain('Подбираю попутчика');
    expect(note).not.toContain('модерацию');
  });

  it('обычные статусы — как раньше', () => {
    expect(listingStatusNote(mk({ status: 'published' }))).toContain('Опубликовано');
    expect(listingStatusNote(mk({}))).toContain('модерацию');
  });
});

/** Память вместо D1: помним SQL и параметры каждого вызова.
 *  pendingRows/pendingTotal — что отвечает очередь модерации (/pending). */
function dbFake(opts: { pendingRows?: Array<Record<string, unknown>>; pendingTotal?: number } = {}) {
    // порядок колонок INSERT INTO listings из src/store.ts (createListing)
    const COLS = ['id', 'type', 'from_city', 'to_city', 'departure_date', 'recurring', 'weight_kg',
      'price', 'description', 'phone', 'telegram', 'status', 'source', 'source_chat', 'source_chat_id',
      'source_message_id', 'by_admin', 'hidden', 'created_at', 'published_at', 'from_city_lc',
      'to_city_lc', 'description_lc'];
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const make = (sql: string) => {
      const call = { sql, params: [] as unknown[] };
      calls.push(call);
      const stmt = {
        bind(...params: unknown[]) { call.params = params; return stmt; },
        async all() {
          // listPending: очередь модерации для /pending
          if (/WHERE status = \? ORDER BY created_at/i.test(sql)) {
            return { results: opts.pendingRows ?? [] };
          }
          return { results: [] };
        },
        async run() { return { meta: { changes: 1 } }; },
        // «прочитал только что вставленное»: createListing после INSERT делает
        // SELECT * FROM listings WHERE id = ? — собираем строку из его параметров
        async first() {
          // countPending: настоящее число очереди, без лимита выборки
          if (/COUNT\(\*\) AS n/i.test(sql)) return { n: opts.pendingTotal ?? 0 };
          if (/FROM listings WHERE id = /i.test(sql)) {
            const ins = [...calls].reverse().find((c) => c.sql.includes('INSERT INTO listings'));
            if (!ins) return null;
            const row: Record<string, unknown> = {};
            COLS.forEach((name, i) => { row[name] = ins.params[i]; });
            return row;
          }
          return null;
        },
      };
      return stmt;
    };
    return { db: { prepare: make, batch: async (s: unknown[]) => Promise.all(s as never) }, calls };
  }

describe('пересылка объявления без контакта — правила для всех источников', () => {

  function forward(text: string) {
    return {
      update_id: 1,
      message: {
        message_id: 10,
        date: 1789000000,
        chat: { id: 555, type: 'private' } as never,
        from: { id: 42 } as never,
        text,
        forward_from: { id: 111, first_name: 'Сергей' } as never,
      },
    };
  }

  it('оффер без контакта — rejected сразу: переславшему «не принято», модератору ни карточки', async () => {
    sent.length = 0;
    const { db, calls } = dbFake();
    const envFwd = { ...env, DB: db } as unknown as Env;
    await handleTelegramUpdate(envFwd, forward('Везу 5 января Гродно — Белосток, возьму посылку до 5 кг'));
    // заявка записана сразу отклонённой — в очереди модерации ей не место
    const insert = calls.find((c) => c.sql.includes('INSERT INTO listings'));
    expect(insert).toBeTruthy();
    expect(insert!.params).toContain('rejected');
    expect(insert!.params).not.toContain('pending');
    // переславшему — объяснение, а не «отправлено на модерацию»
    const reply = sent.filter((s) => s.chatId === 555).map((s) => s.text).join('\n');
    expect(reply).toContain('Не принято');
    expect(reply).toContain('нет контакта');
    expect(reply).not.toContain('модерацию');
    // модератору (42) — никаких карточек: ни обычной, ни «скрытой»
    expect(sent.filter((s) => s.chatId === 42)).toHaveLength(0);
  });

  it('«ищу передачу» без контакта — опубликована скрытой: админу карточка «Заявка без контакта»', async () => {
    sent.length = 0;
    const { db, calls } = dbFake();
    const envFwd = { ...env, DB: db } as unknown as Env;
    await handleTelegramUpdate(envFwd, forward('Нужно передать 5 января Гродно — Белосток, конверт с документами'));
    const insert = calls.find((c) => c.sql.includes('INSERT INTO listings'));
    expect(insert).toBeTruthy();
    expect(insert!.params).toContain('published');
    expect(insert!.params).toContain(1); // hidden
    // переславшему — «подбираю попутчика», без слов про модерацию
    const reply = sent.filter((s) => s.chatId === 555).map((s) => s.text).join('\n');
    expect(reply).toContain('Подбираю попутчика');
    // админу — карточка скрытой заявки с источником
    const card = sent.filter((s) => s.chatId === 42).map((s) => s.text).join('\n');
    expect(card).toContain('Заявка без контакта');
    expect(card).toContain('Опубликована автоматически, на доске скрыта');
  });
});

describe('/pending — настоящее число очереди', () => {
  it('заявок больше лимита выборки: счётчик из COUNT, а не из длины списка', async () => {
    sent.length = 0;
    const row = {
      id: 'p1', type: 'offer', from_city: 'Варшава', to_city: 'Минск', departure_date: '2027-01-05',
      description: 'везу посылки', telegram: null, phone: null, status: 'pending', source: 'telegram',
      source_chat: null, source_chat_id: null, source_message_id: null, by_admin: 0, hidden: 0,
      created_at: '2027-01-01 00:00:00', published_at: null,
    };
    const { db } = dbFake({ pendingRows: [row, row, row], pendingTotal: 137 });
    await handleTelegramUpdate({ ...env, DB: db } as unknown as Env, {
      update_id: 1,
      message: {
        message_id: 11,
        date: 1789000000,
        chat: { id: 42, type: 'private' } as never,
        from: { id: 42 } as never,
        text: '/pending',
      },
    });
    const reply = sent.map((s) => s.text).join('\n');
    // раньше здесь было бы 3 — по длине выборки
    expect(reply).toContain('Необработано заявок: <b>137</b>');
    expect(reply).toContain('Показаны последние 10');
  });

  it('пустая очередь — по COUNT, а не по выборке', async () => {
    sent.length = 0;
    const { db } = dbFake({ pendingRows: [], pendingTotal: 0 });
    await handleTelegramUpdate({ ...env, DB: db } as unknown as Env, {
      update_id: 1,
      message: {
        message_id: 12,
        date: 1789000000,
        chat: { id: 42, type: 'private' } as never,
        from: { id: 42 } as never,
        text: '/pending',
      },
    });
    expect(sent[0]!.text).toContain('Необработанных заявок нет');
  });
});

describe('антишторм карточек повтора', () => {
  it('об одной заявке — не чаще карточки в 6 часов, о другой — сразу', async () => {
    sent.length = 0;
    const store = new Map<string, string>();
    const kv = {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v); },
    };
    const envR = { ...env, KV: kv } as unknown as Env;
    const l = { id: 'repeat-1', fromCity: 'Бяла', toCity: 'Брест', status: 'published' } as Listing;
    await notifyAdminsRepeat(envR, l, 'тот же контакт');
    expect(sent.length).toBe(1);
    // тот же репост через 10 минут — второй карточки нет
    await notifyAdminsRepeat(envR, l, 'тот же контакт');
    expect(sent.length).toBe(1);
    // о другой заявке — карточка уходит сразу
    await notifyAdminsRepeat(envR, { ...l, id: 'repeat-2' }, 'тот же контакт');
    expect(sent.length).toBe(2);
  });
});
