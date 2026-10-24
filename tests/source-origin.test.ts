/**
 * Происхождение заявки: откуда взялось сообщение.
 *
 * Данные «что откуда» — для админов: в админ-панели и в карточках модератору
 * видна ссылка на исходное сообщение (t.me/<чат>/<тема>/<сообщение> для
 * публичных чатов, t.me/c/… для приватных). В сообщения для людей (общие чаты,
 * ответы авторам) provenance не попадает. Исключение — когда в карточке вообще
 * нет контакта (ни в полях, ни в тексте): тогда ссылка на исходное сообщение
 * остаётся, это единственный способ связаться с человеком.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { formatListing, handleTelegramUpdate, listingSourceLink } from '../src/telegram';
import { createListing, publicListing } from '../src/store';
import type { Env, Listing } from '../src/types';

/* ------------------------------------------------------------------ */
/* listingSourceLink: формат ссылки на исходное сообщение               */
/* ------------------------------------------------------------------ */

describe('listingSourceLink — ссылка на исходное сообщение', () => {
  it('публичный чат с темой форума: t.me/<чат>/<тема>/<сообщение>', () => {
    expect(listingSourceLink('-1001234567890', 153048, 'granica_BY_LT_PL', 153043))
      .toBe('https://t.me/granica_BY_LT_PL/153043/153048');
  });

  it('публичный чат без темы: t.me/<чат>/<сообщение>', () => {
    expect(listingSourceLink('-1001234567890', 42, 'granica_BY_LT_PL', null))
      .toBe('https://t.me/granica_BY_LT_PL/42');
  });

  it('приватная супергруппа: t.me/c/… (открывается у участников)', () => {
    expect(listingSourceLink('-1001234567890', 42, null, 5))
      .toBe('https://t.me/c/1234567890/42');
  });

  it('пересылка от человека и обычные чаты — без ссылки', () => {
    expect(listingSourceLink(null, 5, null, null)).toBeNull();
    expect(listingSourceLink('555', 5, null, null)).toBeNull();
  });

  it('username без id сообщения: ссылка на чат невозможна — t.me/c без хвоста', () => {
    expect(listingSourceLink('-1001234567890', null, 'granica_BY_LT_PL', null))
      .toBe('https://t.me/c/1234567890');
  });
});

/* ------------------------------------------------------------------ */
/* formatListing: кому видно происхождение                              */
/* ------------------------------------------------------------------ */

function listing(over: Partial<Listing> = {}): Listing {
  return {
    id: 'aaaaaaaa-1111-2222-3333-444444444444',
    type: 'request',
    fromCity: 'Гродно',
    toCity: 'Белосток',
    departureDate: '2027-01-05',
    recurring: null,
    weightKg: null,
    price: null,
    description: 'Нужно передать конверт с документами',
    phone: null,
    telegram: '@serg',
    status: 'pending',
    source: 'telegram',
    sourceChat: 'Граница BY-LT-PL',
    sourceChatId: '-1001234567890',
    sourceMessageId: 153048,
    sourceChatUsername: 'granica_BY_LT_PL',
    sourceThreadId: 153043,
    byAdmin: false,
    fromPerson: false,
    hidden: false,
    pinnedUntil: null,
    createdAt: '2026-10-24 10:00:00',
    publishedAt: null,
    views: 0,
    ...over,
  } as Listing;
}

