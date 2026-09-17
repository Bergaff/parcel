/**
 * UI-тесты настоящего public/app.js в jsdom.
 *
 * Клиентский код сайта раньше не был покрыт тестами вообще, а отвечает он за
 * главное ощущение от сайта — отклик на нажатие (INP). Здесь проверяем как есть:
 * настоящий index.html, настоящий app.js, настоящий CSS, сеть — заглушка.
 * Никакой сборки: vitest отдаёт файлы текстом через `?raw`.
 */
import { readFileSync } from 'node:fs';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';

/* Гоняем сайт как он есть: html + app.js + css читаем прямо из public/.
   (Через vite-импорт `?raw` css отдаётся пустым — поэтому fs.) */
const read = (name: string) => readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');
const htmlSource = read('index.html');
const appSource = read('app.js');
const cssSource = read('styles.css');

/* ---------- стенд ---------- */

type Loose = Record<string, any>;
type Win = JSDOM['window'] & Loose;

interface Init {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}
interface StubResult {
  status?: number;
  body: unknown;
  delayMs?: number;
}

const ADMIN_KEY = 'testkey';
const ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'; // объявление на доске
const REQ = 'cccc1111-2222-3333-4444-555555555555'; // встречная заявка
const COLD = 'dddd9999-8888-7777-6666-555555555555'; // есть в API, но не в кэше доски
const DUP = 'eeee0000-1111-2222-3333-444444444444'; // уже опубликованный «оригинал»

const BOARD_DESC = 'Еду 20 мая, возьму одну сумку до 10 кг';
const FRESH_MARK = '(данные с сервера свежее)';

/** Что может подкрутить тест: задержка сети и поведение админки. */
const server = {
  detailDelayMs: 0,
  approvedDuplicate: null as Loose | null,
  cleanedIds: [] as string[],
  reports: [] as string[],
};

function listing(over: Loose = {}): Loose {
  return {
    id: ID,
    type: 'offer',
    status: 'published',
    fromCity: 'Варшава',
    toCity: 'Минск',
    description: BOARD_DESC,
    departureDate: '2030-05-20',
    weightKg: 8,
    price: '30 BYN',
    telegram: '@ivan_waw',
    phone: null,
    source: 'telegram',
    sourceChat: 'Переслано от Иван',
    sourceChatId: null,
    sourceMessageId: null,
    views: 12,
    createdAt: '2026-09-10T08:00:00.000Z',
    publishedAt: '2026-09-10T08:05:00.000Z',
    ...over,
  };
}

