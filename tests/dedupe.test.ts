import { describe, expect, it } from 'vitest';
import {
  compareForDuplicate,
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
