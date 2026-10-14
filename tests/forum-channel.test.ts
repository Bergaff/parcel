/**
 * Форум-канал: «комнаты» (темы) по направлениям, куда бот публикует ссылки
 * на одобренные заявки — превью показывает карточку.
 *
 * Правила трёх видов: точная пара («Варшава → Минск»), регион («Польша ↔
 * Беларусь»), город-хаб («Дубай»); «прочее» — комната по умолчанию.
 * Статистика /комнаты показывает, какую комнату дробить, какую сливать.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env, Listing } from '../src/types';

interface StatRow { routeKey: string; fromCity: string; toCity: string; thread: number; posts: number; lastAt: string }

const db = vi.hoisted(() => ({
  listings: new Map<string, Listing>(),
  settings: new Map<string, string>(),
  forumStats: new Map<string, StatRow>(),
}));

vi.mock('../src/store', () => ({
  addReport: async () => ({ ok: true, autoRejected: false, count: 0 }),
  addWatcher: async () => undefined,
  bumpForumStat: async (_e: unknown, routeKey: string, fromCity: string, toCity: string, thread: number) => {
    const cur = db.forumStats.get(routeKey);
    if (cur) {
      cur.posts += 1; cur.thread = thread; cur.lastAt = '2026-10-14T09:00:00.000Z';
    } else {
      db.forumStats.set(routeKey, { routeKey, fromCity, toCity, thread, posts: 1, lastAt: '2026-10-14T09:00:00.000Z' });
    }
  },
  createListing: async () => { throw new Error('не нужен'); },
  createListingSafe: async () => { throw new Error('не нужен'); },
  findByIdPrefix: async () => null,
  findRelated: async () => [],
  getListingById: async (_e: unknown, id: string) => db.listings.get(id) ?? null,
  getSetting: async (_e: unknown, key: string) => db.settings.get(key) ?? null,
  setSetting: async (_e: unknown, key: string, value: string) => { db.settings.set(key, value); },
  listForMatching: async () => [],
  listForumStats: async () => [...db.forumStats.values()].sort((a, b) => b.posts - a.posts),
  countPending: async () => 0,
  listPending: async () => [],
  listWatchers: async () => [],
  markSeen: async () => true,
  removeWatcher: async () => undefined,
  saveMatchRun: async () => undefined,
  searchByCity: async () => [],
  setSeenListing: async () => undefined,
  updateListingStatus: async () => true,
}));

import { broadcastListingToForum, forumThreadFor, handleTelegramUpdate, parseForumRouteLabel } from '../src/telegram';
import type { ForumBroadcast } from '../src/telegram';

const env = {
  BOT_TOKEN: 'test-token',
  ADMIN_IDS: '42',
  SITE_URL: 'https://pop-utka.app/',
  KV: { get: async () => null, put: async () => undefined, delete: async () => undefined },
} as unknown as Env;

interface Sent { method: string; text: string; chatId: number; threadId?: number; previewDisabled?: boolean }
const sent: Sent[] = [];
const realFetch = global.fetch;

function listing(over: Partial<Listing> = {}): Listing {
  return {
    id: 'aaaaaaaa-1111-2222-3333-444444444444',
    type: 'offer',
    fromCity: 'Варшава',
    toCity: 'Минск',
    departureDate: '2030-05-20',
    weightKg: 8,
    price: '30 EUR',
    description: 'Еду в субботу утром, возьму одну сумку',
    phone: null,
    telegram: '@ivan_waw',
    status: 'published',
    source: 'site',
    sourceChat: null,
    sourceChatId: null,
    sourceMessageId: null,
    byAdmin: false,
    hidden: false,
    createdAt: '2026-10-14T07:00:00.000Z',
    publishedAt: '2026-10-14T08:00:00.000Z',
    ...over,
  } as Listing;
}

function cfg(over: Partial<ForumBroadcast> = {}): ForumBroadcast {
  return { chat: '-100777', fallback: 99, pairs: {}, countries: {}, cities: {}, ...over };
}

/** Сообщение в теме форум-группы. */
async function forumMessage(text: string, fromId: number, threadId = 55) {
  await handleTelegramUpdate(env, {
    update_id: 1,
    message: {
      message_id: 9,
      date: 1789000000,
      chat: { id: -100777, type: 'supergroup', is_forum: true } as never,
      from: { id: fromId } as never,
      text,
      message_thread_id: threadId,
    },
  });
}

