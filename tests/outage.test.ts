/**
 * Поведение сайта при временном сбое платформы (авария Cloudflare D1,
 * «D1_ERROR: internal error; reference = …» — 29.10.2026 весь сайт отвечал
 * голым «Internal Server Error»). Контракт:
 *  - страницы: честная 503-страница «временно не отвечает» + Retry-After —
 *    краулеры трактуют сбой как временный и не выкидывают страницы из индекса;
 *  - API/POST: 503 JSON { error: 'temporarily_unavailable' } — форма на сайте
 *    покажет свою ошибку и не сделает вид, что приняла заявку;
 *  - Telegram webhook при аварии D1: 503, чтобы Telegram повторил доставку
 *    апдейта (раньше ошибка глоталась, ответ был 200 — сообщения терялись);
 *    при НЕ-D1 ошибке — как раньше, 200 { ok: false } без ретраев;
 *  - 503 не кладётся в edge-кэш (иначе «сбой» закэшировался бы на будущее);
 *  - если в кэше колокации есть копия страницы — она отдаётся, даже когда D1
 *    лежит (hit-путь до запроса в базу).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

/* src/og тянет resvg.wasm — vite в тестах wasm не грузит. */
vi.mock('../src/og', () => ({
  renderOgImage: async () => new Uint8Array(),
  renderRouteOg: async () => new Uint8Array(),
}));

import type { Env } from '../src/types';
import worker from '../src/index';

const SHELL = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const D1_DOWN = 'D1_ERROR: internal error; reference = um23m5t4nbspmmn7n3mh44je';

let cacheHit: Response | undefined;
let cachePuts: string[] = [];

function brokenEnv(dbMessage = D1_DOWN): Env {
  const kv = new Map<string, string>();
  return {
    DB: {
      prepare: () => { throw new Error(dbMessage); },
      batch: async () => { throw new Error(dbMessage); },
    },
    KV: {
      get: async (k: string) => kv.get(k) ?? null,
      put: async (k: string, v: string) => { kv.set(k, String(v)); },
      delete: async (k: string) => { kv.delete(k); },
    },
    ASSETS: { fetch: async () => new Response(SHELL, { status: 200 }) },
    SITE_URL: 'https://pop-utka.app',
    BOT_SECRET: 'localsecret',
  } as unknown as Env;
}

async function call(req: Request, env: Env): Promise<Response> {
  // waitUntil как в рантайме Workers: промис принят, ошибка не роняет ответ
  // (иначе статистика просмотров даёт unhandled rejection на падающей D1)
  const ctx = {
    waitUntil: (p: Promise<unknown>) => { p.catch(() => undefined); },
    passThroughOnException: () => undefined,
  };
  const fn = (worker as unknown as { fetch: (r: Request, e: Env, c: unknown) => Promise<Response> }).fetch;
  return fn(req, env, ctx);
}

const get = (path: string, env: Env) => call(new Request(`https://pop-utka.app${path}`), env);

beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

beforeEach(() => {
  cacheHit = undefined;
  cachePuts = [];
  (globalThis as Record<string, unknown>).caches = {
    default: {
      match: async () => cacheHit,
      put: async (key: Request | string) => { cachePuts.push(String(key)); },
    },
  };
});

afterAll(() => {
  delete (globalThis as Record<string, unknown>).caches;
});

describe('авария D1 — честный 503 вместо голого 500', () => {
  it('главная: страница «временно не отвечает», Retry-After, в кэш не кладётся', async () => {
    const res = await get('/', brokenEnv());
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('300');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('Сайт временно не отвечает');
    expect(html).toContain('Попутка');
    expect(html).not.toContain('Internal Server Error');
    expect(cachePuts).toHaveLength(0);
  });

  it('API доски: 503 JSON temporarily_unavailable', async () => {
    const res = await get('/api/listings?page=1', brokenEnv());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
  });

  it('отправка заявки с сайта: 503 JSON — форма не соврала, что приняла', async () => {
    const req = new Request('https://pop-utka.app/api/listings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'offer',
        fromCity: 'Минск',
        toCity: 'Варшава',
        description: 'Еду в пятницу, возьму небольшую посылку',
        telegram: 'ivan',
      }),
    });
    const res = await call(req, brokenEnv());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
  });

  it('Telegram webhook: 503 — Telegram повторит доставку, сообщение не потеряется', async () => {
    const req = new Request('https://pop-utka.app/api/telegram/localsecret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        update_id: 7,
        message: {
          message_id: 9,
          date: 1761000000,
          chat: { id: 555, type: 'private' },
          from: { id: 555, is_bot: false, first_name: 'Иван' },
          text: 'Минск → Варшава, в пятницу, посылка',
        },
      }),
    });
    const res = await call(req, brokenEnv());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, retry: true });
  });

  it('webhook при НЕ-D1 ошибке: как раньше, 200 { ok: false } без ретраев', async () => {
    const req = new Request('https://pop-utka.app/api/telegram/localsecret', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        update_id: 8,
        message: {
          message_id: 10,
          date: 1761000000,
          chat: { id: 555, type: 'private' },
          from: { id: 555, is_bot: false, first_name: 'Иван' },
          text: 'Минск → Варшава, в пятницу, посылка',
        },
      }),
    });
    const res = await call(req, brokenEnv('TypeError: неведомая беда'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false });
  });

  it('копия в edge-кэше отдаётся, даже когда D1 лежит', async () => {
    cacheHit = new Response('<html>кэш главной</html>', { status: 200 });
    const res = await get('/', brokenEnv());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<html>кэш главной</html>');
    expect(res.headers.get('x-poputka-edge')).toBe('hit');
  });
});
