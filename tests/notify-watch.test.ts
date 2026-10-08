/**
 * Уведомления авторам заявок об одобрении.
 *
 * После подачи заявки с сайта человеку предлагают (не навязывая) ссылку
 * t.me/bot?start=watch_<id>. Бот запоминает диалог и пишет, когда заявку
 * публикуют. Автор, подавший заявку через бота в личке, получает
 * «опубликована» без всяких ссылок — он уже в Telegram.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env, Listing } from '../src/types';

const db = vi.hoisted(() => ({
  listings: new Map<string, Listing>(),
  watchers: [] as Array<{ listingId: string; chatId: string }>,
  statusUpdates: [] as Array<{ id: string; status: string; reason?: string }>,
}));

vi.mock('../src/store', () => ({
  addReport: async () => ({ ok: true, autoRejected: false, count: 0 }),
  addWatcher: async (_e: unknown, listingId: string, chatId: string) => {
    db.watchers.push({ listingId, chatId });
  },
  createListing: async () => { throw new Error('не нужен в этих тестах'); },
  createListingSafe: async () => { throw new Error('не нужен в этих тестах'); },
  findByIdPrefix: async () => null,
  findRelated: async () => [],
  getListingById: async (_e: unknown, id: string) => db.listings.get(id) ?? null,
  listForMatching: async () => [],
  countPending: async () => 0,
  listPending: async () => [],
  markSeen: async () => true,
  saveMatchRun: async () => undefined,
  searchByCity: async () => [],
  setSeenListing: async () => undefined,
  takeWatchers: async (_e: unknown, listingId: string) => {
    const out = db.watchers.filter((w) => w.listingId === listingId).map((w) => w.chatId);
    for (const c of out) {
      const i = db.watchers.findIndex((w) => w.listingId === listingId && w.chatId === c);
      if (i >= 0) db.watchers.splice(i, 1);
    }
    return out;
  },
  updateListingStatus: async (_e: unknown, id: string, status: string, reason?: string) => {
    db.statusUpdates.push({ id, status, reason });
    const l = db.listings.get(id);
    if (l) l.status = status as Listing['status'];
    return true;
  },
}));

import { handleTelegramUpdate, notifyListingPublished } from '../src/telegram';

const env = {
  BOT_TOKEN: 'test-token',
  ADMIN_IDS: '42',
  SITE_URL: 'https://pop-utka.app/',
  // мастер диалога хранится в KV
  KV: { get: async () => null, put: async () => undefined, delete: async () => undefined },
} as unknown as Env;

interface Sent { method: string; text: string; chatId: number }
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
    status: 'pending',
    source: 'site',
    sourceChat: null,
    sourceChatId: null,
    sourceMessageId: null,
    byAdmin: false,
    hidden: false,
    createdAt: '2026-10-08T07:00:00.000Z',
    publishedAt: null,
    ...over,
  } as Listing;
}

async function send(text: string, fromId = 100) {
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

async function callback(data: string, fromId = 42) {
  sent.length = 0;
  await handleTelegramUpdate(env, {
    update_id: 2,
    callback_query: {
      id: 'cb1',
      from: { id: fromId } as never,
      message: { message_id: 5, chat: { id: fromId } } as never,
      data,
    } as never,
  });
}

beforeEach(() => {
  db.listings.clear();
  db.watchers.length = 0;
  db.statusUpdates.length = 0;
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

describe('/start watch_<id> — диплинк с сайта', () => {
  it('заявка на модерации: бот запоминает и обещает написать', async () => {
    db.listings.set('p1', listing({ id: 'p1' }));
    const reply = await send('/start watch_p1');
    expect(reply).toContain('Напишу сюда, как только заявку опубликуют');
    expect(db.watchers).toContainEqual({ listingId: 'p1', chatId: '100' });
  });

  it('уже опубликованная: сразу карточка и ссылка', async () => {
    db.listings.set('p2', listing({ id: 'p2', status: 'published' }));
    const reply = await send('/start watch_p2');
    expect(reply).toContain('уже на доске');
    expect(reply).toContain('https://pop-utka.app/item/p2');
    expect(db.watchers).toHaveLength(0);
  });

  it('незнакомый id: честно «не нашёл»', async () => {
    const reply = await send('/start watch_nobody');
    expect(reply).toContain('не нашёл');
  });

  it('снятая с модерации: не подводим и не запоминаем', async () => {
    db.listings.set('p3', listing({ id: 'p3', status: 'rejected' }));
    const reply = await send('/start watch_p3');
    expect(reply).toContain('уже не на модерации');
    expect(db.watchers).toHaveLength(0);
  });
});

describe('notifyListingPublished — момент публикации', () => {
  it('пишет всем наблюдателям и автору из лички бота; дублей чатов нет', async () => {
    db.watchers.push({ listingId: 'x1', chatId: '111' }, { listingId: 'x1', chatId: '333' });
    const l = listing({ id: 'x1', status: 'published', source: 'telegram', sourceChatId: '333' });
    await notifyListingPublished(env, l);
    const chats = sent.filter((s) => s.method === 'sendMessage').map((s) => s.chatId).sort();
    expect(chats).toEqual([111, 333]);
    expect(sent[0]!.text).toContain('опубликована');
    // наблюдатели одноразовые; автору из лички бот отвечает всегда — это его заявка
    sent.length = 0;
    await notifyListingPublished(env, l);
    const again = sent.filter((s) => s.method === 'sendMessage').map((s) => s.chatId);
    expect(again).toEqual([333]);
  });

  it('группу-источник (отрицательный id) не дёргаем', async () => {
    const l = listing({ id: 'x2', status: 'published', source: 'telegram', sourceChatId: '-1001234567890' });
    await notifyListingPublished(env, l);
    expect(sent.filter((s) => s.method === 'sendMessage')).toHaveLength(0);
  });
});

describe('кнопки модератора: причина отклонения и уведомление автору', () => {
  it('rej пишется в ведро с причиной «admin»', async () => {
    db.listings.set('r1', listing({ id: 'r1' }));
    await callback('rej:r1');
    expect(db.statusUpdates).toContainEqual({ id: 'r1', status: 'rejected', reason: 'admin' });
  });

  it('appr: автору-наблюдателю приходит «опубликована»', async () => {
    db.listings.set('a1', listing({ id: 'a1' }));
    db.watchers.push({ listingId: 'a1', chatId: '777' });
    await callback('appr:a1');
    expect(db.statusUpdates).toContainEqual({ id: 'a1', status: 'published', reason: undefined });
    const toAuthor = sent.find((s) => s.method === 'sendMessage' && s.chatId === 777);
    expect(toAuthor?.text).toContain('опубликована');
  });
});
