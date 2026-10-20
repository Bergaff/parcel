import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { aiMonthSummary, cleanMonthSummary, monthSummaryFacts, parseAiListings, trimDescription, validateAiListing } from '../src/ai';

const NOW = new Date('2026-09-14T12:00:00+03:00');
const TEXT = 'Завтра везу посылку Крокодилово — Бегемотово, 5 кг, 100 zł, @driver77';

function ok(overrides: Record<string, unknown> = {}) {
  return {
    is_listing: true,
    is_passenger: false,
    type: 'offer',
    from_city: 'Крокодилово',
    to_city: 'Бегемотово',
    departure_date: '2026-09-15',
    weight_kg: 5,
    price: '100 zł',
    telegram: '@driver77',
    phone: null,
    description: 'Везу посылку, 5 кг, оплата 100 zł',
    ...overrides,
  };
}

describe('validateAiListing — валидация ответа DeepSeek', () => {
  it('корректный ответ превращается в поля заявки', () => {
    const f = validateAiListing(ok(), { now: NOW, originalText: TEXT });
    expect(f).not.toBeNull();
    expect(f!.type).toBe('offer');
    expect(f!.fromCity).toBe('Крокодилово');
    expect(f!.toCity).toBe('Бегемотово');
    expect(f!.departureDate).toBe('2026-09-15');
    expect(f!.weightKg).toBe(5);
    expect(f!.price).toBe('100 zł');
    expect(f!.telegram).toBe('@driver77');
  });

  it('знакомую латиницу переводит: Warsaw → Варшава', () => {
    const f = validateAiListing(ok({ from_city: 'Warsaw', to_city: 'Минск' }), { now: NOW, originalText: TEXT });
    expect(f!.fromCity).toBe('Варшава');
  });

  it('не-объявление и пассажирская попутка — мимо', () => {
    expect(validateAiListing({ is_listing: false }, { now: NOW, originalText: TEXT })).toBeNull();
    expect(validateAiListing(ok({ is_passenger: true }), { now: NOW, originalText: TEXT })).toBeNull();
  });

  it('незнакомую латиницу в городах — отбраковывает', () => {
    expect(validateAiListing(ok({ from_city: 'Qwertyville' }), { now: NOW, originalText: TEXT })).toBeNull();
  });

  it('мусор вместо JSON и пустые поля — отбраковывает', () => {
    expect(validateAiListing('не JSON', { now: NOW, originalText: TEXT })).toBeNull();
    expect(validateAiListing(null, { now: NOW, originalText: TEXT })).toBeNull();
    expect(validateAiListing(ok({ from_city: '', to_city: '' }), { now: NOW, originalText: TEXT })).toBeNull();
    expect(validateAiListing(ok({ type: 'поездка' }), { now: NOW, originalText: TEXT })).toBeNull();
  });

  it('невалидная дата отбрасывается, а вместо неё — дата из текста сообщения', () => {
    // '1111-11-11' и '2030-01-01' мимо разумных пределов — их не берём. Но в
    // самом сообщении есть «завтра», поэтому заявка не остаётся без даты:
    // запасной ход (v0.4.40) достаёт завтрашний день правилом.
    const f = validateAiListing(ok({ departure_date: '1111-11-11' }), { now: NOW, originalText: TEXT })!;
    expect(f.departureDate).not.toBe('1111-11-11');
    expect(f.departureDate).toBe('2026-09-15');
    expect(validateAiListing(ok({ departure_date: '2030-01-01' }), { now: NOW, originalText: TEXT })!.departureDate).toBe('2026-09-15');
  });

  it('в тексте даты нет — заявка честно остаётся без даты', () => {
    const f = validateAiListing(ok({ departure_date: '1111-11-11' }), {
      now: NOW, originalText: 'Везу посылку Крокодилово — Бегемотово, 5 кг, есть место',
    })!;
    expect(f.departureDate).toBeNull();
  });

  it('запасной ход: относительные сроки, которые модель отдаёт как null', () => {
    const run = (t: string, over: Record<string, unknown> = {}) => validateAiListing(
      ok({ departure_date: null, ...over }), { now: NOW, originalText: t },
    )!.departureDate;
    // реальные формулировки из выгрузки: 554 заявки на доске были без даты
    expect(run('Через 1час еду Каунас-Вильнюс, есть места')).toBe('2026-09-14');
    expect(run('В течении 1-2 часов еду Варшава-Брест, есть свободное место')).toBe('2026-09-14');
    expect(run('Через 3 дня еду Брест - Варшава')).toBe('2026-09-17');
    expect(run('Вечером 15-го сентября еду Минск Варшава')).toBe('2026-09-15');
    // регулярный рейс без даты — ближайший такой день
    expect(run('Каждый четверг возим Крокодилово — Бегемотово')).toBe('2026-09-17');
  });

  it('запасной ход не выдумывает дату из срока годности и из цен', () => {
    const run = (t: string) => validateAiListing(ok({ departure_date: null }), { now: NOW, originalText: t })!.departureDate;
    // «до» — это срок годности заявки, а не дата выезда
    expect(run('Нужно привезти игрушки. Актуально до 30 сентября, за вознаграждение')).toBeNull();
    expect(run('Нужно передать паспорт, успеть не позднее 20.09')).toBeNull();
    // цены и размеры — не даты
    expect(run('Заказы 200-600 брутто, аптека около 300 г по 1.4$ за штуку')).toBeNull();
    expect(run('Перевозка доски размером 7.0, Emirates')).toBeNull();
    // «в ближайшие дни» — слишком размыто, чтобы угадывать
    expect(run('Ищет попутчика в ближайшие дни')).toBeNull();
  });

  it('дату модели запасной ход не перебивает', () => {
    const f = validateAiListing(ok({ departure_date: '2026-09-20' }), {
      now: NOW, originalText: 'Завтра везу посылку Крокодилово — Бегемотово',
    })!;
    expect(f.departureDate).toBe('2026-09-20');
  });

  it('дикий вес и кривой контакт отбрасываются', () => {
    expect(validateAiListing(ok({ weight_kg: 5000 }), { now: NOW, originalText: TEXT })!.weightKg).toBeNull();
    expect(validateAiListing(ok({ telegram: 'не-юзернейм!!!' }), { now: NOW, originalText: TEXT })!.telegram).toBeNull();
  });

  it('короткое описание заменяет исходным текстом (без дубля контакта)', () => {
    const f = validateAiListing(ok({ description: 'ок' }), { now: NOW, originalText: TEXT });
    // исходный текст не калечим — убираем только контакт, он показан отдельной строкой
    expect(f!.description).toBe('Завтра везу посылку Крокодилово — Бегемотово, 5 кг, 100 zł');
    expect(f!.description).not.toContain('@driver77');
  });
});

