/**
 * «Нечеловеческие» контакты (v0.4.57): ник чата-источника, аккаунт радара и
 * сам бот не могут быть автором заявки.
 *
 * История: в защищённых чатах (запрещена пересылка) радар шлёт боту текстовую
 * копию и оставляет ссылку на исходное сообщение. Старый парсер делал из
 * ссылки t.me/чат/12345 контакт @чат, а сайт подставлял ник отправителя
 * (радара) — в отчёте «чьи юзернеймы» наверху оказались @granica_belarus_chat
 * (37 заявок) и аккаунт радара (16). Писать по таким «контактам» — не значит
 * написать автору.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../src/types';
import { parseTelegramMessage } from '../src/parser';
import { handleTelegramUpdate, radarUsernames, validContact } from '../src/telegram';
import { autoStatusFor, scrubContactUsernames, updateSourceOrigin } from '../src/store';

/* ------------------------- парсер: ссылки ------------------------- */

describe('ссылка на сообщение — не контакт', () => {
  it('t.me/чат/12345 (копия радара из защищённого чата) контактом не становится', () => {
    const p = parseTelegramMessage(
      'Нужно передать 5 января Гродно — Белосток, конверт с документами, ссылка https://t.me/granica_belarus_chat/153043/153048'
    );
    expect(p.telegram).toBeNull();
    // что ссылка остаётся в тексте заявки — проверяет полный поток ниже
  });

  it('голая ссылка t.me/человек — по-прежнему контакт', () => {
    const p = parseTelegramMessage('Варшава — Краков, https://t.me/trasher завтра возьму');
    expect(p.telegram).toBe('@trasher');
  });

  it('сначала ссылка-на-сообщение, потом настоящий ник — возьмётся ник', () => {
    const p = parseTelegramMessage('Минск-Брест завтра возьму посылку, t.me/chat_name/12345, писать @driver77');
    expect(p.telegram).toBe('@driver77');
  });

  it('инвайт t.me/+… — не контакт', () => {
    const p = parseTelegramMessage('Гродно — Белосток 5 января, вступайте https://t.me/+AbCdEfGhIjKlMn');
    expect(p.telegram).toBeNull();
  });
});

/* ------------------------ validContact ------------------------ */

const envWith = { BOT_USERNAME: 'parcel_transfer_bot', RADAR_USERNAMES: 'Daniil06496, @second' } as Env;

describe('validContact — запрещённые ники', () => {
  it('регистр и «@» не важны', () => {
    expect(validContact(envWith, '@Granica_Chat', ['granica_chat'])).toBeNull();
    expect(validContact(envWith, 'granica_chat', ['@Granica_Chat'])).toBeNull();
  });
  it('настоящий человек проходит', () => {
    expect(validContact(envWith, '@driver77', ['granica_chat', 'parcel_transfer_bot'])).toBe('@driver77');
    expect(validContact(envWith, null, ['x'])).toBeNull();
  });
  it('radarUsernames: из строки, без «@» и пустых', () => {
    expect(radarUsernames(envWith)).toEqual(['Daniil06496', 'second']);
    expect(radarUsernames({} as Env)).toEqual([]);
  });
});

/* ------------------------ autoStatusFor ------------------------ */

describe('просьба без контакта, но со ссылкой в тексте — не прячем', () => {
  it('ссылка на исходное сообщение — способ связаться', () => {
    expect(autoStatusFor(
      { type: 'request', description: 'передайте конверт, ссылка t.me/chat_name/123' },
      { telegram: null, phone: null }
    )).toBeNull();
  });
  it('совсем без контакта — как раньше: публикуем скрытой', () => {
    expect(autoStatusFor(
      { type: 'request', description: 'передайте конверт' },
      { telegram: null, phone: null }
    )).toEqual({ status: 'published', hidden: true });
  });
});

/* -------------------- ссылка-ответ радара -------------------- */

