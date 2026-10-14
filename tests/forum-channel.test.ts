/**
 * Форум-канал: «комнаты» (темы) по направлениям, куда бот публикует ссылки
 * на одобренные заявки — превью показывает карточку.
 *
 * Настройка — командой /здесь в самой теме форум-группы (админ), хранение —
 * settings.forum_broadcast. Публикация — из notifyListingPublished.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env, Listing } from '../src/types';

const db = vi.hoisted(() => ({
  listings: new Map<string, Listing>(),
  settings: new Map<string, string>(),
}));

vi.mock('../src/store', () => ({
  addReport: async () => ({ ok: true, autoRejected: false, count: 0 }),
  addWatcher: async () => undefined,
  createListing: async () => { throw new Error('не нужен'); },
  createListingSafe: async () => { throw new Error('не нужен'); },
  findByIdPrefix: async () => null,
  findRelated: async () => [],
  getListingById: async (_e: unknown, id: string) => db.listings.get(id) ?? null,
  getSetting: async (_e: unknown, key: string) => db.settings.get(key) ?? null,
  setSetting: async (_e: unknown, key: string, value: string) => { db.settings.set(key, value); },
  listForMatching: async () => [],
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

import { broadcastListingToForum, handleTelegramUpdate, notifyListingPublished, parseForumRouteLabel } from '../src/telegram';

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

describe('разбор названия направления', () => {
  it('стрелка, дефисы и «прочее»', () => {
    expect(parseForumRouteLabel('Варшава → Минск')).toEqual({ key: 'варшава|минск' });
    expect(parseForumRouteLabel('Варшава - Минск')).toEqual({ key: 'варшава|минск' });
    expect(parseForumRouteLabel('варшава-минск')).toEqual({ key: 'варшава|минск' });
    expect(parseForumRouteLabel('прочее')).toEqual({ fallback: true });
    expect(parseForumRouteLabel('')).toBeNull();
    expect(parseForumRouteLabel('просто слово')).toBeNull();
  });

  it('город с дефисом не режется пополам', () => {
    expect(parseForumRouteLabel('Ивано-Франковск-Киев')).toEqual({ key: 'ивано-франковск|киев' });
  });
});

describe('/здесь — настройка комнат', () => {
  it('админ в теме: бот запоминает маршрут за темой и отвечает там же', async () => {
    await forumMessage('/здесь Варшава → Минск', 42, 55);
    const cfg = JSON.parse(db.settings.get('forum_broadcast') ?? '{}');
    expect(cfg.chat).toBe('-100777');
    expect(cfg.routes['варшава|минск']).toBe(55);
    const reply = sent.find((s) => s.method === 'sendMessage');
    expect(reply?.chatId).toBe(-100777);
    expect(reply?.threadId).toBe(55);
    expect(reply?.text).toContain('Готово');
  });

  it('«прочее» задаёт комнату по умолчанию', async () => {
    await forumMessage('/здесь прочее', 42, 99);
    const cfg = JSON.parse(db.settings.get('forum_broadcast') ?? '{}');
    expect(cfg.fallback).toBe(99);
  });

  it('не админ — тишина: настроек не появилось', async () => {
    await forumMessage('/здесь Варшава → Минск', 111, 55);
    expect(db.settings.size).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('вторая тема добавляется к первой, не затирая', async () => {
    await forumMessage('/здесь Варшава → Минск', 42, 55);
    await forumMessage('/здесь Минск → Москва', 42, 77);
    const cfg = JSON.parse(db.settings.get('forum_broadcast') ?? '{}');
    expect(cfg.routes).toEqual({ 'варшава|минск': 55, 'минск|москва': 77 });
  });
});

describe('публикация ссылки в комнату', () => {
  it('свой маршрут — своя тема, чужой — комната по умолчанию', async () => {
    db.settings.set('forum_broadcast', JSON.stringify({
      chat: '-100777', fallback: 99, routes: { 'варшава|минск': 55 },
    }));
    await broadcastListingToForum(env, listing());
    const post = sent.find((s) => s.method === 'sendMessage');
    expect(post?.chatId).toBe(-100777);
    expect(post?.threadId).toBe(55);
    expect(post?.text).toBe('https://pop-utka.app/item/aaaaaaaa-1111-2222-3333-444444444444');
    expect(post?.previewDisabled).toBe(false); // превью включено

    sent.length = 0;
    await broadcastListingToForum(env, listing({ fromCity: 'Гродно', toCity: 'Минск' }));
    expect(sent.find((s) => s.method === 'sendMessage')?.threadId).toBe(99);
  });

  it('форум не настроен — тишина', async () => {
    await broadcastListingToForum(env, listing());
    expect(sent).toHaveLength(0);
  });

  it('одобрение заявки публикует ссылку и пишет автору', async () => {
    db.settings.set('forum_broadcast', JSON.stringify({
      chat: '-100777', fallback: 99, routes: { 'варшава|минск': 55 },
    }));
    db.listings.set('w1', listing({ id: 'w1', status: 'pending', source: 'telegram', sourceChatId: '333' }));
    await notifyListingPublished(env, db.listings.get('w1')!);
    const toForum = sent.find((s) => s.threadId === 55);
    expect(toForum?.text).toContain('https://pop-utka.app/item/w1');
    const toAuthor = sent.find((s) => s.chatId === 333);
    expect(toAuthor?.text).toContain('опубликована');
  });
});
