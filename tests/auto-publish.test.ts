/**
 * Автопубликация заявок от админских аккаунтов (v0.4.69).
 *
 * Повод: через радар и пересылки приходит около трёхсот заявок в день, каждая
 * ждёт ручного «Одобрить». Заявку от админского аккаунта (ADMIN_IDS) админ уже
 * посмотрел — он её переслал, или relay-аккаунт принёс копию по его настройке, —
 * поэтому публикуем сразу. Но не всё: правило владельца «если сомневается —
 * не публиковать, я сам посмотрю», и сомнение обязано быть названным.
 *
 * Здесь же два его решения о том, что не публикуется никогда:
 *  - точный дубль (красное «♻️ Это повтор» в очереди) — новую заявку не
 *    создаём ни от кого, живую освежаем наверху доски;
 *  - заявка совсем без контакта из бота — отклоняем. С сайта «ищу передачу»
 *    без контакта по-прежнему публикуется скрытой: там человеку обещан подбор,
 *    и отклонить молча значило бы соврать.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env, Listing, ListingInput } from '../src/types';
import {
  autoPublishEnabled, autoPublishVerdict, doubtNote, doubtsFor, isValidDate, looksLikeCityName,
  type AutoPublishSubject,
} from '../src/auto-publish';
import { createListing, createListingSafe } from '../src/store';
import { broadcastListingToForum, handleTelegramUpdate, listingStatusNote } from '../src/telegram';

/* src/index тянет src/og, а тот — resvg.wasm: vite в тестах wasm не грузит. */
vi.mock('../src/og', () => ({
  renderOgImage: async () => new Uint8Array(),
  renderRouteOg: async () => new Uint8Array(),
}));
import worker from '../src/index';

/* ------------------------- общие заготовки ------------------------- */

/** Момент времени для проверок: без него «5 января» в тесте через полгода
 *  превратится в просроченную дату и тест соврёт. */
const NOW = new Date('2026-09-19T12:00:00Z');

const clean = (over: Partial<AutoPublishSubject> = {}): AutoPublishSubject => ({
  type: 'offer',
  fromCity: 'Брест',
  toCity: 'Варшава',
  departureDate: '2026-09-25',
  recurring: null,
  description: 'возьму посылку до 5 кг',
  telegram: '@driver77',
  phone: null,
  source: 'telegram',
  status: 'pending',
  byAdmin: true,
  ...over,
});

const env = { ADMIN_IDS: '42', SITE_URL: 'https://pop-utka.app' } as unknown as Env;
const codes = (s: AutoPublishSubject, now: Date = NOW) => doubtsFor(s, now).map((d) => d.code);

/* --------------------- правила сомнения (чисто) --------------------- */

describe('looksLikeCityName: мусор не становится городом', () => {
  it('настоящие названия проходят — включая дефисы и составные', () => {
    for (const c of ['Брест', 'Варшава', 'Minsk', 'Санкт-Петербург', 'Ростов-на-Дону', 'Франкфурт на Майне']) {
      expect(looksLikeCityName(c), c).toBe(true);
    }
  });

  it('незнание города сомнением не считается: в словаре 69 городов, на доске бывало 248', () => {
    expect(looksLikeCityName('Светлогорск')).toBe(true);
    expect(looksLikeCityName('Пхукет')).toBe(true);
    expect(looksLikeCityName('Забайкальск')).toBe(true);
  });

  it('мусор, цифры, ссылки и пустота — не город', () => {
    for (const c of ['', '  ', 'Б', '-', '...', 'Брест 20.11', 'дом 5', 'https://t.me/chat',
      '@driver', 'Минск  Варшава', 'едет из Минска в Варшаву и обратно заберу всё']) {
      expect(looksLikeCityName(c), c).toBe(false);
    }
    expect(looksLikeCityName(null)).toBe(false);
    expect(looksLikeCityName(undefined)).toBe(false);
  });
});

