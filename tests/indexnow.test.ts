/**
 * IndexNow: очередь адресов, ключ, отправка и поведение при сбое сети.
 *
 * Главное — уведомления не теряются и не тормозят запрос: адреса копятся в
 * таблице, сливаются одним запросом, а при отказе возвращаются в очередь.
 */
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../src/types';
import { updateListing, updateListingStatus } from '../src/store';
import {
  flushIndexNow, generateKey, getIndexNowKey, KEY_LOCATION_PATH, listingPaths, queueListingChange,
  queuePaths, submitBody, submitPaths, takeQueuedPaths, type FetchLike,
} from '../src/indexnow';

interface Sent { endpoint: string; body: string }

/** Подделка окружения: очередь в «D1», ключ в «KV», сеть — под контролем. */
function fakeEnv(opts: {
  key?: string;
  listing?: { id: string; from_city: string; to_city: string };
  row?: Record<string, unknown>;
  fetchImpl?: FetchLike;
} = {}) {
  const queue = new Map<string, string>();
  const kv = new Map<string, string>();
  const sent: Sent[] = [];
  const sqls: string[] = [];

  const make = (sql: string) => {
    sqls.push(sql);
    const params: unknown[] = [];
    const stmt = {
      bind(...p: unknown[]) { params.push(...p); return stmt; },
      async run() {
        if (/INSERT OR IGNORE INTO indexnow_queue/.test(sql)) {
          const path = String(params[0]);
          if (!queue.has(path)) queue.set(path, String(params[1]));
        } else if (/DELETE FROM indexnow_queue/.test(sql)) {
          queue.delete(String(params[0]));
        }
        return { meta: { changes: 1 } };
      },
      async all() {
        if (/SELECT path FROM indexnow_queue/.test(sql)) {
          const limit = Number(params[0] ?? 500);
          return { results: [...queue.keys()].slice(0, limit).map((path) => ({ path })) };
        }
        return { results: [] };
      },
      async first() {
        if (/SELECT id, from_city, to_city FROM listings/.test(sql)) return opts.listing ?? null;
        if (/SELECT \* FROM listings/.test(sql)) return opts.row ?? null;
        return null;
      },
    };
    return stmt;
  };

  const fetchImpl = opts.fetchImpl ?? (async (endpoint: string, init: RequestInit) => {
    sent.push({ endpoint, body: String(init.body) });
    return { status: 200 };
  });

  const env = {
    DB: { prepare: make, batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => Promise.all(stmts.map((s) => s.run())) },
    KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => { kv.set(k, v); },
    },
    SITE_URL: 'https://pop-utka.app',
    INDEXNOW_KEY: opts.key,
  } as unknown as Env;

  return { env, queue, kv, sent, sqls, fetchImpl };
}

describe('адреса объявления', () => {
  it('карточка и страница маршрута, id — в URL-виде', () => {
    expect(listingPaths('a/b 1', 'Варшава', 'Минск')).toEqual(['/item/a%2Fb%201', '/r/varshava-minsk']);
  });

  it('нет городов — только карточка, кривого маршрута не будет', () => {
    expect(listingPaths('id1', '', '')).toEqual(['/item/id1']);
  });

  it('города не транслитерируются — мусорного /r/- в очереди не будет', () => {
    expect(listingPaths('id1', '???', '!!!')).toEqual(['/item/id1']);
    expect(listingPaths('id1', 'Варшава', '  ')).toEqual(['/item/id1']);
  });
});

describe('ключ IndexNow', () => {
  it('32 шестнадцатеричных символа и не повторяется', () => {
    const a = generateKey();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(generateKey()).not.toBe(a);
  });

  it('секрет важнее KV', async () => {
    const { env, kv } = fakeEnv({ key: 'secret-key' });
    kv.set('indexnow:key', 'kv-key');
    expect(await getIndexNowKey(env)).toBe('secret-key');
  });

  it('ключа нет — создаём, кладём в KV и дальше отдаём его же', async () => {
    const { env, kv } = fakeEnv();
    const first = await getIndexNowKey(env);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(kv.get('indexnow:key')).toBe(first);
    expect(await getIndexNowKey(env)).toBe(first);
  });

  it('путь файла ключа — тот, что сообщаем в keyLocation', () => {
    expect(KEY_LOCATION_PATH).toBe('/indexnow-key.txt');
  });
});

