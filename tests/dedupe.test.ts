import { describe, expect, it } from 'vitest';
import {
  compareForDuplicate,
  groupDuplicates,
  keepRank,
  dateDiffDays,
  differentContacts,
  pickDuplicate,
  sameContact,
  samePhone,
  sameRoute,
  sameUsername,
  textSimilarity,
  whoLabel,
  type DedupeSubject,
} from '../src/dedupe';

/** Черновик заявки: то, что пришло из сообщения, до записи в базу. */
function input(fields: Partial<DedupeSubject> = {}): DedupeSubject {
  return {
    type: 'offer',
    fromCity: 'Варшава',
    toCity: 'Минск',
    departureDate: '2026-09-20',
    description: 'Еду 20 сентября из Варшавы в Минск, возьму посылки до 20 кг, документы.',
    telegram: '@driver',
    phone: null,
    ...fields,
  };
}

/** Заявка уже в базе. */
function existing(fields: Partial<DedupeSubject> = {}): DedupeSubject {
  return {
    id: 'existing-1',
    status: 'published',
    sourceChat: 'Чат попутчиков',
    sourceChatId: '-1001234567890',
    ...input(fields),
    ...fields,
  } as DedupeSubject;
}

describe('один и тот же человек пишет каждый день', () => {
  it('тот же контакт, маршрут и дата — дубль, даже если текст другой', () => {
    const v = compareForDuplicate(
      input({ description: '20.09 Варшава-Минск, готов быть, возьму передачу' }),
      existing({ description: 'Еду 20 сентября из Варшавы в Минск, возьму посылки до 20 кг, документы.' })
    );
    expect(v?.kind).toBe('duplicate');
    expect(v?.why).toContain('@driver');
  });

  it('дата сдвинулась на день — тоже дубль (человек уточнил)', () => {
    expect(compareForDuplicate(input({ departureDate: '2026-09-21' }), existing())?.kind).toBe('duplicate');
  });

  it('другой день — другой рейс, не дубль', () => {
    expect(compareForDuplicate(input({ departureDate: '2026-09-25' }), existing())).toBeNull();
  });

  it('повтор каждый день пять раз подряд — каждый раз дубль одной и той же заявки', () => {
    const first = existing();
    for (const day of ['2026-09-20', '2026-09-20', '2026-09-21', '2026-09-20']) {
      const v = compareForDuplicate(input({ departureDate: day, description: `актуально на ${day}, еду, возьму посылку` }), first);
      expect(v?.kind).toBe('duplicate');
    }
  });
});

describe('пересылки без контакта (автор скрыл профиль)', () => {
  it('тот же текст переслали ещё раз — дубль', () => {
    const text = '20 сентября еду Варшава — Минск, возьму посылку до 10 кг, пишите в личку';
    const v = compareForDuplicate(
      input({ telegram: null, description: text, sourceChat: 'Пересланное сообщение', sourceChatId: 'fwd:111' }),
      existing({ telegram: null, description: text, sourceChat: 'Переслано от sergei', sourceChatId: 'fwd:111' })
    );
    expect(v?.kind).toBe('duplicate');
  });

  it('тот же автор пересылки, текст переписан — дубль по имени автора', () => {
    const v = compareForDuplicate(
      input({ telegram: null, description: 'актуально! 20.09 Варшава-Минск, возьму посылку', sourceChat: 'Переслано от sergei' }),
      existing({ telegram: null, description: 'Еду 20 сентября Варшава Минск, есть место для посылок', sourceChat: 'Переслано от sergei' })
    );
    expect(v?.kind).toBe('duplicate');
    expect(v?.why).toContain('sergei');
  });

  it('тот же пересыльщик, текст похож частично — предупреждение, а не отказ', () => {
    const v = compareForDuplicate(
      input({
        telegram: null, phone: null, sourceChatId: 'fwd:111', sourceChat: 'Пересланное сообщение',
        description: 'Ищу кто передаст посылку Варшава Минск 20 сентября, документы и ключи',
      }),
      existing({
        telegram: null, phone: null, sourceChatId: 'fwd:111', sourceChat: 'Пересланное сообщение',
        description: 'Еду 20 сентября Варшава Минск, возьму посылку, есть место в багажнике, могу забрать из центра',
      })
    );
    expect(v?.kind).toBe('similar');
  });
});