describe('isValidDate', () => {
  it('настоящая дата в формате базы проходит', () => {
    expect(isValidDate('2026-09-19')).toBe(true);
    expect(isValidDate('2026-02-28')).toBe(true);
    expect(isValidDate('2024-02-29')).toBe(true); // високосный
  });
  it('несуществующая и чужие форматы — нет', () => {
    expect(isValidDate('2026-02-31')).toBe(false);
    expect(isValidDate('2026-13-01')).toBe(false);
    expect(isValidDate('2025-02-29')).toBe(false);
    expect(isValidDate('19.09.2026')).toBe(false);
    expect(isValidDate('завтра')).toBe(false);
    expect(isValidDate(null)).toBe(false);
  });
});

describe('doubtsFor: что именно считается сомнением', () => {
  it('чистая заявка — сомнений нет', () => {
    expect(doubtsFor(clean(), NOW)).toEqual([]);
  });

  it('сообщение разбирал ИИ (source=parser) — сомнение, правила не были уверены', () => {
    expect(codes(clean({ source: 'parser' }))).toEqual(['ai_parsed']);
    expect(doubtsFor(clean({ source: 'parser' }), NOW)[0]!.note).toContain('ИИ');
  });

  it('город не похож на название — сомнение про этот город', () => {
    expect(codes(clean({ fromCity: 'Брест 20.11' }))).toEqual(['city_garbage']);
    expect(doubtsFor(clean({ toCity: '' }), NOW)[0]!.note).toContain('город назначения');
    expect(codes(clean({ fromCity: 'https://t.me/chat', toCity: 'минск варшава брест гродно белосток' })))
      .toEqual(['city_garbage', 'city_garbage']);
  });

  it('откуда и куда — один и тот же город', () => {
    expect(codes(clean({ toCity: 'брест' }))).toEqual(['same_city']);
  });

  it('дата выезда прошла — сомнение', () => {
    expect(codes(clean({ departureDate: '2026-09-01' }))).toEqual(['date_past']);
  });

  it('дата дальше 90 дней — сомнение: cron сразу унесёт заявку в архив', () => {
    expect(codes(clean({ departureDate: '2027-01-05' }))).toEqual(['date_far']);
    // ровно на границе горизонта — ещё можно публиковать
    expect(codes(clean({ departureDate: '2026-12-18' }))).toEqual([]);
  });

  it('далёкая дата регулярного рейса — не сомнение: cron катит её вперёд', () => {
    expect(codes(clean({ departureDate: '2027-01-05', recurring: 'каждый четверг' }))).toEqual([]);
  });

  it('нет даты — не сомнение, такие заявки живут на доске', () => {
    expect(codes(clean({ departureDate: null }))).toEqual([]);
  });

  it('дата, которую не разобрать, — сомнение', () => {
    expect(codes(clean({ departureDate: '2026-02-31' }))).toEqual(['date_bad']);
  });

  it('контакт в поле — чисто; тот же контакт только в тексте — сомнение', () => {
    expect(codes(clean())).toEqual([]);
    expect(codes(clean({ telegram: null, description: 'возьму посылку, писать @driver77' })))
      .toEqual(['contact_in_text']);
    // телефон в поле тоже закрывает вопрос
    expect(codes(clean({ telegram: null, phone: '+48579264254' }))).toEqual([]);
  });

  it('короткое описание сомнением не считается: «везу» — нормальная заявка', () => {
    expect(codes(clean({ description: 'везу' }))).toEqual([]);
  });

  it('несколько сомнений перечисляются все разом — в одной строке для карточки', () => {
    const d = doubtsFor(clean({ source: 'parser', departureDate: '2026-09-01', telegram: null,
      description: 'завтра, писать @driver77' }), NOW);
    expect(d.map((x) => x.code)).toEqual(['ai_parsed', 'date_past', 'contact_in_text']);
    const note = doubtNote(d);
    expect(note).toContain('ИИ');
    expect(note).toContain('прошла');
    expect(note).toContain('в тексте');
  });
});

