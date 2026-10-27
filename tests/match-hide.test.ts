/**
 * Скрытие в подборе заявки без контакта: POST /api/admin/match/hide принимает
 * listingId и пишет ключ id:<uuid> в тот же KV-список, где живут контактные
 * ключи. Контактный формат остаётся рабочим (кнопки «скрыть» у юзернеймов).
 */
import { describe, expect, it, vi } from 'vitest';

/* src/og тянет resvg.wasm — vite в тестах wasm не грузит. */
vi.mock('../src/og', () => ({
  renderOgImage: async () => new Uint8Array(),
  renderRouteOg: async () => new Uint8Array(),
}));

import type { Env } from '../src/types';
import worker from '../src/index';

const ADMIN_TOKEN = 'testkey';
const KV_KEY = 'match:hidden-contacts';
const LISTING = 'aaaaaaaa-1111-2222-3333-444444444444';

function envWithKv() {
  const store = new Map<string, string>();
  const env = {
    DB: {
      prepare: () => ({
        bind: () => ({ run: async () => ({ meta: { changes: 0 } }), all: async () => ({ results: [] }), first: async () => null }),
      }),
      batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => Promise.all(stmts.map((st) => st.run())),
    },
    KV: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, String(v)); },
      delete: async (k: string) => { store.delete(k); },
    },
    SITE_URL: 'https://pop-utka.app',
    ADMIN_API_TOKEN: ADMIN_TOKEN,
  } as unknown as Env;
  return { env, store };
}

async function post(env: Env, body: unknown) {
  const req = new Request('https://pop-utka.app/api/admin/match/hide', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined };
  const fn = (worker as unknown as { fetch: (r: Request, e: Env, c: unknown) => Promise<Response> }).fetch;
  return fn(req, env, ctx);
}

describe('POST /api/admin/match/hide — заявка без контакта', () => {
  it('listingId → ключ id:<uuid> в KV-списке, подпись сохраняется', async () => {
    const { env, store } = envWithKv();
    const res = await post(env, { listingId: LISTING, label: '№ aaaaaaaa · Минск → Варшава' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string; hidden: Array<{ key: string; label: string }> };
    expect(body.key).toBe(`id:${LISTING}`);
    expect(body.hidden).toEqual([{ key: `id:${LISTING}`, label: '№ aaaaaaaa · Минск → Варшава' }]);
    expect(JSON.parse(store.get(KV_KEY)!)).toEqual(body.hidden);
  });

  it('без подписи — запасная: «заявка <префикс id>»', async () => {
    const { env } = envWithKv();
    const res = await post(env, { listingId: LISTING });
    const body = (await res.json()) as { hidden: Array<{ label: string }> };
    expect(body.hidden[0]!.label).toBe('заявка aaaaaaaa');
  });

  it('hide: false → ключ убирается (кнопка «вернуть» у id-ключа)', async () => {
    const { env, store } = envWithKv();
    store.set(KV_KEY, JSON.stringify([
      { key: `id:${LISTING}`, label: 'заявка' },
      { key: 'tg:ivan', label: '@ivan' },
    ]));
    const res = await post(env, { listingId: LISTING, hide: false });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hidden: Array<{ key: string }> };
    expect(body.hidden.map((h) => h.key)).toEqual(['tg:ivan']);
  });

  it('повторное скрытие не плодит дубли ключа', async () => {
    const { env } = envWithKv();
    await post(env, { listingId: LISTING });
    const res = await post(env, { listingId: LISTING });
    const body = (await res.json()) as { hidden: unknown[] };
    expect(body.hidden).toHaveLength(1);
  });

  it('мусор и пустота — 400', async () => {
    const { env } = envWithKv();
    expect((await post(env, {})).status).toBe(400);
    expect((await post(env, { listingId: 'ок' })).status).toBe(400);
    expect((await post(env, { listingId: 'a'.repeat(65) })).status).toBe(400);
  });

  it('контактный формат по-прежнему работает', async () => {
    const { env } = envWithKv();
    const res = await post(env, { contact: '@stale_guy' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { key: string; hidden: Array<{ label: string }> };
    expect(body.key).toBe('tg:stale_guy');
    expect(body.hidden[0]!.label).toBe('@stale_guy');
  });
});