describe('validateAiListing — контакты без дублей (заявка №63367269)', () => {
  it('один и тот же номер в telegram и phone остаётся одним контактом', () => {
    const f = validateAiListing(ok({ telegram: '+48579264254', phone: '+48579264254' }), { now: NOW, originalText: TEXT });
    expect(f!.phone).toBe('+48579264254');
    expect(f!.telegram).toBeNull();
  });

  it('номер, который ИИ положил в telegram, переезжает в phone', () => {
    const f = validateAiListing(ok({ telegram: '+48579264254', phone: null }), { now: NOW, originalText: TEXT });
    expect(f!.telegram).toBeNull();
    expect(f!.phone).toBe('+48579264254');
  });

  it('юзернейм, который ИИ положил в phone, переезжает в telegram', () => {
    const f = validateAiListing(ok({ telegram: null, phone: 'driver77' }), { now: NOW, originalText: TEXT });
    expect(f!.telegram).toBe('@driver77');
    expect(f!.phone).toBeNull();
  });

  it('разные контакты остаются оба', () => {
    const f = validateAiListing(ok({ telegram: '@driver77', phone: 'Vb+375256663703' }), { now: NOW, originalText: TEXT });
    expect(f!.telegram).toBe('@driver77');
    expect(f!.phone).toBe('+375256663703');
  });
});