describe('autoPublishVerdict: кто имеет право на автопубликацию', () => {
  it('чистая заявка от админа — публикуем', () => {
    expect(autoPublishVerdict(env, clean(), NOW).publish).toBe(true);
  });

  it('не от админа — не наше дело, и причин не выдумываем', () => {
    const v = autoPublishVerdict(env, clean({ byAdmin: false }), NOW);
    expect(v.publish).toBe(false);
    expect(v.doubts).toEqual([]);
  });

  it('сомневается — не публикуем и называем причину', () => {
    const v = autoPublishVerdict(env, clean({ source: 'parser' }), NOW);
    expect(v.publish).toBe(false);
    expect(doubtNote(v.doubts)).toContain('ИИ');
  });

  it('статус уже решён другим правилом — не перерешаем', () => {
    expect(autoPublishVerdict(env, clean({ status: 'published' }), NOW).publish).toBe(false);
    expect(autoPublishVerdict(env, clean({ status: 'rejected' }), NOW).publish).toBe(false);
  });

  it('рубильник AUTO_PUBLISH_ADMIN=0 выключает автопубликацию, по умолчанию она включена', () => {
    expect(autoPublishEnabled(env)).toBe(true);
    expect(autoPublishEnabled({ AUTO_PUBLISH_ADMIN: '1' } as Env)).toBe(true);
    expect(autoPublishEnabled({ AUTO_PUBLISH_ADMIN: '0' } as Env)).toBe(false);
    expect(autoPublishVerdict({ ...env, AUTO_PUBLISH_ADMIN: '0' } as Env, clean(), NOW).publish).toBe(false);
  });
});

/* ------------------------- фейковая база ------------------------- */

interface Call { sql: string; params: unknown[] }

/** Порядок колонок INSERT INTO listings (30) — тот же, что в store.ts. */
const COLS = ['id', 'type', 'from_city', 'to_city', 'departure_date', 'recurring', 'weight_kg',
  'price', 'description', 'phone', 'telegram', 'status', 'source', 'source_chat', 'source_chat_id',
  'source_message_id', 'source_chat_username', 'source_thread_id',
  'by_admin', 'hidden', 'created_at', 'published_at', 'from_city_lc',
  'to_city_lc', 'description_lc', 'reject_reason', 'stops', 'route_lc', 'from_stops_lc', 'to_stops_lc'];