/** Порядок колонок INSERT INTO listings (30). */
const COLS = ['id', 'type', 'from_city', 'to_city', 'departure_date', 'recurring', 'weight_kg',
  'price', 'description', 'phone', 'telegram', 'status', 'source', 'source_chat', 'source_chat_id',
  'source_message_id', 'source_chat_username', 'source_thread_id',
  'by_admin', 'hidden', 'created_at', 'published_at', 'from_city_lc',
  'to_city_lc', 'description_lc', 'reject_reason',
  'stops', 'route_lc', 'from_stops_lc', 'to_stops_lc'];

interface Call { sql: string; params: unknown[] }

function captureDb(changes = 1) {
  const calls: Call[] = [];
  const make = (sql: string) => {
    const call: Call = { sql, params: [] };
    calls.push(call);
    const stmt = {
      bind(...params: unknown[]) { call.params = params; return stmt; },
      async run() { return { meta: { changes } }; },
      async all() {
        if (/PRAGMA table_info/.test(sql)) return { results: COLS.map((name) => ({ name })) };
        return { results: [] };
      },
      async first() { return null; },
    };
    return stmt;
  };
  const env = { DB: { prepare: make, batch: async (s: unknown[]) => Promise.all(s as never) } } as unknown as Env;
  return { env, calls };
}

describe('updateSourceOrigin — ник чата стирается из контакта', () => {
  it('публичная ссылка: отдельный UPDATE обнуляет telegram, совпавший с ником чата', async () => {
    const { env, calls } = captureDb();
    const ok = await updateSourceOrigin(env, 'id1', { username: 'granica_BY_LT_PL', threadId: 153043, messageId: 153048 });
    expect(ok).toBe(true);
    const scrub = calls.find((c) => c.sql.includes('SET telegram = NULL'));
    expect(scrub, 'чистка контакта отдельным запросом').toBeTruthy();
    expect(scrub!.params).toEqual(['id1', 'granica_by_lt_pl', 'granica_by_lt_pl']);
  });
  it('приватная ссылка t.me/c (без username) — контакта не касается', async () => {
    const { env, calls } = captureDb();
    await updateSourceOrigin(env, 'id1', { chatId: '-1001234567890', messageId: 42 });
    expect(calls.some((c) => c.sql.includes('SET telegram = NULL'))).toBe(false);
  });
});

describe('scrubContactUsernames — разовая чистка', () => {
  it('нормализует список и чистит по списку + по нику чата-источника', async () => {
    const { env, calls } = captureDb(7);
    const n = await scrubContactUsernames(env, ['@Granica_Chat', 'granica_chat', 'Daniil06496', '', '@']);
    expect(n).toBe(7);
    const upd = calls.find((c) => c.sql.startsWith('UPDATE listings SET telegram = NULL'))!;
    expect(upd.sql).toContain('IN (?, ?)'); // дубли схлопнулись, «@» отброшен
    // явный список НЕ ограничен source_chat_username: у релейных копий его часто нет
    expect(upd.sql).toContain('WHERE telegram IS NOT NULL AND (');
    // автоматическое правило «ник == ник чата» — с защитой
    expect(upd.sql).toContain("(source_chat_username IS NOT NULL AND lower(replace(telegram, '@', '')) = lower(replace(source_chat_username, '@', '')))");
    expect(upd.params).toEqual(['granica_chat', 'daniil06496']);
  });
});

/* --------------------- полный поток лички --------------------- */