describe('formatListing — происхождение видно админам, а не чатам', () => {
  it('админу: строка «Источник» со ссылкой на сообщение в публичном чате', () => {
    const card = formatListing(listing());
    expect(card).toContain('Источник: чат «Граница BY-LT-PL»');
    expect(card).toContain('https://t.me/granica_BY_LT_PL/153043/153048');
  });

  it('в общий чат: контакта хватает — строки «Источник» и ссылки нет', () => {
    const card = formatListing(listing(), '', 'chat');
    expect(card).not.toContain('Источник');
    expect(card).not.toContain('t.me/');
  });

  it('исключение: контакта нет ни в полях, ни в тексте — ссылку видно и в чате', () => {
    const card = formatListing(listing({ telegram: null, phone: null }), '', 'chat');
    expect(card).toContain('Источник: чат «Граница BY-LT-PL»');
    expect(card).toContain('https://t.me/granica_BY_LT_PL/153043/153048');
  });

  it('контакт только в тексте описания — этого достаточно, источник в чат не уходит', () => {
    const byPhone = formatListing(
      listing({ telegram: null, phone: null, description: 'Перезвоните +48 555 111 222, конверт' }),
      '', 'chat');
    expect(byPhone).not.toContain('Источник');
    const byUsername = formatListing(
      listing({ telegram: null, phone: null, description: 'Пишите в тг @petrov, конверт' }),
      '', 'chat');
    expect(byUsername).not.toContain('Источник');
  });

  it('пересылка от человека: подпись без ссылки, и в чате её нет (контакт есть)', () => {
    const fwd = listing({
      sourceChat: 'Переслано от Сергей',
      sourceChatId: null, sourceMessageId: 10,
      sourceChatUsername: null, sourceThreadId: null,
    });
    expect(formatListing(fwd)).toContain('Источник: Переслано от Сергей');
    expect(formatListing(fwd)).not.toContain('<a href');
    expect(formatListing(fwd, '', 'chat')).not.toContain('Источник');
  });
});

/* ------------------------------------------------------------------ */
/* Хранение: createListing пишет происхождение и сам добавляет колонки  */
/* ------------------------------------------------------------------ */

interface Call { sql: string; params: unknown[] }

/** Порядок колонок INSERT INTO listings из src/store.ts (createListing). */
const COLS = ['id', 'type', 'from_city', 'to_city', 'departure_date', 'recurring', 'weight_kg',
  'price', 'description', 'phone', 'telegram', 'status', 'source', 'source_chat', 'source_chat_id',
  'source_message_id', 'source_chat_username', 'source_thread_id',
  'by_admin', 'hidden', 'created_at', 'published_at', 'from_city_lc',
  'to_city_lc', 'description_lc', 'reject_reason'];