/** Строка таблицы listings в том виде, в котором её читает mapRow. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'existing-1', type: 'offer', from_city: 'Брест', to_city: 'Варшава',
    departure_date: soonIso(), recurring: null, weight_kg: null, price: null,
    description: 'возьму посылку до 5 кг', phone: null, telegram: '@driver77',
    status: 'published', source: 'telegram', source_chat: null, source_chat_id: null,
    source_message_id: null, source_chat_username: null, source_thread_id: null,
    by_admin: 0, hidden: 0, views: 0, pinned_until: null,
    created_at: '2026-09-19T09:00:00.000Z', published_at: '2026-09-19T09:00:00.000Z',
    from_city_lc: 'брест', to_city_lc: 'варшава', description_lc: 'возьму посылку до 5 кг',
    reject_reason: null, stops: '["Брест","Варшава"]', route_lc: 'брест варшава',
    from_stops_lc: 'брест', to_stops_lc: 'варшава',
    ...over,
  };
}

function dbFake(opts: { seed?: Record<string, unknown>[]; settings?: Record<string, string> } = {}) {
  const calls: Call[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  for (const r of opts.seed ?? []) rows.set(String(r.id), r);
  const seen = new Map<string, string | null>();
  const make = (sql: string) => {
    const call: Call = { sql, params: [] };
    calls.push(call);
    const stmt = {
      bind(...p: unknown[]) { call.params = p; return stmt; },
      async all() {
        if (/PRAGMA table_info/.test(sql)) return { results: COLS.map((name) => ({ name })) };
        // кандидаты в дубли (findDuplicateCandidates)
        if (/SELECT \* FROM listings/.test(sql)) return { results: [...rows.values()] };
        return { results: [] };
      },
      async first() {
        if (/SELECT value FROM settings/.test(sql)) {
          const v = (opts.settings ?? {})[String(call.params[0])];
          return v == null ? null : { value: v };
        }
        if (/SELECT listing_id FROM tg_seen/.test(sql)) {
          const id = seen.get(`${call.params[0]}|${call.params[1]}`);
          return id ? { listing_id: id } : null;
        }
        if (/SELECT \* FROM listings WHERE id = /i.test(sql)) return rows.get(String(call.params[0])) ?? null;
        if (/COUNT\(\*\)/i.test(sql)) return { n: 0 };
        return null;
      },
      async run() {
        if (/INSERT OR IGNORE INTO tg_seen/.test(sql)) {
          const key = `${call.params[0]}|${call.params[1]}`;
          if (seen.has(key)) return { meta: { changes: 0 } };
          seen.set(key, null);
          return { meta: { changes: 1 } };
        }
        if (/UPDATE tg_seen SET listing_id/.test(sql)) {
          seen.set(`${call.params[1]}|${call.params[2]}`, String(call.params[0]));
          return { meta: { changes: 1 } };
        }
        if (/INSERT INTO listings/.test(sql)) {
          const r: Record<string, unknown> = {};
          COLS.forEach((name, i) => { r[name] = call.params[i]; });
          rows.set(String(r.id), r);
          return { meta: { changes: 1 } };
        }
        if (/UPDATE listings SET published_at/.test(sql)) {
          const r = rows.get(String(call.params[1]));
          if (r) r.published_at = call.params[0];
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 1 } };
      },
    };
    return stmt;
  };
  return {
    db: { prepare: make, batch: async (s: unknown[]) => Promise.all(s as never) },
    calls, rows,
  };
}

const withDb = (opts: Parameters<typeof dbFake>[0] = {}, over: Record<string, unknown> = {}) => {
  const f = dbFake(opts);
  return { ...f, env: { ...env, DB: f.db, KV: { get: async () => null, put: async () => undefined, delete: async () => undefined }, ...over } as unknown as Env };
};

/** Дата выезда в интеграционных тестах — относительная. Хардкод «2026-09-25»
 *  через пару месяцев станет просроченным, правило date_past сработает, и тест
 *  начнёт проверять совсем не то (в pure-тестах выше дата явная вместе с NOW). */
const soonIso = (days = 6) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

function input(over: Partial<ListingInput> = {}): ListingInput {
  return {
    type: 'offer', fromCity: 'Брест', toCity: 'Варшава', departureDate: soonIso(),
    recurring: null, description: 'возьму посылку до 5 кг', telegram: '@driver77', phone: null,
    status: 'pending', source: 'telegram', byAdmin: true, ...over,
  };
}

/* ------------------- createListing: статус по факту ------------------- */