/** Заглушка сети: роутер по пути + журнал запросов. */
function makeFetch(calls: string[]) {
  return async (input: unknown, init: Init = {}) => {
    const url = String(input);
    const method = String(init.method || 'GET').toUpperCase();
    calls.push(`${method} ${url}`);
    const [path, query = ''] = url.split('?') as [string, string];
    const q = new URLSearchParams(query);
    const authed = init.headers?.Authorization === `Bearer ${ADMIN_KEY}`;
    const r: StubResult = (() => {
      if (path === '/api/config') {
        return { body: { siteName: 'попутка.', botUsername: 'poputka_bot', botLink: 'https://t.me/poputka_bot' } };
      }
      if (path === '/api/chat-links') return { body: { links: {} } };

      if (path === '/api/listings') {
        const items = [listing(), listing({ id: REQ, type: 'request', fromCity: 'Минск', toCity: 'Варшава', telegram: null })];
        const filtered = q.get('type') ? items.filter((l) => l.type === q.get('type')) : items;
        return { body: { items: filtered, hasMore: false, page: 1, total: filtered.length, counts: { offer: 1, request: 1 } } };
      }
      if (/^\/api\/listings\/[^/]+$/.test(path)) {
        const id = decodeURIComponent(path.slice('/api/listings/'.length));
        const known: Loose = { [ID]: listing(), [REQ]: listing({ id: REQ, type: 'request' }), [COLD]: listing({ id: COLD, description: `${BOARD_DESC} ${FRESH_MARK}` }) };
        const item = known[id];
        if (!item) return { status: 404, body: { error: 'not_found' } };
        return {
          body: { item: { ...item, description: `${item.description} ${FRESH_MARK}` } },
          delayMs: server.detailDelayMs,
        };
      }
      if (/^\/api\/listings\/[^/]+\/report$/.test(path) && method === 'POST') {
        server.reports.push(JSON.parse(init.body || '{}').reason || '');
        return { body: { ok: true, message: 'Жалоба принята, спасибо.' } };
      }

      /* админка */
      if (path.startsWith('/api/admin/') && !authed) return { status: 401, body: { error: 'unauthorized' } };
      if (path === '/api/admin/listings') {
        if (q.get('tab') === 'pending') {
          return {
            body: {
              items: [
                listing({
                  id: DUP,
                  status: 'pending',
                  publishedAt: null,
                  description: 'Та же заявка, пересланная на следующий день',
                  duplicate: { id: ID, kind: 'duplicate', status: 'published', fromCity: 'Варшава', toCity: 'Минск', departureDate: '2030-05-20', why: 'тот же маршрут и даты, контакт совпадает' },
                }),
              ],
            },
          };
        }
        return { body: { items: [listing()] } };
      }
      if (/^\/api\/admin\/listings\/[^/]+\/status$/.test(path) && method === 'POST') {
        return { body: { ok: true, duplicate: server.approvedDuplicate } };
      }
      if (path === '/api/admin/duplicates') {
        return {
          body: {
            total: 6,
            extraCount: 2,
            groups: [
              {
                why: 'тот же маршрут, даты и контакт',
                keep: listing(),
                duplicates: [
                  listing({ id: REQ, publishedAt: '2026-09-11T08:00:00.000Z' }),
                  listing({ id: DUP, status: 'pending', publishedAt: null }),
                ],
              },
            ],
          },
        };
      }
      if (path === '/api/admin/duplicates/clean' && method === 'POST') {
        const ids = (JSON.parse(init.body || '{}').ids || []) as string[];
        server.cleanedIds.push(...ids);
        return { body: { ok: true, deleted: ids.length } };
      }
      return { status: 404, body: { error: 'not_found' } };
    })();

    if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  };
}

let dom: JSDOM;
let win: Win;
let calls: string[] = [];
const pageErrors: string[] = [];

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
/** Дать скрипту доработать: макротаски + микрозадачи промисов. */
const settle = (ms = 40) => sleep(ms);

const byId = (id: string): HTMLElement => {
  const node = win.document.getElementById(id);
  if (!node) throw new Error(`в public/index.html нет #${id}`);
  return node as HTMLElement;
};
const text = (id: string) => byId(id).textContent || '';
/** Переход по хешу: jsdom применяет смену адреса асинхронно, поэтому ждём. */
async function goto(hash: string, ms = 60) {
  win.location.hash = hash;
  await settle(ms);
}
const rows = () => Array.from(win.document.querySelectorAll('#list article.row')) as HTMLElement[];

beforeAll(async () => {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e: Error) => {
    // window.scrollTo в jsdom не реализован — на проверки это не влияет
    if (!/Not implemented/.test(e.message)) pageErrors.push(e.message);
  });
  dom = new JSDOM(htmlSource, {
    url: 'http://localhost/#/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  win = dom.window as Win;
  win.fetch = makeFetch(calls) as unknown as typeof fetch;
  win.eval(appSource);
  await settle(80); // init(): /api/config, /api/chat-links, первая отрисовка доски
});

afterAll(() => {
  dom?.window?.close();
});

/* ---------- доска ---------- */