describe('очередь', () => {
  it('кладёт без дублей и пустых строк', async () => {
    const { env, queue } = fakeEnv();
    expect(await queuePaths(env, ['/item/1', '/item/1', '  ', '/r/varshava-minsk'])).toBe(2);
    expect([...queue.keys()]).toEqual(['/item/1', '/r/varshava-minsk']);
  });

  it('пустой список — ноль записей', async () => {
    const { env, queue } = fakeEnv();
    expect(await queuePaths(env, [])).toBe(0);
    expect(queue.size).toBe(0);
  });

  it('забор очищает очередь — дважды одно и то же не шлём', async () => {
    const { env, queue } = fakeEnv();
    await queuePaths(env, ['/item/1']);
    expect(await takeQueuedPaths(env)).toEqual(['/item/1']);
    expect(queue.size).toBe(0);
    expect(await takeQueuedPaths(env)).toEqual([]);
  });

  it('объявление по id: города берём из строки', async () => {
    const { env, queue } = fakeEnv({ listing: { id: 'x1', from_city: 'Минск', to_city: 'Брест' } });
    expect(await queueListingChange(env, 'x1')).toBe(2);
    expect([...queue.keys()]).toEqual(['/item/x1', '/r/minsk-brest']);
  });

  it('нет такого объявления — ничего не ставим', async () => {
    const { env, queue } = fakeEnv();
    expect(await queueListingChange(env, 'нет')).toBe(0);
    expect(queue.size).toBe(0);
  });
});

describe('отправка', () => {
  it('тело: хост, ключ, keyLocation и абсолютные адреса', () => {
    const body = JSON.parse(submitBody('pop-utka.app', 'k1', 'https://pop-utka.app/indexnow-key.txt', ['/item/1']));
    expect(body.host).toBe('pop-utka.app');
    expect(body.key).toBe('k1');
    expect(body.keyLocation).toBe('https://pop-utka.app/indexnow-key.txt');
    expect(body.urlList).toEqual(['https://pop-utka.app/item/1']);
  });

  it('200 — принято, шлём на общий вход IndexNow', async () => {
    const { env, fetchImpl } = fakeEnv();
    const res = await submitPaths(env, 'https://pop-utka.app', ['/item/1'], fetchImpl);
    expect(res).toEqual({ ok: true, status: 200, endpoint: 'https://api.indexnow.org/indexnow' });
  });

  it('общий вход недоступен — пробуем напрямую Яндекса', async () => {
    const sent: Sent[] = [];
    const { env, fetchImpl } = fakeEnv({
      fetchImpl: async (endpoint: string) => {
        sent.push({ endpoint, body: '' });
        if (endpoint.includes('api.indexnow.org')) throw new Error('сеть недоступна');
        return { status: 202 };
      },
    });
    const res = await submitPaths(env, 'https://pop-utka.app', ['/item/1'], fetchImpl);
    expect(res.ok).toBe(true);
    expect(res.endpoint).toBe('https://yandex.com/indexnow');
    expect(sent.map((s) => s.endpoint)).toEqual([
      'https://api.indexnow.org/indexnow',
      'https://yandex.com/indexnow',
    ]);
  });
});

