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
  forumEvents: [] as Array<{ thread: number; routeKey: string; fromCity: string; toCity: string; posts: number }>,
  flowCounts: { arrived: 0, published: 0 },
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
  listForumStatEvents: async () => db.forumEvents.map((e) => ({ ...e })),
  listingFlowCounts: async () => db.flowCounts,
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

import { broadcastListingToForum, forumReachStats, forumThreadFor, handleTelegramUpdate, parseForumRouteLabel } from '../src/telegram';
import type { ForumBroadcast } from '../src/telegram';

const env = {
  BOT_TOKEN: 'test-token',
  ADMIN_IDS: '42',
  SITE_URL: 'https://pop-utka.app/',
  KV: { get: async () => null, put: async () => undefined, delete: async () => undefined },
} as unknown as Env;

interface Sent { method: string; text: string; chatId: number | string; threadId?: number; previewDisabled?: boolean }
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
  db.forumEvents.length = 0;
  db.flowCounts = { arrived: 0, published: 0 };
  sent.length = 0;
  global.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url);
    const m = /api\.telegram\.org\/bot[^/]+\/(\w+)/.exec(u);
    if (m) {
      const b = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      sent.push({
        method: m[1] ?? '',
        text: String(b.text ?? b.description ?? ''),
        chatId: (b.chat_id ?? 0) as number | string,
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

  it('автокомплит группы: /здесь@parcel_transfer_bot работает как /здесь', async () => {
    // клиент в группе дописывает к команде @юзернейм бота — раньше регэксп
    // её не узнавал и команда молча игнорировалась даже для админа
    await forumMessage('/здесь@parcel_transfer_bot Варшава → Минск', 42, 55);
    const c = JSON.parse(db.settings.get('forum_broadcast') ?? '{}');
    expect(c.pairs['варшава|минск']).toBe(55);
    expect(sent.some((s) => s.text.includes('Готово'))).toBe(true);
  });

  it('/здесь в личке боту — объяснение вместо молчания', async () => {
    await handleTelegramUpdate(env, {
      update_id: 8,
      message: { message_id: 16, date: 1789000007, chat: { id: 42, type: 'private' } as never,
        from: { id: 42 } as never, text: '/здесь Варшава → Минск' },
    });
    const reply = sent.find((s) => s.method === 'sendMessage');
    expect(reply?.text).toContain('форум-группе');
  });

  it('не админ — подсказка с ID вместо молчания, настройки не трогаем', async () => {
    await forumMessage('/здесь Варшава → Минск', 111, 55);
    expect(db.settings.size).toBe(0); // ничего не записали
    const reply = sent.find((s) => s.method === 'sendMessage');
    expect(reply?.text).toContain('ADMIN_IDS');
    expect(reply?.text).toContain('Ваш Telegram ID: <b>111</b>');
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
    // погранцифр тоже знает свои страны: Брест ↔ Тересполь/Бяла — это Польша ↔ Беларусь
    expect(forumThreadFor(c, 'Брест', 'Тересполь')).toBe(22);
    expect(forumThreadFor(c, 'Бяла', 'Брест')).toBe(22);
    expect(forumThreadFor(c, 'Гомель', 'Познань')).toBe(22);
    // Литва: Вильнюс/Каунас/Клайпеда ↔ белорусские города
    const lt = cfg({ countries: { 'беларусь|литва': 33 } });
    expect(forumThreadFor(lt, 'Минск', 'Вильнюс')).toBe(33);
    expect(forumThreadFor(lt, 'Клайпеда', 'Минск')).toBe(33);
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
describe('статистика попадания в канал (админка)', () => {
  it('проценты от заявок, комнаты с именами, топ «прочего»', async () => {
    db.settings.set('forum_broadcast', JSON.stringify(cfg({
      countries: { 'беларусь|польша': 55 },
      cities: { 'дубай': 77 },
    })));
    db.flowCounts = { arrived: 100, published: 40 };
    db.forumEvents = [
      { thread: 55, routeKey: 'варшава|минск', fromCity: 'Варшава', toCity: 'Минск', posts: 20 },
      { thread: 55, routeKey: 'гданьск|гродно', fromCity: 'Гданьск', toCity: 'Гродно', posts: 5 },
      { thread: 77, routeKey: 'дубай|москва', fromCity: 'Дубай', toCity: 'Москва', posts: 5 },
      { thread: 99, routeKey: 'минск|москва', fromCity: 'Минск', toCity: 'Москва', posts: 6 },
      { thread: 99, routeKey: 'прага|будапешт', fromCity: 'Прага', toCity: 'Будапешт', posts: 4 },
    ];

    const r = await forumReachStats(env, 30);
    expect(r.configured).toBe(true);
    expect(r.arrived).toBe(100);
    expect(r.published).toBe(40);
    expect(r.posted).toBe(40);            // 20+5+5+6+4
    expect(r.inRooms).toBe(30);           // 55-я и 77-я темы
    expect(r.inFallback).toBe(10);        // «прочее» 99
    // комнаты названы по настройкам, отсортированы по публикациям
    expect(r.rooms[0]).toMatchObject({ thread: 55, label: 'Беларусь ↔ Польша', kind: 'регион', posts: 25 });
    expect(r.rooms).toContainEqual(expect.objectContaining({ thread: 77, label: 'Дубай', kind: 'город', posts: 5 }));
    expect(r.rooms).toContainEqual(expect.objectContaining({ thread: 99, label: 'прочее', kind: 'прочее', posts: 10 }));
    // топ «прочего» — кандидат на новую комнату
    expect(r.fallbackTop[0]).toMatchObject({ from: 'Минск', to: 'Москва', posts: 6 });
  });

  it('канал не настроен или пусто — аккуратные нули', async () => {
    db.flowCounts = { arrived: 10, published: 0 };
    const empty = await forumReachStats(env, 30);
    expect(empty.configured).toBe(false);
    expect(empty.posted).toBe(0);
    expect(empty.rooms).toEqual([]);
    expect(empty.fallbackTop).toEqual([]);
  });
});

describe('/описание — задать описание чата/канала через бота', () => {
  it('админ в группе: бот ставит описание этого чата', async () => {
    await forumMessage('/описание Попутки и передача посылок — доска pop-utka.app', 42);
    const call = sent.find((s) => s.method === 'setChatDescription');
    expect(call).toBeTruthy();
    expect(call?.chatId).toBe(-100777);
    expect(call?.text).toContain('pop-utka.app');
    expect(sent.some((s) => s.method === 'sendMessage' && s.text.includes('Готово'))).toBe(true);
  });

  it('не админ — тишина, описание не трогаем', async () => {
    sent.length = 0;
    await forumMessage('/описание не должно сработать', 111);
    expect(sent.filter((s) => s.method === 'setChatDescription')).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('в личке админа: /описание @канал <текст> ставит описание каналу', async () => {
    sent.length = 0;
    await handleTelegramUpdate(env, {
      update_id: 3,
      message: {
        message_id: 11, date: 1789000002,
        chat: { id: 42, type: 'private' } as never,
        from: { id: 42 } as never,
        text: '/описание @parcel_info Попутки и попутный транспорт: Беларусь — Польша — Россия. Доска pop-utka.app',
      },
    });
    const call = sent.find((s) => s.method === 'setChatDescription');
    expect(call).toBeTruthy();
    expect(call?.chatId).toBe('@parcel_info');
    expect(call?.text).toContain('pop-utka.app');
  });

  it('в личке без канала — подсказка, ничего не меняем', async () => {
    sent.length = 0;
    await handleTelegramUpdate(env, {
      update_id: 4,
      message: {
        message_id: 12, date: 1789000003,
        chat: { id: 42, type: 'private' } as never,
        from: { id: 42 } as never,
        text: '/описание просто текст без канала',
      },
    });
    expect(sent.filter((s) => s.method === 'setChatDescription')).toHaveLength(0);
    expect(sent.some((s) => s.method === 'sendMessage' && s.text.includes('какому чату'))).toBe(true);
  });
});

describe('/id — Telegram ID аккаунта', () => {
  it('админ: ID и подтверждение', async () => {
    sent.length = 0;
    await handleTelegramUpdate(env, {
      update_id: 5,
      message: { message_id: 13, date: 1789000004, chat: { id: 42, type: 'private' } as never,
        from: { id: 42 } as never, text: '/id' },
    });
    const reply = sent.find((s) => s.method === 'sendMessage');
    expect(reply?.text).toContain('Ваш Telegram ID: <b>42</b>');
    expect(reply?.text).toContain('администратор');
  });

  it('не админ: ID и подсказка про ADMIN_IDS', async () => {
    sent.length = 0;
    await handleTelegramUpdate(env, {
      update_id: 6,
      message: { message_id: 14, date: 1789000005, chat: { id: 111, type: 'private' } as never,
        from: { id: 111 } as never, text: '/id' },
    });
    const reply = sent.find((s) => s.method === 'sendMessage');
    expect(reply?.text).toContain('Ваш Telegram ID: <b>111</b>');
    expect(reply?.text).toContain('ADMIN_IDS');
  });
});

describe('/форум — диагностика форум-канала', () => {
  it('админу: настройки, комнаты и тестовое сообщение в «прочее»', async () => {
    db.settings.set('forum_broadcast', JSON.stringify(cfg({
      countries: { 'беларусь|польша': 66 },
      cities: { 'дубай': 77 },
    })));
    sent.length = 0;
    await forumMessage('/форум', 42, 55);
    const reply = sent.map((s) => s.text).join('\n');
    expect(reply).toContain('Диагностика форум-канала');
    expect(reply).toContain('-100777');   // группа из настроек
    expect(reply).toContain('эта группа'); // команда написана именно в ней
    expect(reply).toContain('регион беларусь ↔ польша → тема 66');
    expect(reply).toContain('город дубай → тема 77');
    // тестовое сообщение ушло в тему «прочее» (99) настроенной группы
    const test = sent.find((s) => s.text.includes('Проверка форум-канала'));
    expect(test?.chatId).toBe('-100777'); // chat в настройках хранится строкой
    expect(test?.threadId).toBe(99);
    expect(sent.some((s) => s.text.includes('✅ Тестовое сообщение отправлено'))).toBe(true);
  });

  it('написано в другой группе — предупреждение о несоответствии', async () => {
    db.settings.set('forum_broadcast', JSON.stringify(cfg()));
    sent.length = 0;
    await handleTelegramUpdate(env, {
      update_id: 7,
      message: {
        message_id: 15, date: 1789000006,
        chat: { id: -100999, type: 'supergroup', is_forum: true } as never,
        from: { id: 42 } as never,
        text: '/форум', message_thread_id: 5,
      },
    });
    const reply = sent.map((s) => s.text).join('\n');
    expect(reply).toContain('⚠️ Команда написана в другой группе');
  });

  it('/форум в личке — подсказка, что /здесь пишут в самой группе', async () => {
    db.settings.set('forum_broadcast', JSON.stringify(cfg()));
    sent.length = 0;
    await handleTelegramUpdate(env, {
      update_id: 9,
      message: { message_id: 17, date: 1789000008, chat: { id: 42, type: 'private' } as never,
        from: { id: 42 } as never, text: '/форум' },
    });
    const reply = sent.map((s) => s.text).join('\n');
    expect(reply).toContain('Вы пишете в личке');
    expect(reply).toContain('/здесь Дубай');
    expect(reply).not.toContain('⚠️'); // личка — не «другая группа», предупреждение ни к чему
  });

  it('не админу — та же подсказка, что и /здесь', async () => {
    sent.length = 0;
    await forumMessage('/форум', 111, 55);
    const reply = sent.find((s) => s.method === 'sendMessage');
    expect(reply?.text).toContain('ADMIN_IDS');
    expect(reply?.text).toContain('Ваш Telegram ID: <b>111</b>');
  });
});