beforeEach(() => {
  db.listings.clear();
  db.settings.clear();
  db.forumStats.clear();
  sent.length = 0;
  global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
    const m = /api\.telegram\.org\/bot[^/]+\/(\w+)/.exec(u);
    if (m) {
      const b = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      sent.push({
        method: m[1] ?? '',
        text: String(b.text ?? ''),
        chatId: Number(b.chat_id ?? 0),
        threadId: b.message_thread_id == null ? undefined : Number(b.message_thread_id),
        previewDisabled: b.disable_web_page_preview === true,
      });
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

describe('разбор аргумента /здесь', () => {
  it('пара городов, страны, одиночный город, прочее', () => {
    expect(parseForumRouteLabel('Варшава → Минск')).toEqual({ pair: 'варшава|минск' });
    expect(parseForumRouteLabel('Варшава - Минск')).toEqual({ pair: 'варшава|минск' });
    expect(parseForumRouteLabel('варшава-минск')).toEqual({ pair: 'варшава|минск' });
    expect(parseForumRouteLabel('Польша ↔ Беларусь')).toEqual({ country: 'беларусь|польша' });
    expect(parseForumRouteLabel('Германия - Беларусь')).toEqual({ country: 'беларусь|германия' });
    expect(parseForumRouteLabel('Дубай')).toEqual({ city: 'дубай' });
    expect(parseForumRouteLabel('прочее')).toEqual({ fallback: true });
    expect(parseForumRouteLabel('')).toBeNull();
    expect(parseForumRouteLabel('Польша')).toBeNull(); // страна без пары не имеет смысла
  });

  it('город с дефисом не режется пополам', () => {
    expect(parseForumRouteLabel('Ивано-Франковск-Киев')).toEqual({ pair: 'ивано-франковск|киев' });
  });
});

describe('/здесь — настройка комнат', () => {
  it('админ в теме: пара, регион и город пишутся в настройки', async () => {
    await forumMessage('/здесь Варшава → Минск', 42, 55);
    await forumMessage('/здесь Польша ↔ Беларусь', 42, 66);
    await forumMessage('/здесь Дубай', 42, 77);
    const c = JSON.parse(db.settings.get('forum_broadcast') ?? '{}');
    expect(c.chat).toBe('-100777');
    expect(c.pairs['варшава|минск']).toBe(55);
    expect(c.countries['беларусь|польша']).toBe(66);
    expect(c.cities['дубай']).toBe(77);
    expect(sent.some((s) => s.threadId === 66 && s.text.includes('Готово'))).toBe(true);
  });

  it('не админ — тишина: настроек не появилось', async () => {
    await forumMessage('/здесь Варшава → Минск', 111, 55);
    expect(db.settings.size).toBe(0);
    expect(sent).toHaveLength(0);
  });
});

describe('выбор темы: точная пара → страны → город → прочее', () => {
  it('приоритеты правил', () => {
    const c = cfg({
      pairs: { 'варшава|минск': 11 },
      countries: { 'беларусь|польша': 22 },
      cities: { 'варшава': 33 },
    });
    expect(forumThreadFor(c, 'Варшава', 'Минск')).toBe(11); // пара главнее всего
    expect(forumThreadFor(c, 'Гданьск', 'Гродно')).toBe(22); // страны накрывают остальную Польшу↔Беларусь
    expect(forumThreadFor(c, 'Варшава', 'Берлин')).toBe(33); // город ловит, страны не совпали
    expect(forumThreadFor(c, 'Прага', 'Будапешт')).toBe(99); // ничего — прочее
  });

  it('страны работают в обе стороны (сортированный ключ)', () => {
    const c = cfg({ countries: { 'беларусь|польша': 22 } });
    expect(forumThreadFor(c, 'Минск', 'Варшава')).toBe(22);
    expect(forumThreadFor(c, 'Белосток', 'Брест')).toBe(22);
  });
});

describe('публикация и статистика', () => {
  it('ссылка в нужную тему + счётчик направления растёт', async () => {
    db.settings.set('forum_broadcast', JSON.stringify(cfg({ countries: { 'беларусь|польша': 55 } })));
    await broadcastListingToForum(env, listing());
    const post = sent.find((s) => s.method === 'sendMessage');
    expect(post?.chatId).toBe(-100777);
    expect(post?.threadId).toBe(55);
    expect(post?.text).toBe('https://pop-utka.app/item/aaaaaaaa-1111-2222-3333-444444444444');
    expect(post?.previewDisabled).toBe(false);
    const stat = db.forumStats.get('варшава|минск');
    expect(stat).toMatchObject({ fromCity: 'Варшава', toCity: 'Минск', thread: 55, posts: 1 });

    sent.length = 0;
    await broadcastListingToForum(env, listing());
    expect(db.forumStats.get('варшава|минск')?.posts).toBe(2); // +1
  });

  it('форум не настроен — тишина', async () => {
    await broadcastListingToForum(env, listing());
    expect(sent).toHaveLength(0);
    expect(db.forumStats.size).toBe(0);
  });

  it('/комнаты показывает темы и топ направлений', async () => {
    db.settings.set('forum_broadcast', JSON.stringify(cfg({ countries: { 'беларусь|польша': 55 } })));
    await broadcastListingToForum(env, listing()); // варшава → минск ×1
    await broadcastListingToForum(env, listing({ fromCity: 'Гданьск', toCity: 'Гродно' })); // тема 55 ×1
    await broadcastListingToForum(env, listing({ fromCity: 'Прага', toCity: 'Будапешт' })); // прочее ×1
    sent.length = 0;

    await handleTelegramUpdate(env, {
      update_id: 2,
      message: {
        message_id: 10, date: 1789000001,
        chat: { id: 42, type: 'private' } as never,
        from: { id: 42 } as never,
        text: '/комнаты',
      },
    });
    const reply = sent.find((s) => s.method === 'sendMessage');
    expect(reply?.text).toContain('Тема 55 — 2 публикации');
    expect(reply?.text).toContain('Варшава → Минск: 1');
    expect(reply?.text).toContain('Тема 99 (прочее) — 1 публикация');
    expect(reply?.text).toContain('кандидаты на новые комнаты');
  });
});