describe('разные люди на одном маршруте — не дубль', () => {
  it('контакты разные, текст разный — создаём обе заявки', () => {
    const v = compareForDuplicate(
      input({ telegram: '@other_driver', description: 'Еду в четверг, возьму одну небольшую коробку' }),
      existing({ telegram: '@driver', description: 'Каждый день езжу по этому маршруту, место есть, пишите' })
    );
    expect(v).toBeNull();
  });

  it('тот же маршрут и дата при разных телефонах — не дубль', () => {
    const v = compareForDuplicate(
      input({ telegram: null, phone: '+48579264254', description: 'Возьму документы, выезд утром' }),
      existing({ telegram: null, phone: '+375291234567', description: 'Еду вечером, есть место для коробки' })
    );
    expect(v).toBeNull();
  });

  it('текст похож, контакты разные, источник один — молчим: это разные люди', () => {
    const v = compareForDuplicate(
      input({ telegram: '@petr_minsk', sourceChatId: 'fwd:777', description: 'Еду 20 сентября Варшава Минск, есть место для посылок, пишите' }),
      existing({ telegram: '@driver', sourceChatId: 'fwd:777', description: 'Еду 20 сентября из Варшавы в Минск, возьму посылки до 20 кг, документы.' })
    );
    expect(v).toBeNull();
  });

  it('текст один в один, но контакты разные — не дубль, а предупреждение', () => {
    const text = '20 сентября еду Варшава — Минск, возьму посылку до 10 кг, пишите в личку';
    const v = compareForDuplicate(
      input({ telegram: '@copycat', description: text }),
      existing({ telegram: '@driver', description: text })
    );
    expect(v?.kind).toBe('similar');
    expect(v?.why).toContain('контакт другой');
  });

  it('другой тип заявки (водитель против «нужно передать») — не дубль', () => {
    expect(compareForDuplicate(input({ type: 'request' }), existing({ type: 'offer' }))).toBeNull();
  });

  it('другой маршрут — не дубль, даже от того же человека', () => {
    expect(compareForDuplicate(input({ toCity: 'Брест' }), existing())).toBeNull();
    expect(compareForDuplicate(input({ fromCity: 'Краков' }), existing())).toBeNull();
  });

  it('встречный маршрут — не дубль', () => {
    expect(compareForDuplicate(input({ fromCity: 'Минск', toCity: 'Варшава' }), existing())).toBeNull();
  });

  it('differentContacts видит, что люди разные', () => {
    expect(differentContacts(input({ telegram: '@driver_one' }), existing({ telegram: '@driver_two' }))).toBe(true);
    expect(differentContacts(input({ telegram: null }), existing({ telegram: '@driver_two' }))).toBe(false);
    expect(differentContacts(input({ telegram: '@driver_one' }), existing({ telegram: '@driver_one' }))).toBe(false);
  });
});

describe('сравнение городов, дат и контактов', () => {
  it('города сравниваются после нормализации', () => {
    expect(sameRoute(input({ fromCity: 'из варшаве' }), existing())).toBe(true);
    expect(sameRoute(input({ fromCity: 'Варшаве' }), existing({ fromCity: 'Варшава' }))).toBe(true);
    expect(sameRoute(input({ fromCity: '' }), existing())).toBe(false);
  });

  it('дата: разница в днях и null, если даты нет', () => {
    expect(dateDiffDays('2026-09-20', '2026-09-21')).toBe(1);
    expect(dateDiffDays('2026-09-20', '2026-09-20')).toBe(0);
    expect(dateDiffDays('2026-09-20', null)).toBeNull();
    expect(dateDiffDays(null, null)).toBeNull();
  });

  it('телефон одинаков в разных написаниях', () => {
    expect(samePhone('+375 29 123-45-67', '375291234567')).toBe(true);
    expect(samePhone('80291234567', '+375291234567')).toBe(true);
    expect(samePhone('+48579264254', '+375291234567')).toBe(false);
    expect(samePhone('123', '+375291234567')).toBe(false);
  });

  it('юзернейм без @ и в другом регистре — тот же', () => {
    expect(sameUsername('Driver', '@driver')).toBe(true);
    expect(sameUsername('@driver', 'driver')).toBe(true);
    expect(sameUsername(null, '@driver')).toBe(false);
  });

  it('контакт в «чужом» поле тоже находится', () => {
    // номер попал в поле telegram — сравнение не должно из-за этого разойтись
    expect(sameContact(input({ telegram: '+375291234567', phone: null }), existing({ telegram: null, phone: '375291234567' }))).toBe(true);
  });

  it('whoLabel: контакт, иначе источник, иначе «без контакта»', () => {
    expect(whoLabel(input({ telegram: '@driver' }))).toBe('@driver');
    expect(whoLabel(input({ telegram: null, sourceChat: 'Переслано от sergei' }))).toBe('Переслано от sergei');
    expect(whoLabel(input({ telegram: null, sourceChat: null }))).toBe('без контакта');
  });
});