describe('validateAiListing — описание не повторяет поля карточки', () => {
  it('убирает «шапку» с маршрутом, датой и типом', () => {
    const f = validateAiListing(ok({
      from_city: 'Варшава', to_city: 'Минск', departure_date: '2026-09-25',
      telegram: null, phone: '+48579264254',
      description: 'Водитель, 25.09.2026 Варшава-Минск. Возьму посылки, домашние переезды. Telegram, Whatsapp.',
    }), { now: NOW, originalText: TEXT });
    expect(f!.description).toBe('Возьму посылки, домашние переезды. Telegram, Whatsapp.');
  });

  it('убирает из описания номер, который показан в контактах', () => {
    const f = validateAiListing(ok({
      telegram: null, phone: '+48579264254',
      description: 'Возьму посылки и домашние переезды, звоните +48 579 264 254',
    }), { now: NOW, originalText: TEXT });
    expect(f!.description).toBe('Возьму посылки и домашние переезды, звоните');
    expect(f!.phone).toBe('+48579264254');
  });
});

describe('parseAiListings — несколько направлений из одного сообщения', () => {
  const opts = { now: NOW, originalText: 'водитель: два рейса Белосток — Минск и обратно' };

  it('массив listings → две заявки (туда и обратно), контакты чинятся', () => {
    const raw = {
      listings: [
        ok({ from_city: 'Белосток', to_city: 'Минск', departure_date: '2026-09-18', telegram: null, phone: 'Vb+375256663703', description: '18-19.9 Белосток Гродно Минск, передачи, попутчики' }),
        ok({ from_city: 'Минск', to_city: 'Белосток', departure_date: '2026-09-20', telegram: 'KgRBPL', phone: 'TG+48459568684', description: '20-21.9 Могилёв Минск Белосток, обратно' }),
      ],
    };
    const list = parseAiListings(raw, opts);
    expect(list).toHaveLength(2);
    expect(list[0]!.fromCity).toBe('Белосток');
    expect(list[0]!.toCity).toBe('Минск');
    expect(list[0]!.phone).toBe('+375256663703'); // «Vb+…» → номер
    expect(list[1]!.fromCity).toBe('Минск');
    expect(list[1]!.departureDate).toBe('2026-09-20');
    expect(list[1]!.telegram).toBe('@KgRBPL'); // юзернейм без @ → с @
    expect(list[1]!.phone).toBe('+48459568684'); // «TG+…» → номер
  });

  it('старый формат (один объект) — одна заявка', () => {
    expect(parseAiListings(ok(), opts)).toHaveLength(1);
  });

  it('пусто и мусор — пусто', () => {
    expect(parseAiListings({ listings: [] }, opts)).toEqual([]);
    expect(parseAiListings({ listings: [{ is_listing: false }] }, opts)).toEqual([]);
    expect(parseAiListings('мусор', opts)).toEqual([]);
  });

  it('больше трёх направлений — обрезаем до трёх', () => {
    const raw = { listings: [1, 2, 3, 4, 5].map(() => ok()) };
    expect(parseAiListings(raw, opts)).toHaveLength(3);
  });
});

describe('recurring — регулярное расписание из ответа ИИ', () => {
  it('знакомое расписание канонизируется', () => {
    const f = validateAiListing(ok({ recurring: 'Каждый четверг' }), { now: NOW, originalText: TEXT });
    expect(f?.recurring).toBe('каждый четверг');
  });
  it('незнакомая формулировка проходит как есть', () => {
    const f = validateAiListing(ok({ recurring: 'по чётным неделям' }), { now: NOW, originalText: TEXT });
    expect(f?.recurring).toBe('по чётным неделям');
  });
  it('мусор отбрасывается, отсутствие — null', () => {
    expect(validateAiListing(ok({ recurring: 'да' }), { now: NOW, originalText: TEXT })?.recurring).toBeNull();
    expect(validateAiListing(ok({ recurring: 'что-то не то' }), { now: NOW, originalText: TEXT })?.recurring).toBeNull();
    expect(validateAiListing(ok(), { now: NOW, originalText: TEXT })?.recurring).toBeNull();
  });
});

