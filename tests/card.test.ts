import { describe, expect, it } from 'vitest';
import { formatListing } from '../src/telegram';
import type { Listing } from '../src/types';

/** Заявка из базы: минимальный набор полей для карточки. */
function listing(fields: Partial<Listing>): Listing {
  return {
    id: '63367269-0000-0000-0000-000000000000',
    type: 'offer',
    fromCity: 'Варшава',
    toCity: 'Минск',
    departureDate: '2026-09-25',
    weightKg: null,
    price: null,
    description: 'Возьму посылки, домашние переезды. Telegram, Whatsapp.',
    phone: '+48579264254',
    telegram: null,
    status: 'pending',
    source: 'parser',
    sourceChat: 'Переслано от sergei',
    sourceChatId: 'fwd:111',
    sourceMessageId: null,
    createdAt: '2026-09-15T10:00:00.000Z',
    publishedAt: null,
    views: 0,
    ...fields,
  } as Listing;
}

describe('карточка модератора — без дублей информации', () => {
  it('один и тот же номер в двух полях печатается одной строкой «Контакты:»', () => {
    const card = formatListing(listing({ telegram: '+48579264254', phone: '+48579264254' }));
    expect(card.match(/Контакты:/g)).toHaveLength(1);
    expect(card).toContain('Контакты: +48579264254');
  });

  it('два разных контакта — одна строка через запятую, telegram первым', () => {
    const card = formatListing(listing({ telegram: '@driver77', phone: '+48579264254' }));
    expect(card.match(/Контакты:/g)).toHaveLength(1);
    expect(card).toContain('Контакты: @driver77, +48579264254');
  });

  it('номер, записанный в поле telegram, показывается как номер', () => {
    const card = formatListing(listing({ telegram: '+48579264254', phone: null }));
    expect(card).toContain('Контакты: +48579264254');
    expect(card.match(/Контакты:/g)).toHaveLength(1);
  });

  it('без контакта строки «Контакты:» нет', () => {
    expect(formatListing(listing({ telegram: null, phone: null }))).not.toContain('Контакты:');
  });

  it('штамп типа заявки соответствует содержимому', () => {
    expect(formatListing(listing({ type: 'offer' }))).toContain('#63367269 Водитель везёт');
    expect(formatListing(listing({ type: 'request' }))).toContain('#63367269 Нужно передать');
  });

  it('источник пересылки печатается без двойных пробелов', () => {
    const card = formatListing(listing({ sourceChat: 'Переслано от sergei' }));
    expect(card).toContain('Источник: ИИ-разбор, Переслано от sergei');
    expect(card).not.toMatch(/Переслано от\s\s+/);
  });
});