describe('похожесть текста', () => {
  it('тот же текст — 1, совсем другой — близко к 0', () => {
    expect(textSimilarity('Еду в Минск', 'Еду в Минск')).toBe(1);
    expect(textSimilarity('Еду в Минск возьму посылку', 'Продам гараж в Гродно')).toBeLessThan(0.2);
  });

  it('падежи, переносы и знаки препинания похожесть не ломают', () => {
    const sim = textSimilarity(
      'Еду 20 сентября из Варшавы в Минск, возьму посылки',
      'еду 20.09 варшава-минск возьму посылку'
    );
    expect(sim).toBeGreaterThan(0.6);
  });

  it('без текста похожести нет', () => {
    expect(textSimilarity('', 'Еду в Минск')).toBe(0);
    expect(textSimilarity(null, null)).toBe(0);
  });
});

describe('pickDuplicate: кого выбрать из нескольких кандидатов', () => {
  it('сначала уверенные дубликаты, потом «похожие» — независимо от порядка', () => {
    const fresh = input({
      telegram: '@driver',
      description: 'Еду 20 сентября Варшава Минск возьму посылку до 20 кг',
    });
    const similar = existing({
      id: 'similar-one', telegram: null, phone: null, departureDate: '2026-09-21',
      description: 'Еду 21 сентября Варшава Минск могу взять посылку документы вещи',
    });
    const duplicate = existing({
      id: 'duplicate-one', telegram: '@driver',
      description: 'Продам велосипед, торг уместен, самовывоз',
    });
    expect(compareForDuplicate(fresh, similar)?.kind).toBe('similar');
    expect(compareForDuplicate(fresh, duplicate)?.kind).toBe('duplicate');

    const hit = pickDuplicate([similar, duplicate], fresh);
    expect(hit?.listing.id).toBe('duplicate-one');
    expect(hit?.kind).toBe('duplicate');
  });

  it('опубликованная заявка важнее той, что на модерации', () => {
    const hit = pickDuplicate(
      [
        existing({ id: 'pending-one', status: 'pending', telegram: '@driver' }),
        existing({ id: 'published-one', status: 'published', telegram: '@driver' }),
      ],
      input()
    );
    expect(hit?.listing.id).toBe('published-one');
  });

  it('саму себя дублем не считает', () => {
    const me = existing({ id: 'me' });
    expect(pickDuplicate([me], { ...input(), id: 'me' })).toBeNull();
  });

  it('нет кандидатов — нет и дубля', () => {
    expect(pickDuplicate([], input())).toBeNull();
    expect(pickDuplicate([existing({ toCity: 'Брест' })], input())).toBeNull();
  });
});