/** D1 с памятью: tg_seen и listings живут между вызовами. */
function statefulDb() {
  const calls: Call[] = [];
  const seen = new Map<string, string | null>();
  const listings = new Map<string, Record<string, unknown>>();
  const make = (sql: string) => {
    const call: Call = { sql, params: [] };
    calls.push(call);
    const stmt = {
      bind(...params: unknown[]) { call.params = params; return stmt; },
      async all() {
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
        if (/INSERT INTO listings/.test(sql)) {
          const row: Record<string, unknown> = {};
          COLS.forEach((name, i) => { row[name] = call.params[i]; });
          listings.set(String(row.id), row);
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
    calls, listings,
  };
}

const baseEnv = {
  BOT_TOKEN: 'test-token',
  ADMIN_IDS: '42',
  SITE_URL: 'https://pop-utka.app/',
  BOT_USERNAME: 'parcel_transfer_bot',
  RADAR_USERNAMES: 'Daniil06496',
  KV: { get: async () => null, put: async () => undefined, delete: async () => undefined },
} as unknown as Env;

function pmFrom(messageId: number, from: { id: number; username?: string }, text: string) {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date: 1789000000,
      chat: { id: 555, type: 'private' } as never,
      from: from as never,
      text,
    },
  };
}

function linkReply(messageId: number, replyTo: number, link: string) {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date: 1789000001,
      chat: { id: 555, type: 'private' } as never,
      from: { id: 77 } as never,
      text: link,
      reply_to_message: { message_id: replyTo } as never,
    },
  };
}

beforeEach(() => {
  global.fetch = vi.fn(async () => new Response('{"ok":true,"result":{"message_id":1}}', {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch;
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('текстовая копия радара в личке — полный поток', () => {
  it('контакт не подставляется: ни ник радара, ни ник чата из ссылки', async () => {
    const { db, calls, listings } = statefulDb();
    const env = { ...baseEnv, DB: db } as unknown as Env;
    await handleTelegramUpdate(env, pmFrom(800, { id: 77, username: 'Daniil06496' },
      'Нужно передать 5 января Гродно — Белосток, конверт с документами, ссылка https://t.me/granica_belarus_chat/153043/153048'));
    const ins = calls.find((c) => c.sql.includes('INSERT INTO listings'));
    expect(ins, 'копия распознана и создана').toBeTruthy();
    const row = listings.get(String(ins!.params[0]))!;
    expect(row.telegram, 'ни радара, ни чата в контактах').toBeNull();
    // ссылка в тексте — способ связаться: просьба не прячется
    expect(row.status).toBe('pending');
    expect(row.hidden).toBe(0);
  });

  it('обычный человек в личке: подстановка ника отправителя работает как раньше', async () => {
    const { db, calls, listings } = statefulDb();
    const env = { ...baseEnv, DB: db } as unknown as Env;
    await handleTelegramUpdate(env, pmFrom(820, { id: 99, username: 'ivan_p' },
      'Нужно передать 5 января Гродно — Белосток, конверт с документами'));
    const ins = calls.find((c) => c.sql.includes('INSERT INTO listings'))!;
    expect(listings.get(String(ins.params[0]))!.telegram).toBe('@ivan_p');
  });

  it('старая копия с ником чата в тексте: ссылка-ответ радара стирает его из контакта', async () => {
    const { db, calls, listings } = statefulDb();
    const env = { ...baseEnv, DB: db } as unknown as Env;
    await handleTelegramUpdate(env, pmFrom(810, { id: 77, username: 'Daniil06496' },
      'Нужно передать 5 января Гродно — Белосток, конверт, пишите в @granica_belarus_chat'));
    const ins = calls.find((c) => c.sql.includes('INSERT INTO listings'))!;
    const id = String(ins.params[0]);
    expect(listings.get(id)!.telegram, 'до ссылки-ответа ник чата ещё в контакте').toBe('@granica_belarus_chat');

    await handleTelegramUpdate(env, linkReply(811, 810, 'https://t.me/granica_belarus_chat/153043/153048'));
    const scrub = calls.find((c) => c.sql.includes('SET telegram = NULL'));
    expect(scrub, 'пришёл ответ радара — контакт очищен').toBeTruthy();
    expect(scrub!.params).toEqual([id, 'granica_belarus_chat', 'granica_belarus_chat']);
  });
});