describe('доска: строка объявления', () => {
  it('строка — настоящая ссылка, а не div с onclick', () => {
    const row = rows()[0]!;
    const link = row.querySelector('a.row-link') as HTMLAnchorElement | null;
    expect(link, 'в строке должна быть растянутая ссылка .row-link').not.toBeNull();
    expect(link!.getAttribute('href')).toBe(`#/item/${ID}`);
    expect(link!.getAttribute('aria-label')).toContain('Варшава → Минск');
    // никаких костылей для «кликабельного div»: переход делает браузер
    expect(row.hasAttribute('tabindex')).toBe(false);
    expect(row.hasAttribute('role')).toBe(false);
  });

  it('в строке видны маршрут, дата, контакт и «пожаловаться»', () => {
    const row = rows()[0]!;
    const t = row.textContent || '';
    expect(t).toContain('Варшава');
    expect(t).toContain('Минск');
    expect(t).toContain('выезд 20 мая');
    expect(t).toContain('8 кг');
    expect(t).toContain('водитель везёт');
    expect(row.querySelector('a.write-link[href="https://t.me/ivan_waw"]'), 'кнопка «написать»').not.toBeNull();
    expect(row.querySelector('a.report-link'), 'ссылка «пожаловаться»').not.toBeNull();
  });

  it('на сайте не видно, чем разобран текст (никаких упоминаний ИИ)', () => {
    const t = `${byId('list').textContent} ${byId('item-detail').textContent}`.toLowerCase();
    expect(t).not.toContain('ии');
    expect(t).not.toContain('нейросет');
    expect(t).not.toContain('gpt');
  });

  it('фильтр по типу уходит в запрос', async () => {
    calls.length = 0;
    const tab = win.document.querySelector('.tab[data-type="offer"]') as HTMLElement;
    tab.click();
    await settle(60);
    expect(calls.some((c) => c.includes('/api/listings?') && c.includes('type=offer'))).toBe(true);
    (win.document.querySelector('.tab[data-type=""]') as HTMLElement).click(); // вернуть «все»
    await settle(60);
  });
});

describe('карточка: отклик на нажатие (INP)', () => {
  it('нажатие и наведение на строку не дёргают API — просмотры не накручиваются', async () => {
    await goto('#/');
    calls.length = 0;
    const row = rows()[0]!;
    const link = row.querySelector('a.row-link') as HTMLAnchorElement;
    // GET карточки засчитывает просмотр, поэтому до перехода запросов быть не должно:
    // палец касается строки и при прокрутке списка, мышь проходит по строкам подряд
    link.dispatchEvent(new win.Event('pointerdown', { bubbles: true }));
    row.dispatchEvent(new win.Event('pointerover', { bubbles: true }));
    link.focus();
    await settle(60);
    expect(calls.filter((c) => c.includes('/api/listings/'))).toEqual([]);
  });

  it('клик по строке открывает карточку в тот же кадр, не дожидаясь сети', async () => {
    server.detailDelayMs = 300; // «медленная» сеть: как раз то, на что жаловалась аналитика
    calls.length = 0;
    const link = rows()[0]!.querySelector('a.row-link') as HTMLAnchorElement;
    link.dispatchEvent(new win.Event('pointerdown', { bubbles: true }));
    link.click();
    await settle(20); // jsdom применяет переход по якорю асинхронно

    expect(win.location.hash, 'переход по ссылке должен сработать без JS-обработчика').toBe(`#/item/${ID}`);
    const detail = byId('item-detail');
    expect(byId('view-item').hidden).toBe(false);
    expect(detail.textContent, 'карточка нарисована сразу, из данных строки').toContain(BOARD_DESC);
    expect(detail.textContent).toContain('Варшава');
    expect(detail.textContent).not.toContain('достаю карточку');
    expect(detail.textContent, 'сеть ещё не ответила — ждём обновления').not.toContain(FRESH_MARK);

    await settle(400);
    expect(detail.textContent, 'после ответа сеть обновила карточку').toContain(FRESH_MARK);
  });

  it('на одно объявление — ровно один запрос', () => {
    const detailCalls = calls.filter((c) => c === `GET /api/listings/${ID}`);
    expect(detailCalls).toHaveLength(1);
  });

  it('по прямой ссылке (кэша нет) честно пишет «достаю карточку…»', async () => {
    server.detailDelayMs = 200;
    await goto(`#/item/${COLD}`, 30);
    expect(byId('item-detail').textContent, 'без кэша честно показываем ожидание').toContain('достаю карточку');
    await settle(300);
    const t = byId('item-detail').textContent || '';
    expect(t).toContain(BOARD_DESC);
    expect(t).toContain(FRESH_MARK);
    expect(t).toContain('написать @ivan_waw');
  });

  it('несуществующее объявление — понятная заглушка и путь назад', async () => {
    server.detailDelayMs = 0;
    await goto('#/item/nope-0000');
    const t = byId('item-detail').textContent || '';
    expect(t).toContain('Такого объявления нет');
    expect(byId('item-detail').querySelector('a[href="#/"]'), 'ссылка «← к доске»').not.toBeNull();
  });

  it('«пожаловаться» в строке не уводит с доски', async () => {
    await goto('#/');
    win.prompt = () => 'спам';
    calls.length = 0;
    (rows()[0]!.querySelector('a.report-link') as HTMLElement).click();
    await settle(60);
    expect(win.location.hash, 'hash не должен меняться').toBe('#/');
    expect(calls).toContain(`POST /api/listings/${ID}/report`);
    expect(server.reports).toContain('спам');
    expect(text('toast')).toContain('Жалоба принята');
  });
});