describe('recurring и защита от странностей ИИ', () => {
  it('одинаковые города с двух сторон маршрута — не заявка', () => {
    // «Возьму комплект колес... в Тересполе»: ИИ взял Тересполь за оба конца
    expect(validateAiListing(ok({ from_city: 'Тересполь', to_city: 'Тересполе' }), { now: NOW, originalText: TEXT })).toBeNull();
    expect(validateAiListing(ok({ from_city: 'Тересполь', to_city: 'Тересполь' }), { now: NOW, originalText: TEXT })).toBeNull();
  });
});

describe('trimDescription — обрезка по предложению, а не на полуслове', () => {
  it('короткий текст не трогает', () => {
    expect(trimDescription('Возьму посылки до 10 кг. Без предоплаты.')).toBe('Возьму посылки до 10 кг. Без предоплаты.');
  });
  it('длинный режет по последней точке', () => {
    const long = Array.from({ length: 8 }, () => 'Первое предложение достаточно длинное, чтобы всё поместилось целиком.').join(' ');
    const out = trimDescription(long);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith('.')).toBe(true);
  });
  it('без точек режет по слову и ставит многоточие', () => {
    const out = trimDescription('а'.repeat(50) + ' слово '.repeat(60));
    expect(out.length).toBeLessThanOrEqual(301);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/\s…/);
  });
});

describe('аналитическая заметка месяца', () => {
  const stat: import('../src/stats').MonthStat = {
    month: '2026-09', offers: 30, requests: 12, total: 42, cities: 18, directions: 25,
    topDirections: [{ pair: 'Варшава → Минск', from: 'Варшава', to: 'Минск', count: 11 }],
    fromChats: 35, fromSite: 7, priced: 20, free: 2,
    prices: [{ currency: 'EUR', count: 8, avg: 25, min: 10, max: 40 }],
    updatedAt: '2026-10-01T00:00:00Z',
  };

  it('monthSummaryFacts собирает цифры без воды', () => {
    const facts = monthSummaryFacts(stat, { ...stat, month: '2026-08', total: 30, directions: 20 });
    expect(facts).toContain('Месяц: 2026-09');
    expect(facts).toContain('Всего объявлений: 42');
    expect(facts).toContain('Варшава → Минск — 11');
    expect(facts).toContain('прошлый месяц (2026-08)');
  });

  it('cleanMonthSummary выкидывает markdown и мусор, короткий текст бракует', () => {
    expect(cleanMonthSummary('**Жирный** месяц\n\n\n# Заголовок\nи текст ' + 'а'.repeat(200))).toContain('Жирный месяц');
    expect(cleanMonthSummary('**Жирный** месяц\n\n\n# Заголовок\nи текст ' + 'а'.repeat(200))).not.toContain('**');
    expect(cleanMonthSummary('коротко')).toBeNull();
  });

  it('aiMonthSummary зовёт DeepSeek и возвращает чистый текст', async () => {
    const calls: Array<{ body: string }> = [];
    const fetchMock = async (_url: unknown, init: { body: string }) => {
      calls.push({ body: init.body });
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Сентябрь на доске выдался живым: 42 объявления и 25 направлений. ' + 'о'.repeat(180) } },
      ] }), { status: 200 });
    };
    vi.stubGlobal('fetch', fetchMock);
    try {
      const env = { AI_API_KEY: 'k', AI_BASE_URL: 'http://ai.test', KV: kvStub() } as unknown as Env;
      const out = await aiMonthSummary(env, stat, null);
      expect(out).not.toBeNull();
      expect(out!.length).toBeGreaterThan(100);
      expect(calls[0]!.body).toContain('42'); // цифры месяца ушли в промпт
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('без ключа ИИ заметку не пишет — страница возьмёт шаблон', async () => {
    expect(await aiMonthSummary({} as Env, stat)).toBeNull();
  });
});

/** KV-заглушка: дневная квота ИИ пишет и читает счётчик. */
function kvStub() {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => { store.set(k, v); },
  };
}