describe('слив очереди', () => {
  it('очередь пуста — сети нет вообще', async () => {
    const { env, sent } = fakeEnv();
    const fetchSpy = vi.fn(async () => ({ status: 200 }));
    expect(await flushIndexNow(env, 'https://pop-utka.app', fetchSpy)).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('успех: адреса ушли одним запросом, очередь пуста', async () => {
    const { env, queue, sent, fetchImpl } = fakeEnv();
    await queuePaths(env, ['/item/1', '/r/varshava-minsk']);
    expect(await flushIndexNow(env, 'https://pop-utka.app', fetchImpl)).toBe(2);
    expect(queue.size).toBe(0);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!.body).urlList).toEqual([
      'https://pop-utka.app/item/1',
      'https://pop-utka.app/r/varshava-minsk',
    ]);
  });

  it('сеть недоступна — адреса вернулись в очередь (не потерялись)', async () => {
    const { env, queue, fetchImpl } = fakeEnv({ fetchImpl: async () => { throw new Error('offline'); } });
    await queuePaths(env, ['/item/1']);
    expect(await flushIndexNow(env, 'https://pop-utka.app', fetchImpl)).toBe(0);
    expect([...queue.keys()]).toEqual(['/item/1']);
  });

  it('4xx — тоже возвращаем в очередь и не долбим второй вход', async () => {
    const sent: Sent[] = [];
    const { env, queue, fetchImpl } = fakeEnv({
      fetchImpl: async (endpoint: string) => {
        sent.push({ endpoint, body: '' });
        return { status: 422 };
      },
    });
    await queuePaths(env, ['/item/1']);
    expect(await flushIndexNow(env, 'https://pop-utka.app', fetchImpl)).toBe(0);
    expect(sent).toHaveLength(1);
    expect([...queue.keys()]).toEqual(['/item/1']);
  });

  it('5xx на общем входе — пробуем Яндекса', async () => {
    const sent: Sent[] = [];
    const { env, fetchImpl } = fakeEnv({
      fetchImpl: async (endpoint: string) => {
        sent.push({ endpoint, body: '' });
        return { status: endpoint.includes('yandex') ? 200 : 503 };
      },
    });
    await queuePaths(env, ['/item/1']);
    expect(await flushIndexNow(env, 'https://pop-utka.app', fetchImpl)).toBe(1);
    expect(sent.map((s) => s.endpoint)).toHaveLength(2);
  });

  it('origin берётся из SITE_URL, если не передан', async () => {
    const { env, sent, fetchImpl } = fakeEnv();
    await queuePaths(env, ['/item/1']);
    expect(await flushIndexNow(env, undefined, fetchImpl)).toBe(1);
    expect(JSON.parse(sent[0]!.body).host).toBe('pop-utka.app');
  });
});

/** Строка объявления такой, какой её возвращает D1 (для SELECT *). */
const ROW = {
  id: 'x1', type: 'offer', from_city: 'Минск', to_city: 'Брест', departure_date: '2026-11-05',
  recurring: null, weight_kg: 10, price: '30 BYN', description: 'Еду вечером', phone: null,
  telegram: '@driver', status: 'published', source: 'telegram', source_chat: null,
  source_chat_id: null, source_message_id: null, created_at: '2026-10-19T08:00:00.000Z',
  published_at: '2026-10-19T08:05:00.000Z', views: 0, by_admin: 0, hidden: 0, reject_reason: null,
  pinned_until: null, from_city_lc: 'минск', to_city_lc: 'брест', description_lc: 'еду вечером',
};

describe('хуки в store: изменения объявления попадают в очередь', () => {
  const LISTING = { id: 'x1', from_city: 'Минск', to_city: 'Брест' };

  it('публикация — карточка и страница маршрута', async () => {
    const { env, queue } = fakeEnv({ listing: LISTING });
    expect(await updateListingStatus(env, 'x1', 'published')).toBe(true);
    expect([...queue.keys()]).toEqual(['/item/x1', '/r/minsk-brest']);
  });

  it('отклонение с причиной — тоже в очередь: страницу надо снять с индекса', async () => {
    const { env, queue } = fakeEnv({ listing: LISTING });
    expect(await updateListingStatus(env, 'x1', 'rejected', 'admin')).toBe(true);
    expect([...queue.keys()]).toEqual(['/item/x1', '/r/minsk-brest']);
  });

  it('снятие с доски (expired) — очередь не пустая', async () => {
    const { env, queue } = fakeEnv({ listing: LISTING });
    expect(await updateListingStatus(env, 'x1', 'expired')).toBe(true);
    expect(queue.size).toBe(2);
  });

  it('правка объявления — города берём из обновлённой строки', async () => {
    const { env, queue } = fakeEnv({ row: { ...ROW, from_city: 'Гродно', to_city: 'Варшава' } });
    const updated = await updateListing(env, 'x1', { fromCity: 'Гродно', toCity: 'Варшава' });
    expect(updated?.fromCity).toBe('Гродно');
    expect([...queue.keys()]).toEqual(['/item/x1', '/r/grodno-varshava']);
  });

  it('сбой очереди не роняет смену статуса', async () => {
    const { env } = fakeEnv({ listing: LISTING });
    // batch отсутствует — как будто D1 не дала очередь; статус всё равно меняется
    (env.DB as unknown as { batch: unknown }).batch = async () => { throw new Error('D1 занята'); };
    expect(await updateListingStatus(env, 'x1', 'published')).toBe(true);
  });
});