describe('CSS строки', () => {
  it('ссылка растянута на строку, а кнопки внутри — поверх неё', () => {
    expect(cssSource).toMatch(/\.row-link \{[^}]*position: absolute; inset: 0/);
    expect(cssSource).toMatch(/\.row-side a, \.row-side button \{[^}]*z-index: 1/);
  });

  it('строки вне экрана не перерисовываются, нажатие подсвечивается сразу', () => {
    expect(cssSource).toMatch(/\.row \{[^}]*content-visibility: auto/);
    expect(cssSource).toMatch(/\.row \{[^}]*contain-intrinsic-size/);
    expect(cssSource).toMatch(/\.row:active/);
  });
});

/* ---------- админка ---------- */

describe('админка', () => {
  it('без ключа показывает форму входа', async () => {
    await goto('#/admin');
    expect(byId('admin-login').hidden).toBe(false);
    expect(byId('admin-panel').hidden).toBe(true);
  });

  it('с ключом — очередь модерации и предупреждение о повторе', async () => {
    (byId('admin-key') as HTMLInputElement).value = ADMIN_KEY;
    byId('admin-key-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    await settle(80);

    expect(byId('admin-panel').hidden).toBe(false);
    expect(text('admin-count')).toContain('Необработано заявок: 1');
    const warn = win.document.querySelector('#admin-list .dup-warn') as HTMLElement | null;
    expect(warn, 'у повтора должен быть бейдж').not.toBeNull();
    expect(warn!.textContent).toContain('Это повтор');
    expect(warn!.textContent).toContain('тот же маршрут и даты');
    expect((warn!.querySelector('a') as HTMLAnchorElement).getAttribute('href')).toBe(`#/item/${ID}`);
  });

  it('одобрение дубля предупреждает, что такая заявка уже на доске', async () => {
    server.approvedDuplicate = listing();
    const approve = Array.from(win.document.querySelectorAll('#admin-list button')).find((b) => b.textContent === 'одобрить') as HTMLElement;
    expect(approve, 'кнопка «одобрить»').toBeTruthy();
    approve.click();
    await settle(80);
    expect(calls.filter((c) => c.includes('/status')).length).toBeGreaterThan(0);
    expect(text('toast')).toContain('Опубликовано.');
    expect(text('toast')).toContain(`уже есть такая заявка № ${ID.slice(0, 8)}`);
    server.approvedDuplicate = null;
  });

  it('вкладка «повторы»: группы, что оставить, удаление копий', async () => {
    byId('admin-tab-dupes').click();
    await settle(80);
    const t = text('admin-count');
    expect(t).toContain('Групп повторов: 1');
    expect(t).toContain('лишних заявок: 2');

    const keep = win.document.querySelector('.dupe-line.dupe-keep') as HTMLElement;
    expect(keep.textContent).toContain('оставить');
    expect(keep.querySelector('button'), 'у оставляемой заявки кнопки удаления нет').toBeNull();
    expect(win.document.querySelectorAll('.dupe-line button')).toHaveLength(2);

    win.confirm = () => true;
    calls.length = 0;
    server.cleanedIds = [];
    (Array.from(win.document.querySelectorAll('#admin-list button')).find((b) => b.textContent?.startsWith('удалить все копии')) as HTMLElement).click();
    await settle(120);

    expect(calls).toContain('POST /api/admin/duplicates/clean');
    expect(server.cleanedIds).toEqual([REQ, DUP]);
    expect(text('toast')).toContain('Удалено копий: 2');
  });

  it('«выйти» убирает ключ и возвращает форму входа', async () => {
    byId('admin-logout').click();
    await settle(60);
    expect(win.localStorage.getItem('popoutka_admin_key')).toBeNull();
    expect(byId('admin-login').hidden).toBe(false);
  });
});

describe('здоровье страницы', () => {
  it('за всё время теста не было необработанных ошибок скрипта', () => {
    expect(pageErrors).toEqual([]);
  });
});