describe('createListing: админская заявка публикуется сама', () => {
  it('чистая заявка от админа — published, с датой публикации', async () => {
    const { env: e, rows } = withDb();
    const l = await createListing(e, input());
    expect(l.status).toBe('published');
    expect(l.publishedAt).toBeTruthy();
    expect(rows.get(l.id)!.published_at).toBeTruthy();
  });

  it('та же заявка от постороннего — pending: автопубликация только для админских', async () => {
    const { env: e } = withDb();
    const l = await createListing(e, input({ byAdmin: false, fromPerson: true }));
    expect(l.status).toBe('pending');
    expect(l.publishedAt).toBeNull();
  });

  it('сомнительная от админа (разбирал ИИ) — остаётся в очереди', async () => {
    const { env: e } = withDb();
    expect((await createListing(e, input({ source: 'parser' }))).status).toBe('pending');
  });

  it('сомнительная от админа (дата прошла) — остаётся в очереди', async () => {
    const { env: e } = withDb();
    expect((await createListing(e, input({ departureDate: '2026-09-01' }))).status).toBe('pending');
  });

  it('рубильник AUTO_PUBLISH_ADMIN=0 — даже чистая админская ждёт модератора', async () => {
    const { env: e } = withDb({}, { AUTO_PUBLISH_ADMIN: '0' });
    expect((await createListing(e, input())).status).toBe('pending');
  });

  it('AUTO_APPROVE=1 публикует всё — статус задаёт вызывающий код, автопубликация не мешает', async () => {
    const { env: e } = withDb({}, { AUTO_APPROVE: '1' });
    // так делают все точки входа: при AUTO_APPROVE=1 они сами ставят published
    const l = await createListing(e, input({ byAdmin: false, fromPerson: true, status: 'published' }));
    expect(l.status).toBe('published');
  });

  it('правило «нет контакта» сильнее автопубликации: offer отклонён с причиной', async () => {
    const { env: e, rows } = withDb();
    const l = await createListing(e, input({ telegram: null, phone: null }));
    expect(l.status).toBe('rejected');
    expect(rows.get(l.id)!.reject_reason).toBe('no_contact');
  });

  it('«ищу передачу» без контакта из бота — отклонена, а не спрятана в подбор', async () => {
    const { env: e, rows } = withDb();
    const l = await createListing(e, input({ type: 'request', telegram: null, phone: null }));
    expect(l.status).toBe('rejected');
    expect(l.hidden).toBe(false);
    expect(rows.get(l.id)!.hidden).toBe(0);
  });

  it('«ищу передачу» без контакта с сайта — по-прежнему опубликована скрытой', async () => {
    const { env: e, rows } = withDb();
    const l = await createListing(e, input({ type: 'request', source: 'site', byAdmin: false,
      fromPerson: true, telegram: null, phone: null }));
    expect(l.status).toBe('published');
    expect(l.hidden).toBe(true);
    expect(rows.get(l.id)!.hidden).toBe(1);
  });
});

/* --------------- createListingSafe: дубли и «похожие» --------------- */

describe('createListingSafe: точный дубль не создаётся ни от кого', () => {
  it('дубль от админа — новая заявка не создана, живая освежена наверху доски', async () => {
    const { env: e, calls, rows } = withDb({ seed: [row()] });
    const res = await createListingSafe(e, input());
    expect(res.created).toBe(false);
    expect(res.kind).toBe('duplicate');
    expect(res.listing.id).toBe('existing-1');
    expect(rows.size, 'вторая заявка не появилась').toBe(1);
    expect(calls.some((c) => /UPDATE listings SET published_at/.test(c.sql)), 'живую освежили').toBe(true);
  });

  it('дубль от постороннего человека — тоже не создан: красное отклоняется без модератора', async () => {
    const { env: e, rows } = withDb({ seed: [row()] });
    const res = await createListingSafe(e, input({ byAdmin: false, fromPerson: true }));
    expect(res.created).toBe(false);
    expect(res.kind).toBe('duplicate');
    expect(rows.size).toBe(1);
  });

  it('«похожая» заявка (серое) создаётся, а админская сразу публикуется — старая остаётся на месте', async () => {
    // тот же рейс и текст, но другой контакт: люди разные — это «похоже», не дубль
    const { env: e, rows } = withDb({ seed: [row({ telegram: '@other_driver' })] });
    const res = await createListingSafe(e, input());
    expect(res.created).toBe(true);
    expect(res.kind).toBe('similar');
    expect(res.listing.status).toBe('published');
    // старую не заменяем и не снимаем — правило владельца «принимать без замены»
    expect(rows.get('existing-1')!.status).toBe('published');
    expect(rows.get('existing-1')!.telegram).toBe('@other_driver');
    expect(rows.size).toBe(2);
  });

  it('«похожая» заявка от постороннего — создана и ждёт модератора, как раньше', async () => {
    const { env: e } = withDb({ seed: [row({ telegram: '@other_driver' })] });
    const res = await createListingSafe(e, input({ byAdmin: false, fromPerson: true }));
    expect(res.created).toBe(true);
    expect(res.kind).toBe('similar');
    expect(res.listing.status).toBe('pending');
  });
});