/** D1-подделка: PRAGMA «колонок нет» (воркер добавит сам), строка — из параметров INSERT. */
function fakeDb() {
  const calls: Call[] = [];
  const make = (sql: string) => {
    const call: Call = { sql, params: [] };
    calls.push(call);
    const stmt = {
      bind(...params: unknown[]) { call.params = params; return stmt; },
      async all() { return { results: [] }; },
      async run() { return { meta: { changes: 1 } }; },
      async first() {
        if (/COUNT\(\*\) AS n/i.test(sql)) return { n: 0 };
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

const baseEnv = {
  BOT_TOKEN: 'test-token',
  ADMIN_IDS: '42',
  SITE_URL: 'https://pop-utka.app/',
  KV: { get: async () => null, put: async () => undefined, delete: async () => undefined },
} as unknown as Env;

describe('createListing — происхождение в базе', () => {
  it('колонок ещё нет: воркер добавляет их сам, INSERT пишет username чата и тему', async () => {
    const { db, calls } = fakeDb();
    const env = { ...baseEnv, DB: db } as unknown as Env;
    const saved = await createListing(env, {
      type: 'request',
      fromCity: 'Гродно',
      toCity: 'Белосток',
      departureDate: '2027-01-05',
      description: 'Нужно передать конверт с документами, пишите @serg',
      telegram: '@serg',
      status: 'pending',
      source: 'telegram',
      sourceChat: 'Граница BY-LT-PL',
      sourceChatId: '-1001234567890',
      sourceMessageId: 153048,
      sourceChatUsername: 'granica_BY_LT_PL',
      sourceThreadId: 153043,
    });

    // само-миграция: обе колонки добавлены ALTER'ом до записи
    const alters = calls.map((c) => c.sql).filter((s) => /ALTER TABLE listings ADD COLUMN/.test(s));
    expect(alters.some((s) => s.includes('source_chat_username'))).toBe(true);
    expect(alters.some((s) => s.includes('source_thread_id'))).toBe(true);

    // INSERT: колонки на месте, значения — на своих позициях
    const ins = calls.find((c) => c.sql.includes('INSERT INTO listings'));
    expect(ins).toBeTruthy();
    expect(ins!.sql).toContain('source_chat_username, source_thread_id');
    expect(ins!.params[16]).toBe('granica_BY_LT_PL');
    expect(ins!.params[17]).toBe(153043);

    // прочитанная обратно заявка несёт происхождение (mapRow)
    expect(saved.sourceChatUsername).toBe('granica_BY_LT_PL');
    expect(saved.sourceThreadId).toBe(153043);
  });
});

describe('publicListing — публичный ответ без provenance', () => {
  it('номер сообщения, username чата и тема срезаются, подпись чата остаётся', () => {
    const pub = publicListing(listing());
    expect(pub.sourceMessageId).toBeNull();
    expect(pub.sourceChatUsername).toBeNull();
    expect(pub.sourceThreadId).toBeNull();
    // название и id чата нужны публично: подпись «из чата …» и ссылка админа
    expect(pub.sourceChat).toBe('Граница BY-LT-PL');
    expect(pub.sourceChatId).toBe('-1001234567890');
  });
});

/* ------------------------------------------------------------------ */
/* Intake: поля приезжают из самого сообщения Telegram                  */
/* ------------------------------------------------------------------ */

interface Sent { method: string; text: string; chatId: number }
const sent: Sent[] = [];
const realFetch = global.fetch;

beforeEach(() => {
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

describe('intake — происхождение из сообщения', () => {
  const TEXT = 'Нужно передать 5 января Гродно — Белосток, конверт с документами, писать @serg';

  it('сообщение в форуме: username чата и тема уезжают в заявку', async () => {
    const { db, calls } = fakeDb();
    const env = { ...baseEnv, DB: db } as unknown as Env;
    await handleTelegramUpdate(env, {
      update_id: 1,
      message: {
        message_id: 153048,
        date: 1789000000,
        chat: { id: -1001234567890, type: 'supergroup', is_forum: true, title: 'Граница BY-LT-PL', username: 'granica_BY_LT_PL' } as never,
        from: { id: 7, username: 'ivan' } as never,
        text: TEXT,
        message_thread_id: 153043,
      },
    });
    const ins = calls.find((c) => c.sql.includes('INSERT INTO listings'));
    expect(ins).toBeTruthy();
    expect(ins!.params[14]).toBe('-1001234567890'); // source_chat_id
    expect(ins!.params[15]).toBe(153048); // source_message_id
    expect(ins!.params[16]).toBe('granica_BY_LT_PL'); // source_chat_username
    expect(ins!.params[17]).toBe(153043); // source_thread_id
  });

  it('пересылка из публичного чата в личку: username чата-источника сохраняется', async () => {
    const { db, calls } = fakeDb();
    const env = { ...baseEnv, DB: db } as unknown as Env;
    await handleTelegramUpdate(env, {
      update_id: 1,
      message: {
        message_id: 10,
        date: 1789000000,
        chat: { id: 555, type: 'private' } as never,
        from: { id: 42 } as never,
        text: TEXT,
        forward_origin: {
          type: 'message',
          date: 1788990000,
          sender_chat: { id: -1001234567890, type: 'channel', title: 'Граница BY-LT-PL', username: 'granica_BY_LT_PL' } as never,
          chat: { id: -1001234567890, type: 'supergroup', title: 'Граница BY-LT-PL', username: 'granica_BY_LT_PL' } as never,
          message_id: 153048,
        } as never,
      },
    });
    const ins = calls.find((c) => c.sql.includes('INSERT INTO listings'));
    expect(ins).toBeTruthy();
    expect(ins!.params[16]).toBe('granica_BY_LT_PL');
    expect(ins!.params[17]).toBeNull(); // темы у пересылок нет
  });
});
