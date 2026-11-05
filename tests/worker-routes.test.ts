/**
 * Все страницы воркера обязаны быть в run_worker_first (wrangler.toml).
 *
 * Ловушка, найденная на проде (v0.4.62): assets-слой при not_found_handling =
 * "404-page" отвечает статичным 404.html на любой неизвестный путь ВМЕСТО
 * воркера, а run_worker_first — белый список путей, которые вообще доходят до
 * воркера. Новые GEO-страницы (/peredat, /llms.txt, /og-carry) задеплоились,
 * но не открывались: путей не было в списке. Тест сверяет со списком каждый
 * app.get/app.post из index.ts и ключи STATIC_PAGES — теперь забыть нельзя.
 *
 * Здесь же интеграционка: worker.fetch на новые адреса — тот самый путь,
 * которым запрос приходит на проде (Hono + middleware + кэш края).
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../src/types';

/* src/og тянет resvg.wasm — в тестах wasm не грузится, а воркер импортируем */
vi.mock('../src/og', () => ({
  renderOgImage: async () => new Uint8Array(),
  renderRouteOg: async () => new Uint8Array(),
}));

import worker from '../src/index';
import { STATIC_PAGES } from '../src/pages';

/* caches.default (кэш колокации Cloudflare) — в тестах заглушка: пустой кэш */
vi.stubGlobal('caches', {
  default: { match: async () => undefined, put: async () => undefined },
});

const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const indexSrc = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

function workerFirstPaths(): string[] {
  const m = /run_worker_first\s*=\s*\[([\s\S]*?)\]/.exec(toml);
  expect(m, 'run_worker_first не найден в wrangler.toml').not.toBeNull();
  const body = m?.[1] ?? '';
  return [...body.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

function covered(path: string, list: string[]): boolean {
  return list.some((w) => w === path || (w.endsWith('*') && path.startsWith(w.slice(0, -1))));
}

/** Адрес роута в шаблон списка: '/peredat/:slug' → '/peredat/*'. */
function toPattern(route: string): string {
  return route.includes('/:') ? `${route.slice(0, route.indexOf('/:'))}/*` : route;
}

describe('run_worker_first покрывает каждую страницу воркера', () => {
  const list = workerFirstPaths();

  it('все app.get/app.post из index.ts доходят до воркера', () => {
    const routes = [...indexSrc.matchAll(/app\.(?:get|post|put|delete)\('([^']+)'/g)]
      .map((m) => toPattern(m[1]!));
    expect(routes.length).toBeGreaterThan(30); // регекс живой, роуты нашлись
    const missed = [...new Set(routes)].filter((r) => !covered(r, list));
    expect(missed).toEqual([]);
  });

  it('текстовые разделы (STATIC_PAGES) — в списке', () => {
    const missed = Object.keys(STATIC_PAGES).filter((p) => !covered(p, list));
    expect(missed).toEqual([]);
  });

  it('GEO-страницы, llms.txt и ключ IndexNow перечислены явно (урок v0.4.62)', () => {
    for (const p of ['/peredat', '/peredat/*', '/og-carry/*', '/llms.txt', '/indexnow-key.txt']) {
      expect(list, p).toContain(p);
    }
  });
});

describe('воркер отдаёт новые страницы (worker.fetch)', () => {
  const ctx = { waitUntil: () => {} } as unknown as ExecutionContext;

  function envStub(): Env {
    const stmt = {
      bind: () => stmt,
      async first() { return null; },
      async all() { return { results: [] }; },
      async run() { return { meta: { changes: 0 } }; },
    };
    return {
      SITE_URL: 'https://pop-utka.app',
      BOT_USERNAME: 'parcel_transfer_bot',
      DB: { prepare: () => stmt, batch: async () => [] },
      ASSETS: {
        fetch: async () => new Response(
          '<!DOCTYPE html><html lang="ru"><head></head><body><div id="list"></div></body></html>',
          { status: 200, headers: { 'Content-Type': 'text/html' } },
        ),
      },
    } as unknown as Env;
  }

  const get = (path: string) =>
    worker.fetch(new Request(`https://pop-utka.app${path}`), envStub(), ctx);

  it('/peredat — 200, хаб «Что передают попуткой»', async () => {
    const res = await get('/peredat');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Что передают попуткой');
    expect(html).toContain('<link rel="canonical" href="https://pop-utka.app/peredat"');
    expect(res.headers.get('x-poputka-edge')).toBe('miss'); // кэш края отработал
  });

  it('/peredat/dokumenty — 200, пустая база = честные нули', async () => {
    const res = await get('/peredat/dokumenty');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Передать документы попуткой');
    expect(html).toContain('нет живых заявок про документы');
  });

  it('/peredat/kotiki — честный 404', async () => {
    const res = await get('/peredat/kotiki');
    expect(res.status).toBe(404);
  });

  it('/llms.txt — 200, text/plain, сводка для LLM', async () => {
    const res = await get('/llms.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    const txt = await res.text();
    expect(txt.startsWith('# попутка.')).toBe(true);
    expect(txt).toContain('## Что передают попуткой');
    expect(txt).toContain('https://pop-utka.app/r/varshava-minsk'); // направления — витрина, всегда
    expect(txt).toContain('https://pop-utka.app/new');
  });
});
