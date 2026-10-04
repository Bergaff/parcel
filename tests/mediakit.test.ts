/**
 * Статистика аудитории (/mediakit): вход по логину/паролю (задаётся в
 * админке или секретами), обезличивание посетителей, классификация
 * User-Agent и рефереров, страница и CSV. Без сети — чистые функции.
 */
import { describe, expect, it } from 'vitest';

import type { Env } from '../src/types';
import {
  checkMediaCredentials,
  getCookie,
  isMediaAuthed,
  mediaCookieValue,
  renderLoginPage,
} from '../src/mediakit';
import {
  classifyRef,
  classifyUserAgent,
  countryFlag,
  gatherVisitStats,
  isDatacenterOrg,
  isTrackablePage,
  lastDays,
  pageKind,
  renderAudiencePage,
  renderDailyCsv,
  visitorId,
  type AudienceStats,
} from '../src/visit-stats';

/** Заглушка D1: может отдавать настройки (mediakit_hash из «админки»). */
function envWithDb(over: { settings?: Record<string, string> } & Partial<Env> = {}): Env {
  const settings = over.settings ?? {};
  const stmt = {
    bind: () => stmt,
    first: async () => (Object.keys(settings).length > 0 ? { value: Object.values(settings)[0] } : null),
    all: async () => ({ results: [] }),
    run: async () => ({ meta: {} }),
  };
  const db = { prepare: () => stmt, batch: async (s: unknown[]) => Promise.all(s as never) };
  return { DB: db, MEDIA_LOGIN: 'partner', MEDIA_PASSWORD: 's3cret', ...over } as unknown as Env;
}

