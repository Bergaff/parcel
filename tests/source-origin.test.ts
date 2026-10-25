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

import { formatListing, handleTelegramUpdate, listingSourceLink, parseOriginLink } from '../src/telegram';
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

describe('parseOriginLink — ссылка-ответ радара', () => {
  it('публичный чат с темой и без', () => {
    expect(parseOriginLink('https://t.me/granica_BY_LT_PL/153043/153048')).toEqual({
      username: 'granica_BY_LT_PL', chatId: null, threadId: 153043, messageId: 153048,
    });
    expect(parseOriginLink('t.me/granica_BY_LT_PL/153048')).toEqual({
      username: 'granica_BY_LT_PL', chatId: null, threadId: null, messageId: 153048,
    });
  });

  it('приватная супергруппа: t.me/c/<id>/… → внутренний id чата', () => {
    expect(parseOriginLink('https://t.me/c/1234567890/55/42')).toEqual({
      username: null, chatId: '-1001234567890', threadId: 55, messageId: 42,
    });
    expect(parseOriginLink('https://t.me/c/1234567890/42')).toEqual({
      username: null, chatId: '-1001234567890', threadId: null, messageId: 42,
    });
  });

  it('веб-превью канала t.me/s/…', () => {
    expect(parseOriginLink('https://t.me/s/granica_BY_LT_PL/42')).toEqual({
      username: 'granica_BY_LT_PL', chatId: null, threadId: null, messageId: 42,
    });
  });

  it('не ссылки: диплинк бота, голый username, текст вокруг ссылки, мусор', () => {
    expect(parseOriginLink('https://t.me/parcel_transfer_bot?start=watch_1')).toBeNull();
    expect(parseOriginLink('https://t.me/granica_BY_LT_PL')).toBeNull();
    expect(parseOriginLink('смотри https://t.me/granica_BY_LT_PL/1/2')).toBeNull();
    expect(parseOriginLink('https://t.me/c/abc/12')).toBeNull();
    expect(parseOriginLink('Нужно передать 5 января Гродно — Белосток')).toBeNull();
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

  it('названия чата нет, ссылка есть (текстовая копия): «Источник» показывает ссылку', () => {
    const card = formatListing(listing({ sourceChat: null }));
    expect(card).toContain('Источник: <a href="https://t.me/granica_BY_LT_PL/153043/153048">исходное сообщение</a>');
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

/** Текст, который правила разбирают уверенно (без ИИ). */
const TEXT = 'Нужно передать 5 января Гродно — Белосток, конверт с документами, писать @serg';

describe('intake — происхождение из сообщения', () => {

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


/* ------------------------------------------------------------------ */
/* Ссылка-ответ радара: состояние базы и полный поток                    */
/* ------------------------------------------------------------------ */

/** D1 с памятью: tg_seen и listings живут между вызовами, UPDATE применяется. */
function statefulDb() {
  const calls: Call[] = [];
  const seen = new Map<string, string | null>(); // «chat_id|message_id» → listing_id
  const listings = new Map<string, Record<string, unknown>>();
  const make = (sql: string) => {
    const call: Call = { sql, params: [] };
    calls.push(call);
    const stmt = {
      bind(...params: unknown[]) { call.params = params; return stmt; },
      async all() {
        // все колонки уже есть — ALTER не нужен
        if (/PRAGMA table_info/.test(sql)) return { results: COLS.map((name) => ({ name })) };
        return { results: [] };
      },
      async run() {
        if (/INSERT OR IGNORE INTO tg_seen/.test(sql)) {
          const key = `${call.params[0]}|${call.params[1]}`;
          if (seen.has(key)) return { meta: { changes: 0 } };
          seen.set(key, null);
          return { meta: { changes: 1 } };
        }
        if (/UPDATE tg_seen SET listing_id/.test(sql)) {
          seen.set(`${call.params[1]}|${call.params[2]}`, String(call.params[0]));
          return { meta: { changes: 1 } };
        }
        if (/DELETE FROM tg_seen/.test(sql)) {
          seen.delete(`${call.params[0]}|${call.params[1]}`);
          return { meta: { changes: 1 } };
        }
        if (/INSERT INTO listings/.test(sql)) {
          const row: Record<string, unknown> = {};
          COLS.forEach((name, i) => { row[name] = call.params[i]; });
          listings.set(String(row.id), row);
          return { meta: { changes: 1 } };
        }
        if (/UPDATE listings SET/.test(sql)) {
          const id = String(call.params[call.params.length - 1]);
          const row = listings.get(id);
          if (!row) return { meta: { changes: 0 } };
          const names = /SET (.+) WHERE id/.exec(sql)![1]!
            .split(',').map((p) => p.trim().replace(/ = \?$/, ''));
          names.forEach((name, i) => { row[name] = call.params[i]; });
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 1 } };
      },
      async first() {
        if (/COUNT\(\*\) AS n/i.test(sql)) return { n: 0 };
        if (/SELECT listing_id FROM tg_seen/.test(sql)) {
          const id = seen.get(`${call.params[0]}|${call.params[1]}`);
          return id ? { listing_id: id } : null;
        }
        if (/FROM listings WHERE id = /i.test(sql)) return listings.get(String(call.params[0])) ?? null;
        return null;
      },
    };
    return stmt;
  };
  return {
    db: { prepare: make, batch: async (s: unknown[]) => Promise.all(s as never) },
    calls, seen, listings,
  };
}

/** Ответ радара: отдельное сообщение-reply, в тексте только ссылка. */
function linkReply(messageId: number, replyTo: number, link: string) {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date: 1789000001,
      chat: { id: 555, type: 'private' } as never,
      from: { id: 42 } as never,
      text: link,
      reply_to_message: { message_id: replyTo } as never,
    },
  };
}

describe('ссылка-ответ радара', () => {
  it('пересылка + ответ: тема и username чата дописываются в заявку, бот молчит', async () => {
    const { db, calls, listings, seen } = statefulDb();
    const env = { ...baseEnv, DB: db } as unknown as Env;
    // защищённый чат: в forward_origin нет username, тему Bot API не отдаёт
    await handleTelegramUpdate(env, {
      update_id: 1,
      message: {
        message_id: 900,
        date: 1789000000,
        chat: { id: 555, type: 'private' } as never,
        from: { id: 42 } as never,
        text: TEXT,
        forward_origin: {
          type: 'message',
          date: 1788990000,
          chat: { id: -1001234567890, type: 'supergroup', title: 'Граница BY-LT-PL' } as never,
          message_id: 153048,
        } as never,
      },
    });
    const ins = calls.find((c) => c.sql.includes('INSERT INTO listings'));
    expect(ins).toBeTruthy();
    const id = String(ins!.params[0]);
    expect(ins!.params[16]).toBeNull(); // source_chat_username — из пересылки неизвестен
    expect(ins!.params[17]).toBeNull(); // source_thread_id — Bot API тему не отдал
    // связь «сообщение в личке → заявка» запомнена
    expect(seen.get('pm:555|900')).toBe(id);

    sent.length = 0;
    await handleTelegramUpdate(env, linkReply(901, 900, 'https://t.me/granica_BY_LT_PL/153043/153048'));

    const upd = calls.find((c) => /UPDATE listings SET/.test(c.sql));
    expect(upd, 'происхождение заявки обновлено').toBeTruthy();
    expect(upd!.sql).toContain('source_chat_username = ?');
    expect(upd!.sql).toContain('source_thread_id = ?');
    expect(upd!.params).toEqual(['granica_BY_LT_PL', 153043, 153048, id]);
    const row = listings.get(id)!;
    expect(row.source_chat_username).toBe('granica_BY_LT_PL');
    expect(row.source_thread_id).toBe(153043);
    expect(row.source_message_id).toBe(153048);
    // на саму ссылку бот ничего не отвечает
    expect(sent).toHaveLength(0);
  });

  it('текстовая копия из защищённого чата: приватная ссылка t.me/c дописывает чат и тему', async () => {
    const { db, calls, listings, seen } = statefulDb();
    const env = { ...baseEnv, DB: db } as unknown as Env;
    // копия без forward-флагов: заявка «из личного сообщения»
    await handleTelegramUpdate(env, {
      update_id: 1,
      message: {
        message_id: 800,
        date: 1789000000,
        chat: { id: 555, type: 'private' } as never,
        from: { id: 42 } as never,
        text: TEXT,
      },
    });
    const ins = calls.find((c) => c.sql.includes('INSERT INTO listings'));
    expect(ins, 'копия распознана и создана').toBeTruthy();
    const id = String(ins!.params[0]);
    expect(seen.get('555|800')).toBe(id);

    sent.length = 0;
    await handleTelegramUpdate(env, linkReply(801, 800, 'https://t.me/c/1234567890/55/42'));

    const upd = calls.find((c) => /UPDATE listings SET/.test(c.sql));
    expect(upd).toBeTruthy();
    expect(upd!.params).toEqual([55, 42, '-1001234567890', id]); // тема, сообщение, чат
    const row = listings.get(id)!;
    expect(row.source_thread_id).toBe(55);
    expect(row.source_chat_id).toBe('-1001234567890');
    expect(sent).toHaveLength(0);
  });

  it('ответ на незнакомое сообщение: молча глотается, ничего не меняет', async () => {
    const { db, calls } = statefulDb();
    const env = { ...baseEnv, DB: db } as unknown as Env;
    sent.length = 0;
    await handleTelegramUpdate(env, linkReply(910, 123456, 'https://t.me/granica_BY_LT_PL/1/2'));
    expect(calls.find((c) => /UPDATE listings SET/.test(c.sql))).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it('ссылка-ответ не попадает в мастера: город из неё не спрашивают', async () => {
    const { db, calls } = statefulDb();
    // активный мастер ждёт город — раньше голая ссылка упала бы в его шаг
    const kvWizard = {
      get: async () => JSON.stringify({ step: 'from', draft: { type: 'request' } }),
      put: async () => undefined, delete: async () => undefined,
    };
    const env = { ...baseEnv, DB: db, KV: kvWizard } as unknown as Env;
    sent.length = 0;
    await handleTelegramUpdate(env, linkReply(920, 900, 'https://t.me/granica_BY_LT_PL/1/2'));
    // ссылку поглотил перехват: ни ответа мастера, ни записей в базу
    expect(sent.map((x) => x.text).join('\n')).toBe('');
    expect(calls.find((c) => /UPDATE listings SET/.test(c.sql))).toBeUndefined();
  });
});