/* --------------------- ответ человеку: честно --------------------- */

describe('listingStatusNote: что слышит человек', () => {
  const l = (over: Partial<Listing> = {}) => ({
    id: 'x1', type: 'offer', fromCity: 'Брест', toCity: 'Варшава', description: 'везу',
    status: 'pending', source: 'telegram', createdAt: '', publishedAt: null, views: 0,
    fromPerson: false, hidden: false, ...over,
  } as unknown as Listing);

  it('отклонённому водителю — про пассажиров', () => {
    const note = listingStatusNote(l({ status: 'rejected', type: 'offer' }));
    expect(note).toContain('Не принято');
    expect(note).toContain('объявлении водителя');
  });

  it('отклонённой просьбе — про то, что написать некуда ей (а не «водителю»)', () => {
    const note = listingStatusNote(l({ status: 'rejected', type: 'request' }));
    expect(note).toContain('Не принято');
    expect(note).toContain('в просьбе нет контакта');
    expect(note).not.toContain('водителя');
  });

  it('опубликованная — «уже на доске», скрытая — «подбираю попутчика»', () => {
    expect(listingStatusNote(l({ status: 'published' }))).toContain('уже на доске');
    expect(listingStatusNote(l({ status: 'published', hidden: true }))).toContain('Подбираю попутчика');
  });

  it('в очереди — «отправлено на модерацию»', () => {
    expect(listingStatusNote(l())).toContain('модерацию');
  });
});

/* ------------------- поток целиком: копия радара ------------------- */

interface Sent { method: string; body: Record<string, unknown> }
let sent: Sent[] = [];