describe('groupDuplicates: разбор завалов, которые уже на доске', () => {
  const day = (n: number): string => `2026-09-${String(20 + n).padStart(2, '0')}`;

  it('пять одинаковых заявок одного человека — одна группа, четыре копии', () => {
    const listings = [0, 1, 2, 3, 4].map((n) => existing({
      id: `copy-${n}`,
      departureDate: '2026-09-20',
      telegram: '@driver',
      description: `Еду 20 сентября из Варшавы в Минск, возьму посылки (писал ${day(n)})`,
      createdAt: `2026-09-1${n}T10:00:00.000Z`,
      publishedAt: `2026-09-1${n}T10:00:00.000Z`,
    }));
    const groups = groupDuplicates(listings);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.duplicates).toHaveLength(4);
    expect(groups[0]!.keep.id).toMatch(/^copy-/);
    expect(new Set([groups[0]!.keep.id, ...groups[0]!.duplicates.map((d) => d.id)]).size).toBe(5);
  });

  it('оставляет ту, что на доске, а не в очереди модерации', () => {
    const groups = groupDuplicates([
      existing({ id: 'pending-one', status: 'pending', telegram: '@driver', publishedAt: null, createdAt: '2026-09-17T10:00:00.000Z' }),
      existing({ id: 'published-one', status: 'published', telegram: '@driver', createdAt: '2026-09-16T10:00:00.000Z' }),
    ]);
    expect(groups[0]!.keep.id).toBe('published-one');
    expect(groups[0]!.duplicates.map((d) => d.id)).toEqual(['pending-one']);
  });

  it('оставляет заявку с контактом, даже если копия свежее', () => {
    const groups = groupDuplicates([
      existing({ id: 'fresh-no-contact', telegram: null, phone: null, status: 'published', createdAt: '2026-09-18T10:00:00.000Z', publishedAt: '2026-09-18T10:00:00.000Z' }),
      existing({ id: 'old-with-contact', telegram: '@driver', status: 'published', createdAt: '2026-09-16T10:00:00.000Z', publishedAt: '2026-09-16T10:00:00.000Z' }),
    ]);
    expect(groups[0]!.keep.id).toBe('old-with-contact');
  });

  it('разных людей в одну группу не сваливает', () => {
    const groups = groupDuplicates([
      existing({ id: 'one', telegram: '@driver_one', description: 'Еду, возьму посылку, выезд утром' }),
      existing({ id: 'two', telegram: '@driver_two', description: 'Еду, возьму посылку, выезд утром' }),
      existing({ id: 'three', telegram: '@driver_three', description: 'Другой текст про документы и ключи' }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it('«похожие» заявки не группируются — решает модератор', () => {
    const groups = groupDuplicates([
      existing({ id: 'a', telegram: null, phone: null, description: 'Ищу кто передаст посылку Варшава Минск, документы и ключи' }),
      existing({ id: 'b', telegram: null, phone: null, description: 'Еду Варшава Минск, возьму посылку, есть место в багажнике, могу забрать из центра' }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it('другие даты — разные рейсы, группы нет', () => {
    const groups = groupDuplicates([
      existing({ id: 'a', telegram: '@driver', departureDate: '2026-09-20' }),
      existing({ id: 'b', telegram: '@driver', departureDate: '2026-09-27' }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it('несколько групп сортируются по числу копий', () => {
    const groups = groupDuplicates([
      existing({ id: 'big-1', telegram: '@big', fromCity: 'Варшава', toCity: 'Минск' }),
      existing({ id: 'big-2', telegram: '@big', fromCity: 'Варшава', toCity: 'Минск' }),
      existing({ id: 'big-3', telegram: '@big', fromCity: 'Варшава', toCity: 'Минск' }),
      existing({ id: 'small-1', telegram: '@small', fromCity: 'Краков', toCity: 'Киев' }),
      existing({ id: 'small-2', telegram: '@small', fromCity: 'Краков', toCity: 'Киев' }),
      existing({ id: 'alone', telegram: '@lonely', fromCity: 'Берлин', toCity: 'Минск' }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.duplicates).toHaveLength(2);
    expect(groups[0]!.keep.telegram).toBe('@big');
    expect(groups[1]!.duplicates).toHaveLength(1);
    expect(groups[1]!.keep.telegram).toBe('@small');
  });

  it('пусто или одна заявка — групп нет', () => {
    expect(groupDuplicates([])).toHaveLength(0);
    expect(groupDuplicates([existing()])).toHaveLength(0);
  });

  it('keepRank: на доске лучше очереди, с контактом лучше без', () => {
    expect(keepRank(existing({ status: 'published', telegram: '@driver' }))[0]).toBe(0);
    expect(keepRank(existing({ status: 'pending', telegram: '@driver' }))[0]).toBe(1);
    expect(keepRank(existing({ status: 'expired', telegram: '@driver' }))[0]).toBe(2);
    expect(keepRank(existing({ telegram: null, phone: null }))[1]).toBe(1);
    expect(keepRank(existing({ telegram: '@driver' }))[1]).toBe(0);
  });
});

describe('регулярные рейсы — дубликаты по расписанию', () => {
  it('тот же человек, тот же маршрут, оба регулярные — дубль даже с разной датой', () => {
    // дата существующей прокатилась cron'ом, у новой пересылки — своя
    const v = compareForDuplicate(
      input({ departureDate: '2026-09-24', recurring: 'каждый четверг' }),
      existing({ departureDate: '2026-09-17', recurring: 'каждый четверг' })
    );
    expect(v?.kind).toBe('duplicate');
    expect(v?.why).toContain('регулярные');
  });

  it('разовые рейсы с далёкими датами — по-прежнему не дубль', () => {
    expect(
      compareForDuplicate(input({ departureDate: '2026-09-24' }), existing({ departureDate: '2026-09-17' }))
    ).toBeNull();
  });

  it('регулярный и разовый не склеиваются', () => {
    // дата далеко: у регулярного она катится cron'ом, у разового — своя.
    // Это два разных рейса, дубликатом не считаем.
    expect(
      compareForDuplicate(
        input({ departureDate: '2026-09-24', recurring: 'каждый четверг' }),
        existing({ departureDate: '2026-09-30' })
      )
    ).toBeNull();
  });
});