describe('вход по логину и паролю', () => {
  it('хеш стабилен для пары и меняется от пароля', async () => {
    const a = await mediaCookieValue('partner', 's3cret');
    expect(a).toBe(await mediaCookieValue('partner', 's3cret'));
    expect(a).not.toBe(await mediaCookieValue('partner', 'другой'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('checkMediaCredentials принимает env-пару и отвергает мусор', async () => {
    const good = await checkMediaCredentials('partner', 's3cret', envWithDb());
    expect(good).toBe(await mediaCookieValue('partner', 's3cret'));
    expect(await checkMediaCredentials('partner', 'WRONG', envWithDb())).toBeNull();
  });

  it('пара из админки главнее: env-пара больше не пускает, пока не сброшено', async () => {
    const envHash = await mediaCookieValue('partner', 's3cret');
    const env = envWithDb({ settings: { mediakit_hash: await mediaCookieValue('partner', 'birja2026') } });
    // новая пара из «админки» — работает
    expect(await checkMediaCredentials('partner', 'birja2026', env)).toBeTruthy();
    // старая env-пара — больше нет
    expect(await checkMediaCredentials('partner', 's3cret', env)).toBeNull();
    expect(await isMediaAuthed(envHash, env)).toBe(false);
  });

  it('isMediaAuthed: верная cookie — true, мусор — false', async () => {
    const env = envWithDb();
    const good = await mediaCookieValue('partner', 's3cret');
    expect(await isMediaAuthed(good, env)).toBe(true);
    expect(await isMediaAuthed('f'.repeat(64), env)).toBe(false);
    expect(await isMediaAuthed(null, env)).toBe(false);
  });

  it('getCookie достаёт значение из заголовка', () => {
    const req = new Request('https://pop-utka.app/mediakit', {
      headers: { cookie: 'other=1; media=abc123' },
    });
    expect(getCookie(req, 'media')).toBe('abc123');
    expect(getCookie(req, 'нет')).toBeNull();
  });

  it('страница входа — форма, noindex, без цифр', () => {
    const html = renderLoginPage('Неверный логин или пароль.');
    expect(html).toContain('action="/mediakit/login"');
    expect(html).toContain('type="password"');
    expect(html).toContain('noindex');
    expect(html).not.toContain('посетителей в день');
  });
});

describe('классификация User-Agent', () => {
  it('роботы опознаются, люди — нет', () => {
    for (const ua of ['Googlebot/2.1', 'TelegramBot (like TwitterBot)', 'python-requests/2.31',
      'curl/8.0', 'Mozilla/5.0 (compatible; YandexBot)', 'GPTBot/1.0', '']) {
      expect(classifyUserAgent(ua).bot, ua || '(пусто)').toBe(true);
    }
    for (const ua of ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)']) {
      expect(classifyUserAgent(ua).bot, ua).toBe(false);
    }
  });

  it('устройство и ОС', () => {
    expect(classifyUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'))
      .toMatchObject({ device: 'Телефон', os: 'iOS' });
    expect(classifyUserAgent('Mozilla/5.0 (iPad; CPU OS 16_0)'))
      .toMatchObject({ device: 'Планшет', os: 'iOS' });
    expect(classifyUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'))
      .toMatchObject({ device: 'Компьютер', os: 'Windows' });
    expect(classifyUserAgent('Mozilla/5.0 (Linux; Android 13; Pixel 7)'))
      .toMatchObject({ device: 'Телефон', os: 'Android' });
    expect(classifyUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)'))
      .toMatchObject({ device: 'Компьютер', os: 'macOS' });
  });

  it('VPN и дата-центры по asOrganization', () => {
    expect(isDatacenterOrg('Hetzner Online GmbH')).toBe(true);
    expect(isDatacenterOrg('M247 Europe SRL')).toBe(true);
    expect(isDatacenterOrg('Beltelecom')).toBe(false);
    expect(isDatacenterOrg(null)).toBe(false);
  });
});

describe('источники трафика', () => {
  const site = 'pop-utka.app';
  it('классификация рефереров', () => {
    expect(classifyRef('https://t.me/somechat', site).group).toBe('Telegram');
    expect(classifyRef('https://www.google.com/', site).group).toBe('Поиск');
    expect(classifyRef('https://yandex.ru/search/', site).group).toBe('Поиск');
    expect(classifyRef('https://vk.com/wall', site).group).toBe('Соцсети');
    expect(classifyRef('https://pop-utka.app/routes', site).group).toBe('Внутренние');
    expect(classifyRef(null, site)).toEqual({ group: 'Напрямую', host: null });
    const other = classifyRef('https://forum.example.by/thread', site);
    expect(other).toEqual({ group: 'Другие сайты', host: 'forum.example.by' });
  });

  it('битый referer — «напрямую»', () => {
    expect(classifyRef('не url', site).group).toBe('Напрямую');
  });
});

describe('страницы', () => {
  it('kind по пути', () => {
    expect(pageKind('/')).toBe('Главная');
    expect(pageKind('/r/varshava-minsk')).toBe('Маршруты');
    expect(pageKind('/gorod/minsk')).toBe('Города');
    expect(pageKind('/item/abc')).toBe('Карточки объявлений');
    expect(pageKind('/itogi/2026-09')).toBe('Итоги');
    expect(pageKind('/privacy')).toBe('Прочее');
  });

  it('что трекаем, а что нет', () => {
    expect(isTrackablePage('/')).toBe(true);
    expect(isTrackablePage('/r/x')).toBe(true);
    expect(isTrackablePage('/item/x')).toBe(true);
    expect(isTrackablePage('/api/listings')).toBe(false);
    expect(isTrackablePage('/admin')).toBe(false);
    expect(isTrackablePage('/mediakit')).toBe(false);
    expect(isTrackablePage('/styles.css')).toBe(false);
  });
});

describe('обезличенный посетитель', () => {
  it('хеш стабилен в пределах дня и меняется на следующий', async () => {
    const a = await visitorId('1.2.3.4', 'UA', '2026-10-02', 'salt');
    expect(a).toBe(await visitorId('1.2.3.4', 'UA', '2026-10-02', 'salt'));
    expect(a).not.toBe(await visitorId('1.2.3.4', 'UA', '2026-10-03', 'salt'));
    expect(a).not.toBe(await visitorId('5.6.7.8', 'UA', '2026-10-02', 'salt'));
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  it('флаги стран', () => {
    expect(countryFlag('BY')).toBe('🇧🇾');
    expect(countryFlag('ru')).toBe('🇷🇺');
    expect(countryFlag('—')).toBe('🌐');
    expect(countryFlag('')).toBe('🌐');
  });

  it('lastDays — подряд идущие дни, последний сегодня', () => {
    const days = lastDays(7);
    expect(days).toHaveLength(7);
    expect(days[6]).toBe(new Date().toISOString().slice(0, 10));
    const parsed = days.map((d) => Date.parse(`${d}T00:00:00Z`));
    for (let i = 1; i < parsed.length; i += 1) {
      expect(parsed[i]! - parsed[i - 1]!).toBe(86400e3);
    }
  });
});

describe('страница и CSV', () => {
  const audience: AudienceStats = {
    days: 7,
    generatedAt: '2026-10-02T12:00:00Z',
    coveredDays: 3,
    avgUniques: 28,
    views: 48,
    rawViews: 91,
    uniquesSum: 84,
    pagesPerVisitor: '1,7',
    botsFiltered: 30,
    daily: [
      { day: '2026-09-30', uniques: 20, views: 33, bots: 3 },
      { day: '2026-10-01', uniques: 28, views: 48, bots: 10 },
      { day: '2026-10-02', uniques: 36, views: 60, bots: 17 },
    ],
    countries: [
      { country: 'RU', views: 12, share: 25 },
      { country: 'US', views: 10, share: 20.8 },
    ],
    dcViews: 13,
    devices: [{ name: 'Телефон', views: 30, share: 62.5 }],
    os: [{ name: 'iOS', views: 18, share: 37.5 }],
    sources: [{ name: 'Telegram', views: 20, share: 41.7 }],
    referrers: [{ host: 't.me', views: 20, share: 41.7 }],
    pages: [
      { name: 'Главная', views: 32, share: 66.7 },
      { name: 'Маршруты', views: 16, share: 33.3 },
    ],
    bot: { total: 17, active: 7 },
  };

  it('карточки, график, таблицы, методика, действия', () => {
    const html = renderAudiencePage({
      audience,
      board: { onBoard: 154, last30Arrived: 210, last30Cities: 17, viewsTotal: 5230 },
    });
    for (const marker of [
      'посетителей в день (среднее)', '28', 'просмотров страниц', '48',
      'страниц на посетителя', '1,7', 'отфильтровано роботов', '30',
      'Сырых просмотров за период — 91', 'Роботов отфильтровано',
      'Динамика по дням', 'География', '🇷🇺 Россия', 'Из них через VPN / дата-центры: 13',
      'Устройства', 'Операционные системы', 'Источники трафика', 'Основные источники',
      'Страницы', 'Telegram-бот (@parcel_transfer_bot)', 'Методика подсчёта',
      'Скачать CSV', 'Печать / PDF', 'Выйти', 'Период покрыт данными на 3 из 7',
      '/mediakit?days=30', '/mediakit?days=1',
      'объявлений на доске', // сводка площадки
    ]) {
      expect(html).toContain(marker);
    }
    expect(html).toContain('noindex');
    // вся страница в одной методике: сырой плитки «подтверждены %» больше нет
    expect(html).not.toContain('подтверждены браузером');
  });

  it('пустые разделы — «Пока нет данных», страница не падает', () => {
    const empty = renderAudiencePage({ audience: { ...audience, devices: [], os: [], sources: [], referrers: [] }, board: null });
    expect(empty.match(/Пока нет данных/g)?.length).toBe(4);
    expect(empty).not.toContain('объявлений на доске');
  });

  it('никаких персональных данных и ссылок на карточки', () => {
    const html = renderAudiencePage({ audience, board: null });
    expect(html).not.toContain('/item/');
    expect(html).not.toContain('+375');
    expect(html).not.toContain('+48');
  });

  it('CSV: заголовок, строки, BOM для Excel', () => {
    const csv = renderDailyCsv(audience.daily);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('day;visitors_live;views_live;bots_filtered');
    expect(csv).toContain('2026-10-01;28;48;10');
    expect(csv.split('\n')).toHaveLength(5); // заголовок + 3 строки + пустой хвост
  });

  it('график печатается: цвета столбиков не пропадают в PDF', () => {
    const html = renderAudiencePage({ audience, board: null });
    // без print-color-adjust браузеры при печати выкидывают фоны — гистограммы пустые
    expect(html.match(/print-color-adjust: exact/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('-webkit-print-color-adjust: exact');
  });

  it('плитки и примечание — живая аудитория; пустой случай объяснён', () => {
    const html = renderAudiencePage({ audience, board: null });
    expect(html).toContain('только живая аудитория');
    expect(html).toContain('Сырых просмотров за период — 91');
    const empty = renderAudiencePage({ audience: { ...audience, views: 0 }, board: null });
    expect(empty).toContain('не зафиксировано живых посетителей');
  });

  it('методика предупреждает про ботов с браузерными User-Agent', () => {
    const html = renderAudiencePage({ audience, board: null });
    expect(html).toContain('подделывающие браузерные User-Agent');
  });
});

describe('агрегаты — только живая аудитория', () => {
  it('запросы таблиц (гео/устройства/ОС/источники/страницы) джойнят stat_js', async () => {
    const sqls: string[] = [];
    const stmt = {
      bind: () => stmt,
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ meta: {} }),
    };
    const env = {
      DB: {
        prepare: (sql: string) => { sqls.push(sql); return stmt; },
        batch: async (s: unknown[]) => Promise.all(s as never),
      },
    } as unknown as Env;
    await gatherVisitStats(env, 7);
    const selects = sqls.filter((s) => s.startsWith('SELECT'));
    // динамика по дням, гео, дата-центры, устройства, ОС, источники,
    // рефереры, страницы — всё живая аудитория (джойн с stat_js)
    const live = selects.filter((s) => s.includes('stat_js'));
    expect(live.length).toBeGreaterThanOrEqual(8);
    // сырой подсчёт роботов — без джойна: боты маячок не шлют
    expect(selects.some((s) => s.includes('SUM(bot)') && !s.includes('stat_js'))).toBe(true);
  });

  it('дата-центры и VPN опознаются по AS-организации', () => {
    for (const org of ['AEZA International Ltd.', 'Stark Industries Solutions Ltd',
      'PONEY TELECOM', 'M247 Europe SRL', 'Google LLC', 'Melbikomas UAB', 'G-Core Labs']) {
      expect(isDatacenterOrg(org), org).toBe(true);
    }
    for (const org of ['BELTELECOM', 'MTS Belarus', 'Deutsche Telekom', 'Orange Polska']) {
      expect(isDatacenterOrg(org), org).toBe(false);
    }
  });
});