beforeEach(() => {
  sent = [];
  global.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const method = String(url).split('/').pop() ?? '';
    try {
      sent.push({ method, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> });
    } catch { /* тело не JSON — не важно */ }
    return new Response('{"ok":true,"result":{"message_id":1}}', {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});
afterEach(() => { vi.unstubAllGlobals(); });

const baseEnv = {
  BOT_TOKEN: 'test-token',
  ADMIN_IDS: '42',
  SITE_URL: 'https://pop-utka.app',
  BOT_USERNAME: 'parcel_transfer_bot',
  RADAR_USERNAMES: 'Daniil06496',
  KV: { get: async () => null, put: async () => undefined, delete: async () => undefined },
} as unknown as Env;

/** Сообщение в личку бота. «завтра» — намеренно относительная дата: хардкод
 *  даты в фикстуре через полгода сделал бы тест просроченным. */
function pm(messageId: number, from: { id: number; username?: string }, text: string) {
  return {
    update_id: messageId,
    message: {
      message_id: messageId,
      date: 1789000000,
      chat: { id: 555, type: 'private' } as never,
      from: from as never,
      text,
    },
  };
}

const textsTo = (chatId: number) => sent
  .filter((s) => s.method === 'sendMessage' && s.body.chat_id === chatId)
  .map((s) => String(s.body.text ?? ''));

describe('копия радара в личке админа — поток целиком', () => {
  const CLEAN = 'Нужно передать завтра Гродно — Белосток, конверт с документами, писать @driver77';

  it('разбор не сомневается: заявка сразу published, админу карточка «Опубликовано автоматически» с кнопкой снять', async () => {
    const f = dbFake();
    await handleTelegramUpdate({ ...baseEnv, DB: f.db } as unknown as Env,
      pm(900, { id: 42, username: 'Daniil06496' }, CLEAN));

    const ins = f.calls.find((c) => c.sql.includes('INSERT INTO listings'));
    expect(ins, 'заявка создана').toBeTruthy();
    const r = f.rows.get(String(ins!.params[0]))!;
    expect(r.status, 'опубликована без модератора').toBe('published');
    expect(r.by_admin).toBe(1);

    const card = textsTo(42).join('\n');
    expect(card).toContain('Опубликовано автоматически');
    expect(card).toContain('разбор не сомневался');
    const kb = sent.find((s) => s.body.reply_markup != null)?.body.reply_markup as
      { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    expect(kb.inline_keyboard[0]!.map((b) => b.text)).toEqual(['Снять с доски']);
    expect(kb.inline_keyboard[0]![0]!.callback_data).toBe(`rej:${String(ins!.params[0])}`);
  });

  it('контакт только ссылкой в тексте — сомнение: заявка в очереди, и в карточке названа причина', async () => {
    const f = dbFake();
    await handleTelegramUpdate({ ...baseEnv, DB: f.db } as unknown as Env,
      pm(901, { id: 42, username: 'Daniil06496' },
        'Нужно передать завтра Гродно — Белосток, конверт с документами, ссылка https://t.me/granica_belarus_chat/153043/153048'));

    const ins = f.calls.find((c) => c.sql.includes('INSERT INTO listings'))!;
    expect(f.rows.get(String(ins.params[0]))!.status).toBe('pending');

    const card = textsTo(42).join('\n');
    expect(card).toContain('Автоматически не опубликовано');
    expect(card).toContain('контакт написан в тексте');
    expect(card).not.toContain('Опубликовано автоматически');
    // это обычная карточка модерации — с кнопкой «Одобрить» в reply_markup
    const kb = sent.find((s) => s.body.reply_markup != null)?.body.reply_markup as
      { inline_keyboard: Array<Array<{ text: string }>> };
    expect(kb.inline_keyboard[0]!.map((b) => b.text)).toEqual(['Одобрить', 'Отклонить']);
  });

  it('заявка постороннего в личке — в очереди, автопубликация её не касается', async () => {
    const f = dbFake();
    await handleTelegramUpdate({ ...baseEnv, DB: f.db } as unknown as Env,
      pm(902, { id: 99, username: 'ivan_p' }, CLEAN));

    const ins = f.calls.find((c) => c.sql.includes('INSERT INTO listings'))!;
    const r = f.rows.get(String(ins.params[0]))!;
    expect(r.status).toBe('pending');
    // 2 — заявку подал посторонний человек сам (личка бота), не админ
    expect(r.by_admin).toBe(2);
    const card = textsTo(42).join('\n');
    expect(card).not.toContain('Опубликовано автоматически');
    // причина сомнения не показывается: заявка и не должна была публиковаться сама
    expect(card).not.toContain('Автоматически не опубликовано');
  });

  it('без контакта заявка из бота отклоняется: ни карточки модерации, ни «подбора»', async () => {
    const f = dbFake();
    await handleTelegramUpdate({ ...baseEnv, DB: f.db } as unknown as Env,
      pm(903, { id: 42, username: 'Daniil06496' }, 'Нужно передать завтра Гродно — Белосток, конверт с документами'));

    const ins = f.calls.find((c) => c.sql.includes('INSERT INTO listings'))!;
    const r = f.rows.get(String(ins.params[0]))!;
    expect(r.status).toBe('rejected');
    expect(r.reject_reason).toBe('no_contact');
    const card = textsTo(42).join('\n');
    expect(card).not.toContain('Заявка без контакта');
    expect(card).not.toContain('Опубликовано автоматически');
  });
});

describe('форум-канал: автопубликация рассылает, скрытые заявки — нет', () => {
  const cfg = { chat: '-100999', fallback: 1 };

  it('опубликованная заявка уходит ссылкой в комнату направления', async () => {
    const f = dbFake({ settings: { forum_broadcast: JSON.stringify(cfg) } });
    const listing = {
      id: 'a1', type: 'offer', fromCity: 'Брест', toCity: 'Варшава', description: 'везу',
      status: 'published', source: 'telegram', createdAt: '', publishedAt: null, views: 0,
      fromPerson: false, hidden: false,
    } as unknown as Listing;
    await broadcastListingToForum({ ...baseEnv, DB: f.db } as unknown as Env, listing);
    const post = sent.find((s) => s.method === 'sendMessage' && s.body.chat_id === -100999);
    expect(post, 'ссылка в форум-канал отправлена').toBeTruthy();
    expect(String(post!.body.text)).toContain('/item/a1');
    expect(post!.body.message_thread_id).toBe(1);
  });

  it('скрытая заявка (без контакта, только для подбора) в публичный канал не уходит', async () => {
    const f = dbFake({ settings: { forum_broadcast: JSON.stringify(cfg) } });
    const listing = {
      id: 'a2', type: 'request', fromCity: 'Брест', toCity: 'Варшава', description: 'нужно передать',
      status: 'published', source: 'site', createdAt: '', publishedAt: null, views: 0,
      fromPerson: true, hidden: true,
    } as unknown as Listing;
    await broadcastListingToForum({ ...baseEnv, DB: f.db } as unknown as Env, listing);
    expect(sent.filter((s) => s.method === 'sendMessage')).toHaveLength(0);
  });
});

/* ---------- ответ сайта: честный статус (POST /api/listings) ---------- */

describe('POST /api/listings: ответ говорит правду о статусе', () => {
  const ADMIN_TOKEN = 'testkey';

  function apiEnv(seed: Record<string, unknown>[] = []) {
    const f = dbFake({ seed });
    const kv = new Map<string, string>();
    const e = {
      ...env, DB: f.db, ADMIN_API_TOKEN: ADMIN_TOKEN, SITE_URL: 'https://pop-utka.app',
      KV: {
        get: async (k: string) => kv.get(k) ?? null,
        put: async (k: string, v: string) => { kv.set(k, String(v)); },
        delete: async (k: string) => { kv.delete(k); },
      },
    } as unknown as Env;
    return { ...f, env: e };
  }

  async function post(e: Env, body: unknown, token?: string) {
    vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => undefined } });
    const req = new Request('https://pop-utka.app/api/listings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const ctx = {
      waitUntil: (p: Promise<unknown>) => { p.catch(() => undefined); },
      passThroughOnException: () => undefined,
    };
    const fn = (worker as unknown as { fetch: (r: Request, e: Env, c: unknown) => Promise<Response> }).fetch;
    return fn(req, e, ctx);
  }

  const payload = () => ({
    type: 'offer', fromCity: 'Брест', toCity: 'Варшава',
    description: 'возьму посылку до 5 кг', telegram: '@driver77', departureDate: soonIso(),
  });

  it('подача с ключом админки: опубликована сразу, ответ и код — про публикацию', async () => {
    const { env: e, rows } = apiEnv();
    const res = await post(e, payload(), ADMIN_TOKEN);
    expect(res.status, '201 — заявка создана и уже на доске').toBe(201);
    const body = await res.json() as { message: string; item: { status: string; id: string } };
    expect(body.item.status).toBe('published');
    expect(rows.get(body.item.id)!.by_admin).toBe(1);
    expect(body.message).toContain('опубликовано');
    // старая версия брала статус из намерения (input.status) и на уже
    // опубликованную заявку отвечала «отправлено на модерацию» — враньё
    expect(body.message).not.toContain('модерацию');
  });

  it('подача постороннего: 202 и «отправлено на модерацию»', async () => {
    const { env: e } = apiEnv();
    const res = await post(e, payload());
    expect(res.status).toBe(202);
    const body = await res.json() as { message: string; item: { status: string } };
    expect(body.item.status).toBe('pending');
    expect(body.message).toContain('модерацию');
  });

  it('рубить AUTO_PUBLISH_ADMIN=0 — и заявка админки снова ждёт модератора', async () => {
    const f = apiEnv();
    const e = { ...f.env, AUTO_PUBLISH_ADMIN: '0' } as unknown as Env;
    const res = await post(e, payload(), ADMIN_TOKEN);
    expect(res.status).toBe(202);
    const body = await res.json() as { item: { status: string } };
    expect(body.item.status).toBe('pending');
  });
});
