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
  body?: unknown;
  /** сырой текст ответа — для CSV, где JSON.stringify исказил бы файл */
  raw?: string;
  delayMs?: number;
}

const ADMIN_KEY = 'testkey';
const ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890'; // объявление на доске
const REQ = 'cccc1111-2222-3333-4444-555555555555'; // встречная заявка
const COLD = 'dddd9999-8888-7777-6666-555555555555'; // есть в API, но не в кэше доски
const DUP = 'eeee0000-1111-2222-3333-444444444444'; // уже опубликованный «оригинал»
const NOCONTACT = 'abab1212-3434-5656-7878-909090909090'; // заявка без контакта
const HIDDEN = 'cdcd3434-5656-7878-9090-121212121212'; // «ищу попутчика» с сайта без контакта

const BOARD_DESC = 'Еду 20 мая, возьму одну сумку до 10 кг';
const FRESH_MARK = '(данные с сервера свежее)';

/** Что может подкрутить тест: задержка сети и поведение админки. */
const server = {
  detailDelayMs: 0,
  approvedDuplicate: null as Loose | null,
  cleanedIds: [] as string[],
  reports: [] as string[],
  pendingNoContact: false, // вторая заявка в очереди — без контакта
  mediaCreds: null as Loose | null, // сохранённые в админке логин/пароль медиакита
  pendingTotal: 0, // настоящее число очереди с сервера (COUNT), 0 — не подменять
  dupesPruned: 0, // сколько явных повторов отклонено до показа очереди
  replacedWith: null as { id: string; deleteId: string } | null,
  forumResetPosts: 0, // сколько раз админка сбрасывала счётчики канала
  forumStatsGets: 0, // сколько раз вкладка «канал» забирала статистику
  boardOver: null as Loose | null, // override карточки вкладки «доска»
  archiveFarPosts: 0, // сколько раз админка убирала с доски аномальные даты
  csvGets: 0, // сколько раз админка выгружала заявки в таблицу
  csvAuth: null as string | null, // пришёл ли ключ админки заголовком
  csvQuery: null as string | null, // какую область попросили: ?status=…
  boardOddGets: 0, // сколько раз доска запрашивала фильтр аномальных дат
  farArchivedStub: 0, // >0 — сервер говорит «все аномальные уже в архиве»
  matchHidden: [] as Array<{ key: string; label: string }>,
  autoStatsGets: 0,                 // сколько раз вкладка «итоги» спросила счётчики автоодобрения
  autoStatsQuery: '',               // с каким окном (days) спросили
  autoStatsOver: null as Loose | null, // подменить сводку (пустые счётчики, сбой)
  matchPairs: [
    {
      score: 80, reasons: ['маршрут', 'даты рядом'],
      offer: {
        id: 'm1', fromCity: 'Варшава', toCity: 'Минск', departureDate: '2030-05-20',
        contacts: ['@stale_guy'], description: 'везу', status: 'published',
        // происхождение до сообщения: ссылка на исходное в публичном чате с темой
        sourceChat: 'Граница BY-LT-PL', sourceChatId: '-1001234567890',
        sourceMessageId: 153048, sourceChatUsername: 'granica_BY_LT_PL', sourceThreadId: 153043,
      },
      // заявка без контакта: скрыть юзернеймом нельзя — только по id заявки
      request: { id: 'm2', fromCity: 'Варшава', toCity: 'Минск', departureDate: '2030-05-21', contacts: [], description: 'передать', status: 'published' },
    },
    {
      score: 70, reasons: ['маршрут'],
      offer: { id: 'm3', fromCity: 'Краков', toCity: 'Львов', departureDate: '2030-05-22', contacts: ['@fresh'], description: 'везу', status: 'published' },
      request: { id: 'm4', fromCity: 'Краков', toCity: 'Львов', departureDate: '2030-05-22', contacts: ['@other2'], description: 'передать', status: 'published' },
    },
  ],
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
        return { body: { siteName: 'попутка.', version: '9.9.9', botUsername: 'poputka_bot', botLink: 'https://t.me/poputka_bot' } };
      }
      if (path === '/api/chat-links') return { body: { links: {} } };

      if (path === '/api/listings' && method === 'POST') {
        // «ищу попутчика» с сайта без контакта: публикуется, но скрыта с доски
        return {
          status: 201,
          body: {
            item: listing({ id: HIDDEN, type: 'request', status: 'published', hidden: true, telegram: null, phone: null }),
            hidden: true,
            message: 'Заявка принята: подбираем попутчика по вашему маршруту. Как найдём — объявление появится на доске.',
          },
        };
      }
      if (path === '/api/listings') {
        const items = [listing(), listing({
          id: REQ, type: 'request', fromCity: 'Минск', toCity: 'Варшава', telegram: null,
          // маршрут-цепочка: клиент рисует «Минск … Варшава» с городами при наведении
          stops: ['Минск', 'Брест', 'Варшава'],
          // происхождение: публичная строка показывает только подпись чата
          sourceChat: 'Граница BY-LT-PL', sourceChatId: '-1001234567890', sourceMessageId: 42,
          sourceChatUsername: 'granica_BY_LT_PL', sourceThreadId: 7,
        })];
        const filtered = q.get('type') ? items.filter((l) => l.type === q.get('type')) : items;
        return { body: { items: filtered, hasMore: false, page: 1, total: filtered.length, counts: { offer: 1, request: 1 } } };
      }
      if (/^\/api\/listings\/[^/]+$/.test(path)) {
        const id = decodeURIComponent(path.slice('/api/listings/'.length));
        const known: Loose = {
          [ID]: listing(),
          [REQ]: listing({ id: REQ, type: 'request', stops: ['Минск', 'Брест', 'Варшава'] }),
          [COLD]: listing({ id: COLD, description: `${BOARD_DESC} ${FRESH_MARK}` }),
          [HIDDEN]: listing({ id: HIDDEN, type: 'request', status: 'published', hidden: true, telegram: null, phone: null }),
        };
        const item = known[id];
        if (!item) return { status: 404, body: { error: 'not_found' } };
        return {
          body: {
            item: { ...item, description: `${item.description} ${FRESH_MARK}` },
            // как настоящий GET /api/listings/:id: из этого клиент собирает
            // крошки и блок «Ещё по этому маршруту» (иначе карточка беднее SSR)
            related: [listing({ id: REQ, type: 'request' })].filter((x) => x.id !== id),
            routePath: '/r/varshava-minsk',
            cityPath: '/gorod/varshava',
          },
          delayMs: server.detailDelayMs,
        };
      }
      if (/^\/api\/listings\/[^/]+\/report$/.test(path) && method === 'POST') {
        server.reports.push(JSON.parse(init.body || '{}').reason || '');
        return { body: { ok: true, message: 'Жалоба принята, спасибо.' } };
      }

      /* админка */
      if (path.startsWith('/api/admin/') && !authed) return { status: 401, body: { error: 'unauthorized' } };
      if (path === '/api/admin/listings.csv') {
        server.csvGets += 1;
        server.csvAuth = authed ? 'ok' : 'none';
        server.csvQuery = query;
        // как отдаёт сервер: BOM, CRLF, разделитель «;», две заявки
        return { raw: '\uFEFF"id";"статус"\r\n"x1";"на доске"\r\n"y2";"в архиве"\r\n' };
      }
      if (path === '/api/admin/listings') {
        if (q.get('tab') === 'pending') {
          const items = [
            listing({
              id: DUP,
              status: 'pending',
              publishedAt: null,
              byAdmin: true, // пересылка от админского Telegram — как пометит воркер
              description: 'Та же заявка, пересланная на следующий день',
              // происхождение с точностью до сообщения: админу — ссылка в карточке
              sourceChat: 'Граница BY-LT-PL', sourceChatId: '-1001234567890',
              sourceMessageId: 153048, sourceChatUsername: 'granica_BY_LT_PL', sourceThreadId: 153043,
              duplicate: { id: ID, kind: 'duplicate', status: 'published', fromCity: 'Варшава', toCity: 'Минск', departureDate: '2030-05-20', why: 'тот же маршрут и даты, контакт совпадает' },
            }),
          ];
          if (server.pendingNoContact) {
            items.push(listing({
              id: NOCONTACT,
              status: 'pending',
              publishedAt: null,
              telegram: null,
              phone: null,
              source: 'site',
              sourceChat: null,
              fromPerson: true, // сайт без ключа админки — как пометит воркер
              description: 'Возьму посылку по пути, пишите в чат',
            }));
          }
          // сервер выметает просроченные заявки до показа очереди;
          // pendingTotal — настоящее число очереди (COUNT), не длина списка
          return { body: { items, pruned: 1, ...(server.dupesPruned ? { dupesPruned: server.dupesPruned } : {}), ...(server.pendingTotal ? { pendingTotal: server.pendingTotal } : {}) } };
        }
        // доска: odd=1 — только аномальные даты (дальше 90 дней); farCount —
        // такие НА доске (published), farArchived — уже в архиве (expired)
        const isFar = (x: Loose) => x.departureDate && !x.recurring
          && (new Date(`${x.departureDate}T00:00:00`).getTime() - Date.now()) / 86400000 > 90;
        const farSplit = (xs: Loose[]) => ({
          farCount: xs.filter((x) => x.status === 'published').length,
          farArchived: xs.filter((x) => x.status !== 'published').length,
        });
        if (q.get('odd') === '1') {
          server.boardOddGets += 1;
          const oddItems = [listing(server.boardOver ?? {})].filter(isFar);
          return { body: { items: oddItems, ...farSplit(oddItems) } };
        }
        const items = [listing(server.boardOver ?? {})];
        const far = farSplit(items.filter(isFar));
        return {
          body: {
            items,
            // farArchivedStub — сценарий «все аномальные уже в архиве»
            farCount: server.farArchivedStub ? 0 : far.farCount,
            farArchived: server.farArchivedStub || far.farArchived,
          },
        };
      }
      if (path === '/api/admin/mediakit-creds') {
        if (method === 'POST') {
          calls.push(`SAVED ${String(init.body ?? '')}`);
          server.mediaCreds = JSON.parse(String(init.body ?? '{}')) as Loose;
          return { body: { ok: true, source: 'db', login: server.mediaCreds.login } };
        }
        return server.mediaCreds
          ? { body: { login: server.mediaCreds.login, source: 'db' } }
          : { body: { login: null, source: 'env' } };
      }
      if (path === '/api/admin/seo') {
        return {
          body: {
            domain: 'pop-utka.app',
            ai: {
              runs: [
                { id: 'w1', kind: 'wayback', label: 'wayback', pages: 3, urls: [], checkedAt: '2026-09-28T10:00:00Z' },
                { id: 'c1', kind: 'commoncrawl', label: 'CC-MAIN-2026-30', pages: 12, urls: ['https://pop-utka.app/', 'https://pop-utka.app/routes'], checkedAt: '2026-09-28T10:00:00Z' },
              ],
            },
            serp: {
              keyMissing: false,
              lastCheckAt: '2026-09-28T10:00:00Z',
              queries: [
                { id: 'q01', engine: 'google', query: 'передать посылку варшава минск', last: { position: 7, foundUrl: 'https://pop-utka.app/', top: [] }, prev: { position: 9, foundUrl: null, top: [] } },
                { id: 'q11', engine: 'yandex', query: 'попутка передача посылок', last: { position: null, foundUrl: null, top: ['site1.by', 'site2.by'] }, prev: null },
              ],
            },
          },
        };
      }
      if (/^\/api\/admin\/listings\/[^/]+\/status$/.test(path) && method === 'POST') {
        return { body: { ok: true, duplicate: server.approvedDuplicate } };
      }
      if (/^\/api\/admin\/listings\/([^/]+)\/replace$/.test(path) && method === 'POST') {
        const { deleteId } = JSON.parse(init.body || '{}') as { deleteId?: string };
        server.replacedWith = { id: decodeURIComponent(path.split('/').slice(-2)[0] ?? ''), deleteId: deleteId ?? '' };
        return { body: { ok: true, deleted: true, item: listing({ status: 'published' }) } };
      }
      if (path === '/api/admin/stats') {
        return {
          body: {
            months: [{
              month: '2026-09', offers: 1, requests: 1, total: 2, cities: 2, directions: 1,
              topDirections: [{ pair: 'Варшава → Минск', from: 'Варшава', to: 'Минск', count: 2 }],
              fromChats: 1, fromSite: 1, priced: 1, free: 1, prices: [],
              updatedAt: '2026-09-22 10:00:00', post: 'текст поста', path: '/itogi/2026-09', summary: null,
            }],
            currentMonth: '2026-09',
            post: 'текст поста',
            updatedAt: '2026-09-22 10:00:00',
            flow: {
              days: [
                { day: '2026-09-21', arrived: 5, approved: 3, rejected: 1, offers: 3, requests: 2 },
                { day: '2026-09-22', arrived: 2, approved: 2, rejected: 0, offers: 1, requests: 1 },
              ],
              weeks: [{ key: '2026-09-21', label: '2026-09-21 · неделя', arrived: 7, approved: 5, rejected: 1, offers: 4, requests: 3 }],
              months: [{ key: '2026-09', label: '2026-09', arrived: 7, approved: 5, rejected: 1, offers: 4, requests: 3 }],
            },
            topViewed: [
              { id: ID, fromCity: 'Варшава', toCity: 'Минск', views: 42, status: 'published', departureDate: '2030-05-20', createdAt: '2026-09-10T08:00:00.000Z', path: `/item/${ID}` },
            ],
            topUsernames: {
              rows: [
                { username: '@ivan', total: 7, offers: 5, requests: 2, lastAt: '2026-09-20 12:00:00' },
                { username: '@maria', total: 3, offers: 0, requests: 3, lastAt: null },
              ],
              withContact: 10,
            },
            carry: {
              total: 100,
              categories: [
                { key: 'docs', label: 'Документы', total: 40, offers: 30, requests: 10, last30: 12 },
              ],
              other: { key: 'other', label: 'Прочее (без ключевых слов)', total: 60, offers: 50, requests: 10, last30: 20 },
            },
          },
        };
      }
      if (path === '/api/admin/auto-stats') {
        server.autoStatsGets += 1;
        server.autoStatsQuery = String(q.get('days') ?? '');
        if (server.autoStatsOver) {
          // сценарий сбоя: счётчики не приехали, остальные итоги должны остаться
          if (server.autoStatsOver.status) return server.autoStatsOver as StubResult;
          return { body: server.autoStatsOver };
        }
        return {
          body: {
            days: Number(q.get('days') ?? 30),
            since: '2026-08-24',
            byDay: [
              { day: '2026-09-21', adminArrived: 6, autoPublished: 4, held: 2, dupSkipped: 1, rejectedNoContact: 0 },
              { day: '2026-09-22', adminArrived: 3, autoPublished: 3, held: 0, dupSkipped: 0, rejectedNoContact: 1 },
            ],
            totals: { adminArrived: 9, autoPublished: 7, held: 2, dupSkipped: 1, rejectedNoContact: 1 },
            reasons: [
              { code: 'ai_parsed', note: 'разобрал ИИ, уверенность ниже порога', n: 1 },
              { code: 'date_past', note: 'дата выезда уже прошла', n: 1 },
            ],
          },
        };
      }
      if (path === '/api/admin/forum-stats') {
        server.forumStatsGets += 1;
        return {
          body: {
            configured: true, days: 30, arrived: 50, published: 20, posted: 12, inRooms: 8, inFallback: 4,
            rooms: [
              { thread: 55, label: 'Беларусь ↔ Польша', kind: 'регион', posts: 6 },
              { thread: 99, label: 'прочее', kind: 'прочее', posts: 4 },
              { thread: 77, label: 'Дубай', kind: 'город', posts: 2 },
            ],
            fallbackTop: [
              { from: 'Минск', to: 'Москва', posts: 3 },
              { from: 'Прага', to: 'Будапешт', posts: 1 },
            ],
          },
        };
      }
      if (path === '/api/admin/forum-stats/reset' && method === 'POST') {
        server.forumResetPosts += 1;
        return { body: { ok: true } };
      }
      if (path === '/api/admin/board/archive-far' && method === 'POST') {
        server.archiveFarPosts += 1;
        // после архивирования доска чистая: ближайшая дата вместо 2030 года
        server.boardOver = { departureDate: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10) };
        return { body: { ok: true, archived: 1 } };
      }
      const mKey = (contact: string) => {
        const digits = String(contact).replace(/\D/g, '');
        return digits.length >= 9 ? `ph:${digits.slice(-9)}` : `tg:${String(contact).replace(/^@/, '').toLowerCase()}`;
      };
      if (path === '/api/admin/match' && method === 'GET') return { body: { runs: [] } };
      if (path === '/api/admin/match/hidden') return { body: { hidden: server.matchHidden } };
      if (path === '/api/admin/match/hide' && method === 'POST') {
        const { contact, hide, listingId, label } = JSON.parse(init.body || '{}') as {
          contact?: string; hide?: boolean; listingId?: string; label?: string;
        };
        // заявка без контакта скрывается ключом id:<uuid> (как в воркере)
        const key = listingId ? `id:${listingId}` : mKey(contact ?? '');
        const lbl = listingId ? (label ?? `заявка ${listingId.slice(0, 8)}`) : (contact ?? '');
        server.matchHidden = hide !== false
          ? (server.matchHidden.some((h) => h.key === key) ? server.matchHidden : [...server.matchHidden, { key, label: lbl }])
          : server.matchHidden.filter((h) => h.key !== key);
        return { body: { ok: true, key, hidden: server.matchHidden } };
      }
      if (path === '/api/admin/match' && method === 'POST') {
        const hidden = new Set(server.matchHidden.map((h) => h.key));
        const pairs = server.matchPairs.filter((p) =>
          ![...(p.offer.contacts ?? []), ...(p.request.contacts ?? [])].some((c) => hidden.has(mKey(c)))
          && !hidden.has(`id:${p.offer.id}`) && !hidden.has(`id:${p.request.id}`));
        return {
          body: {
            run: { id: 'run1', createdAt: '2026-09-22T10:00:00.000Z', daysWindow: 3, offersTotal: 2, requestsTotal: 2, pairsFound: pairs.length, notified: false, includeArchive: false, partial: false, note: '' },
            stats: { offers: 2, requests: 2, pairs: pairs.length, rejected: { route: 0, date_gap: 0, weight: 0, same_contact: 0, archived: 0 } },
            hiddenPairs: server.matchPairs.length - pairs.length,
            pairs,
          },
        };
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
      // настоящий Response.text() СНИМАЕТ BOM (спецификация) — заглушка обязана
      // вести себя так же, иначе тест не заметит потерю BOM при скачивании
      text: async () => {
        const raw = r.raw ?? JSON.stringify(r.body);
        return raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
      },
      // arrayBuffer BOM не снимает — на разнице и ловим баг
      arrayBuffer: async () => new TextEncoder().encode(r.raw ?? JSON.stringify(r.body)).buffer,
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
/** Переход по адресу: как кнопка «назад» в браузере (pushState + popstate). */
async function goto(path: string, ms = 60) {
  win.history.pushState(null, '', path);
  win.dispatchEvent(new win.Event('popstate'));
  await settle(ms);
}
const rows = () => Array.from(win.document.querySelectorAll('#list article.row')) as HTMLElement[];
/** Текстовый узел в обёртке <p> — для «серверного» контента в тестах. */
function elText(t: string): HTMLElement {
  const n = win.document.createElement('p');
  n.textContent = t;
  return n;
}

beforeAll(async () => {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e: Error) => {
    // window.scrollTo в jsdom не реализован — на проверки это не влияет
    if (!/Not implemented/.test(e.message)) pageErrors.push(e.message);
  });
  dom = new JSDOM(htmlSource, {
    url: 'http://localhost/',
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

describe('ссылка на Telegram-канал', () => {
  it('в шапке, подвале, странице бота и сноской под вводным абзацем', () => {
    const links = htmlSource.match(/href="https:\/\/t\.me\/parcel_info"/g) ?? [];
    expect(links.length, 'ссылок на канал должно быть минимум четыре').toBeGreaterThanOrEqual(4);
    // сноска на главной: сразу под lead, ссылка — телеграм-синяя
    expect(htmlSource).toContain('Одобренные заявки также публикуются в');
    expect(htmlSource).toContain('lead-note');
    expect(cssSource).toMatch(/\.lead-note a \{ color: #2481cc; \}/);
  });
});

describe('доска: строка объявления', () => {
  it('строка — настоящая ссылка, а не div с onclick', () => {
    const row = rows()[0]!;
    const link = row.querySelector('a.row-link') as HTMLAnchorElement | null;
    expect(link, 'в строке должна быть растянутая ссылка .row-link').not.toBeNull();
    expect(link!.getAttribute('href')).toBe(`/item/${ID}`);
    expect(link!.getAttribute('aria-label')).toContain('Варшава → Минск');
    // никаких костылей для «кликабельного div»: переход делает браузер
    expect(row.hasAttribute('tabindex')).toBe(false);
    expect(row.hasAttribute('role')).toBe(false);
  });

  it('на телефоне плашка типа встаёт в строку маршрута, действия — в одну оставшуюся строку', () => {
    const row = rows()[0]!;
    const inRoute = row.querySelector('.route-line .stamp-route') as HTMLElement | null;
    expect(inRoute, 'дубль плашки в маршруте (CSS показывает его на ≤640px)').not.toBeNull();
    expect(inRoute!.textContent).toBe('водитель везёт');
    expect(row.querySelector('.row-side .stamp-side'), 'плашка в правом столбце (десктоп)').not.toBeNull();
    // десктоп: дубль в маршруте скрыт; телефон: плашка в столбце скрыта,
    // остальные чипы переносятся вместо вылета за экран
    expect(cssSource).toMatch(/\.stamp-route \{ display: none; \}/);
    expect(cssSource).toContain('.route-line .stamp-route { display: inline-block;');
    expect(cssSource).toContain('.row-side .stamp-side { display: none; }');
    expect(cssSource).toMatch(/\.row-side \{[^}]*flex-wrap: wrap/);
  });

  it('маршрут-цепочка: «Минск … Варшава», все города видны при наведении', () => {
    const row = rows()[1]!;
    const via = row.querySelector('.r-arrow.r-via') as HTMLElement | null;
    expect(via, 'многоточие вместо стрелки').not.toBeNull();
    expect(via!.textContent).toBe('…');
    expect(via!.getAttribute('title')).toBe('Минск → Брест → Варшава');
    expect(via!.getAttribute('aria-label')).toBe('через Брест');
    const link = row.querySelector('a.row-link') as HTMLAnchorElement;
    expect(link.getAttribute('aria-label')).toContain('Минск → Брест → Варшава: открыть объявление');
    // обычная пара городов — прежняя стрелка
    expect(rows()[0]!.querySelector('.r-arrow')!.textContent).toBe('→');
    expect(rows()[0]!.querySelector('.r-via')).toBeNull();
  });

  it('строка с доски: чат-источник подписан, ссылка на сообщение не видна', () => {
    // происхождение («что откуда сообщение») — данные админов: публично
    // остаётся только подпись чата, без t.me/c/… и без username-ссылки
    const row = rows().find((r) => (r.textContent || '').startsWith('Минск'));
    expect(row, 'строка встречной заявки').toBeTruthy();
    expect(row!.textContent).toContain('из чата «Граница BY-LT-PL»');
    expect(row!.innerHTML).not.toContain('t.me/c/');
    expect(row!.innerHTML).not.toContain('granica_BY_LT_PL');
  });

  it('приватный источник не виден в строке доски', () => {
    // объявление ID подано пересылкой («Переслано от Иван»): на сайте
    // подписи источника нет вовсе — span.src не печатается
    // (карточка объявления проверена в INP-тесте: там тот же рендер без сети)
    const row = rows()[0]!;
    expect(row.textContent).not.toContain('Переслано');
    expect(row.querySelector('.src')).toBeNull();
    // чат-источник у встречной заявки остаётся видимым
    const chatRow = rows().find((r) => (r.textContent || '').startsWith('Минск'));
    expect(chatRow!.textContent).toContain('из чата «Граница BY-LT-PL»');
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
    await goto('/');
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

    expect(win.location.pathname, 'переход по ссылке работает штатно, без перезагрузки').toBe(`/item/${ID}`);
    const detail = byId('item-detail');
    expect(byId('view-item').hidden).toBe(false);
    expect(detail.textContent, 'карточка нарисована сразу, из данных строки').toContain(BOARD_DESC);
    expect(detail.textContent).toContain('Варшава');
    expect(detail.textContent).not.toContain('достаю карточку');
    expect(detail.textContent, 'сеть ещё не ответила — ждём обновления').not.toContain(FRESH_MARK);
    // приватный источник («Переслано от Иван»): ячейки «источник» нет
    // ни в карточке из кэша, ни в обновлённой серверной
    expect(detail.textContent).not.toContain('источник');

    await settle(400);
    expect(detail.textContent, 'после ответа сеть обновила карточку').toContain(FRESH_MARK);
    expect(detail.textContent).not.toContain('источник');
  });

  it('на одно объявление — ровно один запрос', () => {
    const detailCalls = calls.filter((c) => c === `GET /api/listings/${ID}`);
    expect(detailCalls).toHaveLength(1);
  });

  it('по прямой ссылке (кэша нет) честно пишет «достаю карточку…»', async () => {
    server.detailDelayMs = 200;
    await goto(`/item/${COLD}`, 30);
    expect(byId('item-detail').textContent, 'без кэша честно показываем ожидание').toContain('достаю карточку');
    await settle(300);
    const t = byId('item-detail').textContent || '';
    expect(t).toContain(BOARD_DESC);
    expect(t).toContain(FRESH_MARK);
    expect(t).toContain('написать @ivan_waw');
  });

  it('несуществующее объявление — понятная заглушка и путь назад', async () => {
    server.detailDelayMs = 0;
    await goto('/item/nope-0000');
    const t = byId('item-detail').textContent || '';
    expect(t).toContain('Такого объявления нет');
    expect(byId('item-detail').querySelector('a[href="/"]'), 'ссылка «← к доске»').not.toBeNull();
  });

  it('«пожаловаться» в строке не уводит с доски', async () => {
    await goto('/');
    win.prompt = () => 'спам';
    calls.length = 0;
    (rows()[0]!.querySelector('a.report-link') as HTMLElement).click();
    await settle(60);
    expect(win.location.pathname, 'адрес не должен меняться').toBe('/');
    expect(calls).toContain(`POST /api/listings/${ID}/report`);
    expect(server.reports).toContain('спам');
    expect(text('toast')).toContain('Жалоба принята');
  });
});

/* Сервер отдаёт карточку объявления прямо в HTML (src/ssr.ts), и она полнее
   клиентской: в ней хлебные крошки и блок «Ещё по этому маршруту». Клиент не
   должен её затирать — иначе через секунду после загрузки контент схлопывается. */
describe('серверная карточка (SSR)', () => {
  const SSR_MARK = 'СЕРВЕРНАЯ КАРТОЧКА с крошками и похожими заявками';

  it('пока открыто то же объявление — серверную карточку не перерисовываем', async () => {
    await goto('/');
    const detail = byId('item-detail');
    detail.dataset.ssr = '1';
    detail.dataset.id = ID;
    detail.replaceChildren(elText(SSR_MARK));

    calls.length = 0;
    await goto(`/item/${ID}`, 250); // и запрос к API успеет ответить

    expect(detail.textContent, 'серверный контент на месте').toContain(SSR_MARK);
    expect(detail.dataset.ssr).toBe('1');
    expect(detail.textContent).not.toContain('достаю карточку');
  });

  it('переход к другому объявлению заменяет серверную карточку', async () => {
    await goto(`/item/${REQ}`, 250);
    const detail = byId('item-detail');
    expect(detail.textContent, 'старая карточка ушла').not.toContain(SSR_MARK);
    expect(detail.dataset.ssr, 'метка серверной карточки снята').toBeUndefined();
    expect(detail.textContent).toContain('Варшава');
    await goto('/');
  });

  it('клиентская карточка рисуется как обычно, если серверной не было', async () => {
    const detail = byId('item-detail');
    detail.removeAttribute('data-ssr');
    detail.removeAttribute('data-id');
    await goto(`/item/${ID}`, 250);
    expect(detail.textContent).toContain(BOARD_DESC);
    await goto('/');
  });
});

/* Открыл заявку кликом с доски — карточку рисует клиент. Она должна быть такой
   же, как при прямой загрузке страницы: те же крошки, тот же блок похожих
   заявок, те же даты. Данные для этого приходят в ответе GET /api/listings/:id. */
describe('карточка после клика с доски', () => {
  const plain = (s: string | null) => (s || '').replace(/\s+/g, ' ').trim();

  it('крошки, заголовок h1, даты с годом и похожие заявки — как на сервере', async () => {
    await goto('/');
    const detail = byId('item-detail');
    detail.removeAttribute('data-ssr');
    detail.removeAttribute('data-id');
    await goto(`/item/${ID}`, 250);

    const crumbs = detail.querySelector('.crumbs') as HTMLElement | null;
    expect(plain(crumbs?.textContent ?? null)).toBe(`Доска › Варшава › Варшава → Минск › № ${ID.slice(0, 8)}`);
    expect(Array.from(crumbs!.querySelectorAll('a')).map((a) => a.getAttribute('href')))
      .toEqual(['/', '/gorod/varshava', '/r/varshava-minsk']);

    expect(detail.querySelector('h1.d-route'), 'заголовок карточки — h1, как в SSR').toBeTruthy();
    expect(detail.textContent).toContain('20 мая 2030');       // выезд — с годом
    expect(detail.textContent).toContain('10 сентября 2026');  // добавлено — полная дата, не «5 дн. назад»

    const related = Array.from(detail.querySelectorAll('.rows article.row')) as HTMLElement[];
    expect(related.length, 'блок «Ещё по этому маршруту»').toBe(1);
    expect(detail.textContent).toContain('Ещё по этому маршруту');
    expect(related[0]!.textContent).toContain('Минск');
    expect(related[0]!.querySelector('a.row-link')?.getAttribute('href')).toBe(`/item/${REQ}`);
    await goto('/');
  });

  it('в первый кадр крошки короткие — строка уже занимает своё место', async () => {
    await goto(`/item/${ID}`, 250); // прогрели кэш объявления
    await goto('/');
    const detail = byId('item-detail');
    detail.removeAttribute('data-ssr');
    detail.removeAttribute('data-id');

    // переходим и смотрим ДО ответа сети: карточка рисуется из кэша доски,
    // пути города и маршрута знает только сервер — они доедут следом
    win.history.pushState(null, '', `/item/${ID}`);
    win.dispatchEvent(new win.Event('popstate'));
    expect(plain(detail.querySelector('.crumbs')?.textContent ?? null))
      .toBe(`Доска › № ${ID.slice(0, 8)}`);
    expect(detail.querySelectorAll('.crumbs a').length, 'ссылок города и маршрута ещё нет').toBe(1);

    await settle(250);
    expect(plain(detail.querySelector('.crumbs')?.textContent ?? null)).toContain('Варшава → Минск');
    expect(detail.querySelectorAll('.crumbs a').length).toBe(3);
    await goto('/');
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
    await goto('/admin');
    expect(byId('admin-login').hidden).toBe(false);
    expect(byId('admin-panel').hidden).toBe(true);
  });

  it('с ключом — очередь модерации и предупреждение о повторе', async () => {
    (byId('admin-key') as HTMLInputElement).value = ADMIN_KEY;
    byId('admin-key-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    await settle(80);

    expect(byId('admin-panel').hidden).toBe(false);
    expect(text('admin-count')).toContain('Необработано заявок: 1');
    // сервер удалил просроченную заявку до показа очереди — и сказал об этом
    expect(text('admin-count')).toContain('просроченных удалено: 1');
    const warn = win.document.querySelector('#admin-list .dup-warn') as HTMLElement | null;
    expect(warn, 'у повтора должен быть бейдж').not.toBeNull();
    expect(warn!.textContent).toContain('Это повтор');
    expect(warn!.textContent).toContain('тот же маршрут и даты');
    expect((warn!.querySelector('a') as HTMLAnchorElement).getAttribute('href')).toBe(`/item/${ID}`);
  });

  it('одобрение дубля предупреждает, что такая заявка уже на доске', async () => {
    server.approvedDuplicate = listing();
    const listingsBefore = calls.filter((c) => c === 'GET /api/admin/listings?tab=pending').length;
    const approve = Array.from(win.document.querySelectorAll('#admin-list button')).find((b) => b.textContent === 'одобрить') as HTMLElement;
    expect(approve, 'кнопка «одобрить»').toBeTruthy();
    approve.click();
    await settle(80);
    expect(calls.filter((c) => c.includes('/status')).length).toBeGreaterThan(0);
    expect(text('toast')).toContain('Опубликовано.');
    expect(text('toast')).toContain(`уже есть такая заявка № ${ID.slice(0, 8)}`);
    // список не перезагружается: карточка уходит на месте, без «загружаю…»
    expect(calls.filter((c) => c === 'GET /api/admin/listings?tab=pending').length).toBe(listingsBefore);
    expect(win.document.querySelector('#admin-list .admin-card')).toBeNull();
    expect(text('admin-count')).toContain('Необработанных заявок нет');
    server.approvedDuplicate = null;
  });

  it('экспорт в CSV: файл скачивается с ключом в заголовке, строки посчитаны', async () => {
    byId('admin-tab-board').click();
    await settle(80);
    const btn = Array.from(win.document.querySelectorAll('#admin-list button'))
      .find((b) => b.textContent === 'экспорт в CSV') as HTMLElement | undefined;
    expect(btn, 'кнопка «экспорт в CSV» на вкладке «доска»').toBeTruthy();

    // ловим скачивание: jsdom не умеет createObjectURL и не ходит по ссылкам
    const downloads: string[] = [];
    const hrefs: string[] = [];
    const blobs: Blob[] = [];
    const origClick = win.HTMLAnchorElement.prototype.click;
    const origCreate = win.URL.createObjectURL;
    win.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      downloads.push(this.download);
      hrefs.push(this.href);
    } as unknown as () => void;
    (win.URL as Loose).createObjectURL = (b: Blob) => { blobs.push(b); return 'blob:csv-test'; };
    (win.URL as Loose).revokeObjectURL = () => undefined;
    const getsBefore = server.csvGets;
    btn!.click();
    await settle(120);
    win.HTMLAnchorElement.prototype.click = origClick;
    (win.URL as Loose).createObjectURL = origCreate;

    expect(server.csvGets).toBe(getsBefore + 1);
    expect(calls.filter((c) => c === 'GET /api/admin/listings.csv?status=published'),
      'по умолчанию выгружаем только доску').toHaveLength(1);
    // ключ админки уходит заголовком: в адресе ему быть нельзя
    expect(server.csvAuth).toBe('ok');
    expect(server.csvQuery).toBe('status=published');
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatch(/^poputka-doska-\d{4}-\d{2}-\d{2}\.csv$/);
    // число в тосте — из файла, а не «на глаз»: две строки данных
    expect(text('toast')).toContain('Выгружено заявок: 2');
    expect(text('toast')).toContain('только доска'); // что именно скачали — видно
    expect(text('toast')).toContain('UTF-8');

    /* Главное: BOM обязан доехать до САМОГО ФАЙЛА. Сервер его отдаёт, но
       r.text() по спецификации BOM снимает — если строить Blob из строки,
       Excel на Windows прочитает UTF-8 как cp1251 и покажет «РЅР° РґРѕСЃРєРµ»
       вместо «на доске». Регресс ровно на эту ошибку. */
    expect(blobs, 'файл собирается один раз').toHaveLength(1);
    const bytes = new Uint8Array(await blobs[0]!.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]], 'первые три байта — EF BB BF').toEqual([0xEF, 0xBB, 0xBF]);
    const body = new TextDecoder('utf-8').decode(bytes);
    expect(body.split('\r\n')[0]).toContain('"статус"');
    expect(body).toContain('на доске');
    expect(hrefs[0]).toBe('blob:csv-test');

    // вернуть админку на вкладку модерации — следующие тесты ждут её
    byId('admin-tab-pending').click();
    await settle(80);
  });

  it('экспорт: область выгрузки выбирается и уходит в ?status=', async () => {
    byId('admin-tab-board').click();
    await settle(80);
    const sel = win.document.querySelector('#admin-list select[aria-label="Что выгружать в CSV"]') as HTMLSelectElement | null;
    expect(sel, 'выбор области выгрузки').toBeTruthy();
    // по умолчанию стоит доска, а не «всё подряд»
    expect(sel!.value).toBe('published');
    expect(Array.from(sel!.options).map((o) => o.value)).toEqual(['published', 'expired', 'pending', 'rejected', 'all']);

    const downloads: string[] = [];
    const origClick = win.HTMLAnchorElement.prototype.click;
    win.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    } as unknown as () => void;
    const btn = Array.from(win.document.querySelectorAll('#admin-list button'))
      .find((b) => b.textContent === 'экспорт в CSV') as HTMLElement;

    for (const [value, query, file] of [
      ['expired', 'status=expired', 'poputka-arhiv-'],
      ['all', '', 'poputka-vse-'],
      ['rejected', 'status=rejected', 'poputka-otklonennye-'],
    ] as Array<[string, string, string]>) {
      sel!.value = value;
      btn.click();
      await settle(80);
      expect(server.csvQuery).toBe(query);
      expect(downloads[downloads.length - 1]!.startsWith(file), `имя файла для «${value}»`).toBe(true);
    }
    win.HTMLAnchorElement.prototype.click = origClick;
    // «всё подряд» идёт без параметра — сервер отдаёт все статусы
    expect(calls.filter((c) => c === 'GET /api/admin/listings.csv')).toHaveLength(1);
    byId('admin-tab-pending').click();
    await settle(80);
  });

  it('экспорт без createObjectURL: data-URL тоже несёт BOM', async () => {
    byId('admin-tab-board').click();
    await settle(80);
    const btn = Array.from(win.document.querySelectorAll('#admin-list button'))
      .find((b) => b.textContent === 'экспорт в CSV') as HTMLElement | undefined;
    expect(btn).toBeTruthy();

    const hrefs: string[] = [];
    const origClick = win.HTMLAnchorElement.prototype.click;
    const origCreate = win.URL.createObjectURL;
    win.HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      hrefs.push(this.href);
    } as unknown as () => void;
    (win.URL as Loose).createObjectURL = undefined; // старый браузер / jsdom без него
    btn!.click();
    await settle(120);
    win.HTMLAnchorElement.prototype.click = origClick;
    (win.URL as Loose).createObjectURL = origCreate;

    expect(hrefs).toHaveLength(1);
    // %EF%BB%BF — тот же BOM, только percent-encoded
    expect(hrefs[0]!.startsWith('data:text/csv;charset=utf-8,%EF%BB%BF')).toBe(true);
    expect(decodeURIComponent(hrefs[0]!.slice('data:text/csv;charset=utf-8,'.length))).toContain('на доске');
    byId('admin-tab-pending').click();
    await settle(80);
  });

  it('отклонение тоже убирает карточку без перезагрузки списка', async () => {
    server.pendingNoContact = true;
    byId('admin-refresh').click();
    await settle(80);
    expect(win.document.querySelectorAll('#admin-list .admin-card')).toHaveLength(2);
    const listingsBefore = calls.filter((c) => c === 'GET /api/admin/listings?tab=pending').length;
    const reject = Array.from(win.document.querySelectorAll('#admin-list button')).find((b) => b.textContent === 'отклонить') as HTMLElement;
    reject.click();
    await settle(80);
    expect(text('toast')).toContain('Отклонено.');
    expect(calls.filter((c) => c === 'GET /api/admin/listings?tab=pending').length).toBe(listingsBefore);
    // отклонённая карточка ушла, вторая осталась на месте
    expect(win.document.querySelector(`#admin-list .admin-card[data-id="${DUP}"]`)).toBeNull();
    expect(win.document.querySelector(`#admin-list .admin-card[data-id="${NOCONTACT}"]`)).toBeTruthy();
    expect(text('admin-count')).toContain('Необработано заявок: 1');
    server.pendingNoContact = false;
  });

  it('вкладка «настройки»: логин и пароль медиакита задаются из админки', async () => {
    byId('admin-tab-settings').click();
    await settle(80);
    // форма с текущим состоянием (секреты воркера)
    expect(win.document.querySelector('#admin-list')?.textContent).toContain('задан секретами воркера');
    const loginInput = win.document.querySelector('#media-login') as HTMLInputElement | null;
    const passInput = win.document.querySelector('#media-password') as HTMLInputElement | null;
    expect(loginInput).toBeTruthy();
    expect(passInput).toBeTruthy();
    // сохраняем новую пару — уходит POST с логином и паролем
    loginInput!.value = 'partner';
    passInput!.value = 's3cret';
    const save = Array.from(win.document.querySelectorAll('#admin-list button')).find((b) => b.textContent === 'сохранить') as HTMLElement;
    save.click();
    await settle(150);
    expect(calls.some((c) => String(c).startsWith('SAVED') && c.includes('partner'))).toBe(true);
    expect(text('toast')).toContain('Сохранено');
    // перерисовка показывает новую пару
    expect(win.document.querySelector('#admin-list')?.textContent).toContain('логин: partner');
    server.mediaCreds = null;
    // возвращаем вкладку «на модерации» — следующие тесты ждут её
    byId('admin-tab-pending').click();
    await settle(150);
  });

  it('счётчик показывает, сколько повторов вычищено из очереди до показа', async () => {
    server.dupesPruned = 18;
    byId('admin-refresh').click();
    await settle(80);
    expect(text('admin-count')).toContain('повторов отклонено: 18');
    server.dupesPruned = 0;
  });

  it('вкладка SEO: позиции с динамикой и присутствие в корпусах ИИ', async () => {
    byId('admin-tab-seo').click();
    await settle(80);
    // позиции: таблица с запросами, позиция и её движение (9 -> 7 = ▲2)
    expect(text('admin-count')).toContain('SEO-видимость');
    const rows = Array.from(win.document.querySelectorAll('#admin-list .stats-table tbody tr'));
    expect(rows.length).toBe(2);
    expect(rows[0]?.textContent).toContain('передать посылку варшава минск');
    expect(rows[0]?.textContent).toContain('№ 7');
    expect(rows[0]?.textContent).toContain('▲2');
    // нет в топе — прочерк и конкуренты
    expect(rows[1]?.textContent).toContain('попутка передача посылок');
    expect(rows[1]?.textContent).toContain('—');
    // корпуса: Common Crawl и Wayback
    expect(win.document.querySelector('#admin-list')?.textContent).toContain('CC-MAIN-2026-30: 12 стр.');
    expect(win.document.querySelector('#admin-list')?.textContent).toContain('Wayback: 3 стр.');
    // возвращаем вкладку «на модерации» — следующие тесты ждут её
    byId('admin-tab-pending').click();
    await settle(80);
  });

  it('вкладка «канал»: процент заявок, дошедших до Telegram, и топ «прочего»', async () => {
    byId('admin-tab-forum').click();
    await settle(80);
    expect(text('admin-count')).toContain('Попадание заявок в Telegram-канал');
    const body = win.document.querySelector('#admin-list')?.textContent ?? '';
    // сводные проценты: 12 из 20 опубликованных, 8 в комнаты, 4 в «прочее»
    expect(body).toContain('ушло в канал 12');
    expect(body).toContain('В тематические комнаты 8');
    expect(body).toContain('в «прочее» 4');
    // комнаты названы человечески, сортировка по публикациям
    expect(body).toContain('Беларусь ↔ Польша');
    expect(body).toContain('прочее');
    // «что не попало» — кандидаты на новые комнаты
    expect(body).toContain('Что не попало в свои комнаты');
    expect(body).toContain('Минск → Москва');
    // возвращаем вкладку «на модерации» — следующие тесты ждут её
    byId('admin-tab-pending').click();
    await settle(80);
  });

  it('вкладка «канал»: сброс счётчиков — после перенастройки комнат статистика не актуальна', async () => {
    byId('admin-tab-forum').click();
    await settle(80);
    const resetBtn = Array.from(win.document.querySelectorAll('#admin-list button'))
      .find((b) => b.textContent === 'сбросить счётчики') as HTMLButtonElement | undefined;
    expect(resetBtn).toBeTruthy(); // кнопка есть, когда канал настроен
    // передумали в подтверждении — на сервер ничего не уходит
    win.confirm = () => false;
    const posts0 = server.forumResetPosts;
    resetBtn!.click();
    await settle(80);
    expect(server.forumResetPosts).toBe(posts0);
    // подтвердили — счётчики сброшены, вкладка перерисовалась с сервера
    win.confirm = () => true;
    const gets0 = server.forumStatsGets;
    resetBtn!.click();
    await settle(120);
    expect(server.forumResetPosts).toBe(posts0 + 1);
    expect(server.forumStatsGets).toBe(gets0 + 1);
    expect(text('toast')).toContain('Счётчики канала сброшены');
    // возвращаем вкладку «на модерации» — следующие тесты ждут её
    byId('admin-tab-pending').click();
    await settle(80);
  });

  it('вкладка «доска»: предупреждение о подозрительно далёкой дате выезда', async () => {
    // «выезд 29 сентября 2027», добавлено 30 сентября 2026: в объявлении
    // дата была без года и уже прошла — парсер подставил следующий год.
    // Такие аномалии должны быть видны админу сразу на карточке
    byId('admin-tab-board').click();
    await settle(80);
    let body = win.document.querySelector('#admin-list')?.textContent ?? '';
    expect(body).toContain('подозрительно далеко'); // фикстура: выезд 2030 годом
    expect(body).toContain('парсер подставил следующий');
    expect(body).toContain('редактироват');
    // обычная дата через неделю — предупреждения нет
    server.boardOver = { departureDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10) };
    byId('admin-refresh').click();
    await settle(80);
    body = win.document.querySelector('#admin-list')?.textContent ?? '';
    expect(body).not.toContain('подозрительно далеко');
    server.boardOver = null;
    // возвращаем вкладку «на модерации» — следующие тесты ждут её
    byId('admin-tab-pending').click();
    await settle(80);
  });

  it('вкладка «доска»: массовое удаление объявлений с аномальной датой', async () => {
    // фикстура — выезд 2030 годом: баннер предлагает убрать все такие
    // объявления разом; сервер архивирует все найденные, а не только видимые
    byId('admin-tab-board').click();
    await settle(80);
    const btn = () => Array.from(win.document.querySelectorAll('#admin-list button'))
      .find((b) => b.textContent === 'убрать все такие с доски') as HTMLButtonElement | undefined;
    expect(btn()).toBeTruthy();
    expect(win.document.querySelector('#admin-list')?.textContent ?? '')
      .toContain('Подозрительно далёкая дата выезда: 1 объявление');
    // передумали в подтверждении — на сервер ничего не уходит
    win.confirm = () => false;
    const posts0 = server.archiveFarPosts;
    btn()!.click();
    await settle(80);
    expect(server.archiveFarPosts).toBe(posts0);
    // подтвердили — массовая архивация, доска перерисовалась чистой
    win.confirm = () => true;
    btn()!.click();
    await settle(120);
    expect(server.archiveFarPosts).toBe(posts0 + 1);
    expect(text('toast')).toContain('Убрано в архив: 1');
    expect(win.document.querySelector('#admin-list')?.textContent ?? '')
      .not.toContain('подозрительно далеко');
    server.boardOver = null;
    // возвращаем вкладку «на модерации» — следующие тесты ждут её
    byId('admin-tab-pending').click();
    await settle(80);
  });

  it('вкладка «доска»: кнопка «показать все такие» — фильтр аномальных дат', async () => {
    // под счётчиком «На доске: N — действующие и архив» кнопка показывает
    // только объявления с датой выезда дальше 90 дней; возврат — одной кнопкой
    byId('admin-tab-board').click();
    await settle(80);
    const showBtn = Array.from(win.document.querySelectorAll('#admin-list button'))
      .find((b) => b.textContent === 'показать все такие') as HTMLButtonElement | undefined;
    expect(showBtn).toBeTruthy();
    // нажали — доска перезагрузилась с серверным фильтром odd=1
    const odd0 = server.boardOddGets;
    showBtn!.click();
    await settle(80);
    expect(server.boardOddGets).toBe(odd0 + 1);
    expect(text('admin-count')).toContain('аномальной датой'); // счётчик про фильтр
    let body = win.document.querySelector('#admin-list')?.textContent ?? '';
    expect(body).toContain('Показаны только объявления');
    expect(body).toContain('подозрительно далеко'); // карточка с предупреждением
    // вернулись к полной доске
    const backBtn = Array.from(win.document.querySelectorAll('#admin-list button'))
      .find((b) => b.textContent === 'показать всю доску') as HTMLButtonElement | undefined;
    backBtn!.click();
    await settle(80);
    expect(text('admin-count')).toContain('На доске:');
    body = win.document.querySelector('#admin-list')?.textContent ?? '';
    expect(body).not.toContain('Показаны только объявления');
    // возвращаем вкладку «на модерации» — следующие тесты ждут её
    byId('admin-tab-pending').click();
    await settle(80);
  });

  it('вкладка «доска»: все аномальные уже в архиве — «убрать» не предлагается', async () => {
    // сценарий из прода: строка говорила «25 объявлений», кнопка отвечала
    // «Убрано в архив: 0» — счётчик смешивал действующие и архивные.
    // Теперь: «25 уже в архиве», убирать нечего — кнопки «убрать» нет
    server.farArchivedStub = 25;
    server.boardOver = { departureDate: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10) };
    byId('admin-tab-board').click();
    await settle(80);
    const body = win.document.querySelector('#admin-list')?.textContent ?? '';
    expect(body).toContain('25 уже в архиве');
    expect(body).not.toContain('объявление на доске');
    const btns = Array.from(win.document.querySelectorAll('#admin-list button')).map((b) => b.textContent);
    expect(btns).not.toContain('убрать все такие с доски'); // убирать нечего
    expect(btns).toContain('показать все такие'); // посмотреть архив — можно
    server.farArchivedStub = 0;
    server.boardOver = null;
    // возвращаем вкладку «на модерации» — следующие тесты ждут её
    byId('admin-tab-pending').click();
    await settle(80);
  });

  it('счётчик очереди — настоящее число с сервера, а не длина списка', async () => {
    // заявок больше, чем доехало карточек: раньше счётчик застревал на
    // лимите выборки (50), теперь показывает COUNT с сервера
    server.pendingTotal = 137;
    byId('admin-refresh').click();
    await settle(80);
    expect(text('admin-count')).toContain('Необработано заявок: 137');
    expect(text('admin-count')).toContain('показаны последние 1');
    server.pendingTotal = 0;
  });

  it('штамп происхождения: админ — синим, человек с сайта — серым', async () => {
    server.pendingNoContact = true;
    byId('admin-refresh').click();
    await settle(80);
    // пересылка от админа (telegram) — штамп «от админа»
    const adminStamp = win.document.querySelector(`#admin-list .admin-card[data-id="${DUP}"] .stamp-admin`);
    expect(adminStamp, 'штамп «от админа»').not.toBeNull();
    expect(adminStamp!.textContent).toContain('от админа');
    // заявка человека с сайта — штамп «с сайта», не админский
    const personCard = win.document.querySelector(`#admin-list .admin-card[data-id="${NOCONTACT}"]`) as HTMLElement;
    expect(personCard.querySelector('.stamp-origin')!.textContent).toContain('с сайта');
    expect(personCard.querySelector('.stamp-admin')).toBeNull();
    // ...и «от другого человека»: не админский Telegram и не форма с ключом
    expect(personCard.querySelector('.stamp-person')!.textContent).toContain('от другого человека');
    // у админской карточки такого штампа нет
    expect(win.document.querySelector(`#admin-list .admin-card[data-id="${DUP}"] .stamp-person`)).toBeNull();
    server.pendingNoContact = false;
  });

  it('карточка админа: ссылка на исходное сообщение в чате', async () => {
    byId('admin-refresh').click();
    await settle(80);
    const src = win.document.querySelector(`#admin-list .admin-card[data-id="${DUP}"] .src`);
    expect(src, 'блок источника в карточке').not.toBeNull();
    expect(src!.textContent).toContain('из чата «Граница BY-LT-PL»');
    const a = src!.querySelector('a') as HTMLAnchorElement | null;
    expect(a, 'ссылка на исходное сообщение').not.toBeNull();
    expect(a!.getAttribute('href')).toBe('https://t.me/granica_BY_LT_PL/153043/153048');
    expect(a!.textContent).toContain('сообщение 153048');
  });

  it('подбор: скрыть неактуальный юзернейм — его пары исчезают, заявки остаются', async () => {
    byId('admin-tab-match').click();
    await settle(100);
    // прогон без фильтров
    win.document.querySelector('.match-form')!.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    await settle(120);
    expect(win.document.querySelectorAll('.match-pair')).toHaveLength(2);

    // у пары с @stale_guy жмём «скрыть»
    calls.length = 0;
    const staleLine = Array.from(win.document.querySelectorAll('.match-contact'))
      .find((p) => p.textContent!.includes('@stale_guy')) as HTMLElement;
    (staleLine.querySelector('.match-hide-btn') as HTMLElement).click();
    await settle(100);
    expect(calls).toContain('POST /api/admin/match/hide');
    expect(win.document.querySelectorAll('.match-pair')).toHaveLength(1);
    expect(text('toast')).toContain('Скрыл');

    // скрытый контакт виден списком с кнопкой «вернуть»
    const box = win.document.querySelector('.match-hidden') as HTMLElement;
    expect(box.textContent).toContain('@stale_guy');
    (box.querySelector('button') as HTMLElement).click();
    await settle(100);
    expect(win.document.querySelector('.match-hidden')).toBeNull();

    // новый прогон после возврата — снова две пары
    win.document.querySelector('.match-form')!.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    await settle(120);
    expect(win.document.querySelectorAll('.match-pair')).toHaveLength(2);

    // возвращаем вкладку «заявки» — следующие тести работают с очередью
    byId('admin-tab-pending').click();
    await settle(100);
  });

  it('подбор: ссылка на исходное сообщение; заявку без контакта можно скрыть', async () => {
    byId('admin-tab-match').click();
    await settle(100);
    win.document.querySelector('.match-form')!.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    await settle(120);
    expect(win.document.querySelectorAll('.match-pair')).toHaveLength(2);

    // происхождение водителя m1: ссылка на сообщение в публичном чате с темой
    const link = win.document.querySelector('.match-msg-link') as HTMLAnchorElement | null;
    expect(link, 'ссылка на исходное сообщение в паре').not.toBeNull();
    expect(link!.getAttribute('href')).toBe('https://t.me/granica_BY_LT_PL/153043/153048');
    expect(link!.textContent).toContain('сообщение 153048');

    // сторона без контакта (m2): «скрыть заявку» — по id, не по юзернейму
    calls.length = 0;
    const noContact = win.document.querySelector('.match-nocontact') as HTMLElement;
    expect(noContact.textContent).toContain('контакта нет');
    (noContact.querySelector('.match-hide-btn') as HTMLElement).click();
    await settle(100);
    expect(calls).toContain('POST /api/admin/match/hide');
    expect(win.document.querySelectorAll('.match-pair')).toHaveLength(1);
    expect(text('toast')).toContain('Скрыл заявку');

    // скрытая заявка видна списком с подписью и кнопкой «вернуть»
    const box = win.document.querySelector('.match-hidden') as HTMLElement;
    expect(box.textContent).toContain('m2');
    (box.querySelector('button') as HTMLElement).click();
    await settle(100);
    expect(win.document.querySelector('.match-hidden')).toBeNull();

    // новый прогон после возврата — снова две пары
    win.document.querySelector('.match-form')!.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    await settle(120);
    expect(win.document.querySelectorAll('.match-pair')).toHaveLength(2);

    // возвращаем вкладку «заявки» — следующие тесты работают с очередью
    byId('admin-tab-pending').click();
    await settle(100);
  });

  it('подбор: просьба — узел, от него линии к найденным водителям', async () => {
    byId('admin-tab-match').click();
    await settle(100);
    // у первой просьбы два водителя: m1 (оценка 80) и m5 (оценка 60).
    // кладём слабым первым — иначе сортировку по оценке тест не заметит
    const strongPair = server.matchPairs[0]!; // просьба m2 с водителем m1 (80)
    server.matchPairs.unshift({
      score: 60, reasons: ['маршрут'],
      offer: {
        id: 'm5', fromCity: 'Варшава', toCity: 'Минск', departureDate: '2030-05-23',
        contacts: ['@second_driver'], description: 'везу, есть место', status: 'published',
      },
      request: { ...strongPair.request }, // та же просьба — вторая ветка к ней
    });
    win.document.querySelector('.match-form')!.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    await settle(120);

    const groups = Array.from(win.document.querySelectorAll('.match-group')) as HTMLElement[];
    expect(groups, 'групп столько, сколько просьб').toHaveLength(2);
    expect(win.document.querySelectorAll('.match-pair'), 'пара единицей подбора остаться').toHaveLength(3);

    // сверху просьба с лучшей оценкой: 80 > 70
    const first = groups[0]!;
    expect(first.querySelector('.match-hub')!.textContent).toContain('Варшава → Минск');
    expect(first.querySelector('.match-hub-count')!.textContent).toBe('водителей найдено: 2');
    expect(first.querySelector('.match-hub-best')!.textContent).toContain('лучшая оценка 80');
    // ветки — тоже по оценке: лучший водитель первым
    const leaves = Array.from(first.querySelectorAll('.match-leaf')) as HTMLElement[];
    expect(leaves).toHaveLength(2);
    expect(leaves[0]!.querySelector('.match-score')!.textContent).toContain('водитель 1 · оценка 80');
    expect(leaves[1]!.querySelector('.match-score')!.textContent).toContain('водитель 2 · оценка 60');
    // место в сетке задано явно: узел занимает столько строк, сколько веток,
    // иначе линии в CSS не знали бы, где ствол начинается и заканчивается
    expect((first.querySelector('.match-hub-cell') as HTMLElement).style.gridRow).toBe('1 / span 2');
    expect(leaves[0]!.style.gridRow).toBe('1');
    expect(leaves[1]!.style.gridRow).toBe('2');
    expect(leaves[0]!.className).toContain('is-first');
    expect(leaves[1]!.className).toContain('is-last');

    // вторая просьба: водитель один — ствол не рисуется
    const second = groups[1]!;
    expect(second.querySelector('.match-hub-count')!.textContent).toBe('водителей найдено: 1');
    expect(second.querySelector('.match-hub-best')).toBeNull();
    expect(second.querySelector('.match-leaf')!.className).toContain('is-only');
    expect((second.querySelector('.match-hub-cell') as HTMLElement).style.gridRow).toBe('1 / span 1');

    // просьба показана один раз (в узле): её контакт и «скрыть» — там же
    expect(first.querySelectorAll('.match-nocontact')).toHaveLength(1);
    expect(second.querySelector('.match-hub .match-contact')!.textContent).toContain('@other2');

    server.matchPairs.shift();
    byId('admin-tab-pending').click();
    await settle(100);
  });

  it('подбор: «скопировать текст» на просьбе копирует шаблон с её городами', async () => {
    byId('admin-tab-match').click();
    await settle(100);
    win.document.querySelector('.match-form')!.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    await settle(120);

    // буфера обмена в jsdom нет — фиксируем незащищённый контекст, чтобы
    // copyText пошёл запасным путём (textarea + execCommand), и ловим текст
    Object.defineProperty(win, 'isSecureContext', { value: false, configurable: true });
    const copied: string[] = [];
    win.document.execCommand = () => {
      // запасной путь создаёт свою textarea в конце body — на странице есть
      // и другие (форма заявки), поэтому берём последнюю
      const tas = win.document.querySelectorAll('textarea');
      copied.push((tas[tas.length - 1] as HTMLTextAreaElement | undefined)?.value ?? '');
      return true;
    };

    const groups = Array.from(win.document.querySelectorAll('.match-group')) as HTMLElement[];
    const btn = Array.from(groups[0]!.querySelectorAll('.match-hub button'))
      .find((b) => b.textContent === 'скопировать текст') as HTMLElement;
    expect(btn, 'кнопка на просьбе').toBeTruthy();
    // что именно скопируется, видно до нажатия
    expect(btn.getAttribute('title'))
      .toBe('здравствуйте увидел вашу просьбу о передаче посылки Варшава - Минск. Актуально?');
    btn.click();
    await settle(40);
    expect(copied).toEqual(['здравствуйте увидел вашу просьбу о передаче посылки Варшава - Минск. Актуально?']);
    expect(text('toast')).toContain('Шаблон скопирован');

    // у каждой просьбы своя кнопка и свои города маршрута
    const btn2 = Array.from(groups[1]!.querySelectorAll('.match-hub button'))
      .find((b) => b.textContent === 'скопировать текст') as HTMLElement;
    btn2.click();
    await settle(40);
    expect(copied[1]).toBe('здравствуйте увидел вашу просьбу о передаче посылки Краков - Львов. Актуально?');

    byId('admin-tab-pending').click();
    await settle(100);
  });

  it('линии дерева — в CSS: ствол посередине промежутка, на телефоне вертикально', () => {
    // jsdom не считает раскладку, поэтому геометрию линий проверяем в правилах
    expect(cssSource).toMatch(/\.match-tree \{[^}]*--match-arm: 29px/s);
    expect(cssSource).toMatch(/\.match-hub-cell::after \{[^}]*width: var\(--match-arm\)/s);
    expect(cssSource).toMatch(/\.match-leaf::before \{[^}]*width: var\(--match-arm\)/s);
    expect(cssSource).toMatch(/right: calc\(100% \+ var\(--match-arm\) - 1px\)/);
    expect(cssSource).toMatch(/\.match-leaf\.is-first::after \{ top: 50%; \}/);
    expect(cssSource).toMatch(/\.match-leaf\.is-last::after \{ bottom: 50%; \}/);
    expect(cssSource).toMatch(/\.match-leaf\.is-only::after \{ display: none; \}/);
    // ствол сплошной, а не пунктиром: у ветки убран margin-bottom от .admin-card,
    // а линия выходит вниз на row-gap
    expect(cssSource).toMatch(/\.match-leaf \{ grid-column: 2; position: relative; margin-bottom: 0; \}/);
    expect(cssSource).toMatch(/bottom: calc\(-1 \* var\(--match-row\)\)/);
    // узкий экран: одна колонка, строки сетки из app.js перебиты
    expect(cssSource).toMatch(/\.match-leaf \{ grid-column: 1 !important; grid-row: auto !important;/);
    expect(cssSource).toMatch(/\.match-leaf\.is-last::after \{ top: 0; bottom: auto; height: 22px; \}/);
    // третья колонка таблицы автоодобрения («авто») на телефоне не прячется
    expect(cssSource).toMatch(/\.stats-autopub \.stats-table tbody td:nth-child\(3\) \{ display: table-cell; \}/);
  });

  it('«ищу попутчика» без контакта: принимается сразу, автор видит свою заявку', async () => {
    await goto('/new');
    const form = byId('form') as HTMLFormElement;
    (form.querySelector('input[name="ltype"][value="request"]') as HTMLInputElement).checked = true;
    (form.querySelector('[name="fromCity"]') as HTMLInputElement).value = 'Варшава';
    (form.querySelector('[name="toCity"]') as HTMLInputElement).value = 'Минск';
    (form.querySelector('[name="description"]') as HTMLTextAreaElement).value = 'Передать коробку с лекарствами, 2 кг';
    // контакт не заполнен — для «нужно передать» это разрешено
    calls.length = 0;
    form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    await settle(120);
    // ушла на сервер без ошибки валидации
    expect(calls).toContain('POST /api/listings');
    expect(text('toast')).toContain('Заявка принята');
    // автора ведём на его заявку — видно, что принято
    expect(win.location.pathname).toBe(`/item/${HIDDEN}`);
  });

  it('водителю без контакта форма честно отказывает', async () => {
    await goto('/new');
    calls.length = 0;
    const form = byId('form') as HTMLFormElement;
    (form.querySelector('[name="fromCity"]') as HTMLInputElement).value = 'Варшава';
    (form.querySelector('[name="toCity"]') as HTMLInputElement).value = 'Минск';
    (form.querySelector('[name="description"]') as HTMLTextAreaElement).value = 'Везу посылки в пятницу';
    form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
    await settle(80);
    expect(byId('form-error').hidden).toBe(false);
    expect(text('form-error')).toContain('В заявке водителя нужен контакт');
    // на сервер ничего не ушло
    expect(calls.filter((c) => c === 'POST /api/listings').length).toBe(0);
  });

  it('вкладка «итоги»: поток заявок по дням/неделям/месяцам и самые просматриваемые', async () => {
    byId('admin-tab-stats').click();
    await settle(120);
    // поток по дням — таблица на месте
    const flow = win.document.querySelector('.stats-flow') as HTMLElement;
    expect(flow, 'блок потока').not.toBeNull();
    expect(flow.textContent).toContain('пришло 7 (везут 4 · передать 3), одобрено 5, отклонено 1');
    expect(flow.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(flow.textContent).toContain('21 сен');
    // график: столбики по дням, легенда «везут / нужно передать»
    const chart = flow.querySelector('svg.flow-chart') as SVGElement | null;
    expect(chart, 'SVG-график').not.toBeNull();
    expect(chart!.querySelectorAll('rect').length).toBeGreaterThanOrEqual(4); // 3+2 столбика
    expect(flow.querySelector('.flow-legend')!.textContent).toContain('нужно передать');

    // переключение на месяцы
    (Array.from(flow.querySelectorAll('button')).find((b) => b.textContent === 'по месяцам') as HTMLElement).click();
    await settle(100);
    const flow2 = win.document.querySelector('.stats-flow') as HTMLElement;
    expect(flow2.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(flow2.textContent).toContain('сентябрь 2026');

    // самые просматриваемые — ссылка на карточку
    const viewed = win.document.querySelector('.stats-viewed') as HTMLElement;
    expect(viewed, 'блок просмотров').not.toBeNull();
    const link = viewed.querySelector('tbody a') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`/item/${ID}`);
    expect(viewed.textContent).toContain('42');

    // отчёт по юзернеймам — кто чаще всего мелькает в заявках
    const unames = win.document.querySelector('.stats-usernames') as HTMLElement;
    expect(unames, 'блок юзернеймов').not.toBeNull();
    const ulink = unames.querySelector('tbody a') as HTMLAnchorElement;
    expect(ulink.getAttribute('href'), 'ссылка на Telegram').toBe('https://t.me/ivan');
    expect(unames.textContent).toContain('@ivan');
    expect(unames.textContent).toContain('5 / 2'); // везёт / ищет
    expect(unames.textContent).toContain('70%');   // доля 7 из 10

    // что передают — категории по словам в описаниях
    const carry = win.document.querySelector('.stats-carry') as HTMLElement;
    expect(carry, 'блок «что передают»').not.toBeNull();
    expect(carry.textContent).toContain('Документы');
    expect(carry.textContent).toContain('Прочее');
    expect(carry.textContent).toContain('30 / 10'); // везёт / ищет

    // текст поста тоже на вкладке — ничего не потеряли
    expect(win.document.querySelector('.stats-post')).not.toBeNull();

    // возвращаем вкладку «заявки»
    byId('admin-tab-pending').click();
    await settle(100);
  });

  it('вкладка «итоги»: автоодобрение — сколько ушло на доску без модератора и почему', async () => {
    byId('admin-tab-stats').click();
    await settle(120);
    const box = win.document.querySelector('.stats-autopub') as HTMLElement;
    expect(box, 'блок автоодобрения').not.toBeNull();
    // период подписан честно: окно и его начало, иначе счётчики врут
    expect(box.textContent).toContain('за 30 дней (с 24 авг): 9');
    expect(box.textContent).toContain('Опубликовано автоматически 7 (78%)');
    expect(box.textContent).toContain('задержано на модерацию 2 (22%)');
    expect(box.textContent).toContain('Отклонено без контакта 1, не создано как точный дубль 1');
    expect(box.textContent).toContain('не только админских');
    // причины — человеческими словами, коды наружу не показывают
    expect(box.textContent).toContain('разобрал ИИ');
    expect(box.textContent).not.toContain('ai_parsed');
    expect(box.textContent).toContain('сумма строк может быть больше');
    // две таблицы: причины и дни (новые сверху)
    const tables = box.querySelectorAll('table.stats-table');
    expect(tables).toHaveLength(2);
    expect(Array.from(tables[1]!.querySelectorAll('tbody th')).map((th) => th.textContent))
      .toEqual(['22 сен', '21 сен']);
    // окно переключается — вкладка спрашивает сервер заново с другим days
    server.autoStatsGets = 0;
    (Array.from(box.querySelectorAll('button')).find((b) => b.textContent === '7 дней') as HTMLElement).click();
    await settle(120);
    expect(server.autoStatsGets).toBe(1);
    expect(server.autoStatsQuery).toBe('7');
    expect((win.document.querySelector('.stats-autopub') as HTMLElement).textContent).toContain('за 7 дней');

    // счётчики пусты — говорим прямо, что считать пока нечего
    server.autoStatsOver = {
      days: 30, since: '2026-08-24', byDay: [], reasons: [],
      totals: { adminArrived: 0, autoPublished: 0, held: 0, dupSkipped: 0, rejectedNoContact: 0 },
    };
    (Array.from(win.document.querySelectorAll('.stats-autopub button')).find((b) => b.textContent === '30 дней') as HTMLElement).click();
    await settle(120);
    const empty = win.document.querySelector('.stats-autopub') as HTMLElement;
    expect(empty.querySelectorAll('table')).toHaveLength(0);
    expect(empty.textContent).toContain('За этот период счётчики пусты');
    expect(empty.textContent).toContain('Опубликовано автоматически 0 (—)'); // делить на ноль нечего

    // сводка не приехала — остальные итоги на месте (свой запрос, свой провал)
    server.autoStatsOver = { status: 500, body: { error: 'boom' } };
    (Array.from(empty.querySelectorAll('button')).find((b) => b.textContent === '30 дней') as HTMLElement).click();
    await settle(120);
    expect(win.document.querySelector('.stats-autopub'), 'блока нет, когда данных нет').toBeNull();
    expect(win.document.querySelector('.stats-flow'), 'поток заявок остался').not.toBeNull();
    server.autoStatsOver = null;

    // возвращаем вкладку «заявки»
    byId('admin-tab-pending').click();
    await settle(100);
  });

  it('у заявки с дублем есть «заменить старую»: старая удаляется, новая публикуется', async () => {
    const listingsBefore = calls.filter((c) => c === 'GET /api/admin/listings?tab=pending').length;
    const replace = Array.from(win.document.querySelectorAll('#admin-list button')).find((b) => b.textContent === 'заменить старую') as HTMLElement;
    expect(replace, 'кнопка «заменить старую»').toBeTruthy();
    replace.click();
    await settle(80);
    expect(server.replacedWith).toEqual({ id: DUP, deleteId: ID });
    expect(text('toast')).toContain('Старая удалена, новая на доске.');
    // без перезагрузки очереди
    expect(calls.filter((c) => c === 'GET /api/admin/listings?tab=pending').length).toBe(listingsBefore);
    expect(win.document.querySelector(`#admin-list .admin-card[data-id="${DUP}"]`)).toBeNull();
  });

  it('заявка без контакта подсвечена — видно сразу', async () => {
    server.pendingNoContact = true;
    byId('admin-refresh').click();
    await settle(80);
    const cards = Array.from(win.document.querySelectorAll('#admin-list .admin-card')) as HTMLElement[];
    expect(cards).toHaveLength(2);
    // у карточек есть data-id — по ним убираем/перерисовываем без перезагрузки
    expect(win.document.querySelector(`#admin-list .admin-card[data-id="${NOCONTACT}"]`)).toBeTruthy();
    const none = win.document.querySelector('#admin-list .admin-contact-none') as HTMLElement | null;
    expect(none, 'пометка «контакт не указан»').not.toBeNull();
    expect(none!.textContent).toContain('контакт не указан');
    // у заявки с контактом подсветки нет
    const dupCard = win.document.querySelector(`#admin-list .admin-card[data-id="${DUP}"]`) as HTMLElement;
    expect(dupCard.querySelector('.admin-contact-none')).toBeNull();
    server.pendingNoContact = false;
    byId('admin-refresh').click();
    await settle(80);
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

describe('плашка про cookies', () => {
  // инлайн-скрипт плашки не выполняется в jsdom сам (runScripts: 'outside-only'),
  // поэтому достаём его из htmlSource и выполняем как app.js
  const scriptStart = htmlSource.lastIndexOf('<script>', htmlSource.indexOf('poputka_cookie_ok'));
  const cookieScript = htmlSource.slice(scriptStart + '<script>'.length, htmlSource.indexOf('</script>', scriptStart));

  it('CSS не даёт display:flex перебить атрибут hidden', () => {
    // кнопка «понятно» не скрывала плашку: .cookie-note { display: flex }
    // сильнее браузерного [hidden] { display: none } — нужно явное правило
    expect(cssSource).toMatch(/\.cookie-note\[hidden\]\s*\{\s*display:\s*none/);
  });

  it('«понятно» скрывает плашку и запоминает выбор', () => {
    win.localStorage.removeItem('poputka_cookie_ok');
    win.eval(cookieScript);
    const note = byId('cookie-note');
    expect(note.hidden, 'плашка показалась').toBe(false);
    byId('cookie-ok').click();
    expect(win.localStorage.getItem('poputka_cookie_ok')).toBe('1');
    expect(note.hidden, 'плашка скрылась').toBe(true);
    // повторный заход с уже сохранённым выбором: плашка не появляется
    win.eval(cookieScript);
    expect(note.hidden).toBe(true);
  });
});

describe('версия сборки', () => {
  it('в шапке админки видна версия из /api/config — видно, доехал ли деплой', () => {
    expect(byId('admin-sub').textContent).toContain('Модерация заявок');
    expect(byId('admin-sub').textContent).toContain('v9.9.9');
  });
});

/* Доступность табов доски. Повод — Lighthouse: «Дерево доступности имеет
   неверный формат» / «Certain ARIA roles must contain particular children»:
   role="tablist" без role="tab"-детей. Табы — фильтры одного списка, поэтому
   честный паттерн — группа кнопок-переключателей с aria-pressed. */
describe('a11y табов доски: группа переключателей с aria-pressed', () => {
  const tabBtns = () => Array.from(win.document.querySelectorAll('.tab')) as HTMLElement[];

  it('контейнер — group с подписью, «полу-» tablist больше нет', () => {
    const box = win.document.querySelector('.tabs') as HTMLElement;
    expect(box.getAttribute('role')).toBe('group');
    expect(box.getAttribute('aria-label')).toBeTruthy();
    // В дереве доступности не должно остаться «полу-» tablist — ни здесь, ни где-либо ещё.
    expect(win.document.querySelectorAll('[role="tablist"], [role="tab"], [role="tabpanel"]')).toHaveLength(0);
  });

  it('aria-pressed есть у всех четырёх, нажат ровно один', () => {
    const btns = tabBtns();
    expect(btns).toHaveLength(4);
    for (const b of btns) expect(b.getAttribute('aria-pressed'), b.textContent ?? '').toMatch(/^(true|false)$/);
    expect(btns.filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
  });

  it('клик по табу переключает aria-pressed вместе с классом on', async () => {
    const offer = tabBtns().find((b) => b.dataset.type === 'offer')!;
    offer.click();
    await settle();
    expect(offer.getAttribute('aria-pressed')).toBe('true');
    expect(offer.classList.contains('on')).toBe(true);
    const all = tabBtns().find((b) => b.dataset.type === '')!;
    expect(all.getAttribute('aria-pressed')).toBe('false');
    expect(tabBtns().filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
    all.click(); // вернуть доску в исходное для остальных тестов
    await settle();
  });

  it('заход по URL с фильтром отмечает нажатый таб (aria-pressed)', async () => {
    await goto('/?type=request');
    const req = tabBtns().find((b) => b.dataset.type === 'request')!;
    expect(req.getAttribute('aria-pressed')).toBe('true');
    await goto('/?archive=1');
    expect(tabBtns().find((b) => b.dataset.type === 'archive')!.getAttribute('aria-pressed')).toBe('true');
    expect(req.getAttribute('aria-pressed')).toBe('false');
    await goto('/');
    expect(tabBtns().find((b) => b.dataset.type === '')!.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('здоровье страницы', () => {
  it('за всё время теста не было необработанных ошибок скрипта', () => {
    expect(pageErrors).toEqual([]);
  });
});
