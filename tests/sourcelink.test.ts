import { describe, expect, it } from 'vitest';
import { listingSourceLink } from '../src/telegram';

describe('listingSourceLink', () => {
  it('супергруппа/канал: ссылка на конкретное сообщение', () => {
    expect(listingSourceLink('-100999', 77)).toBe('https://t.me/c/999/77');
    expect(listingSourceLink('-1001234567890', 12345)).toBe('https://t.me/c/1234567890/12345');
  });

  it('без id сообщения: ссылка на чат целиком', () => {
    expect(listingSourceLink('-100999', null)).toBe('https://t.me/c/999');
  });

  it('пересылка от человека и обычная группа: ссылки нет', () => {
    expect(listingSourceLink('fwd:123456', 601)).toBeNull();
    expect(listingSourceLink('-123456', 5)).toBeNull(); // обычная группа без -100
    expect(listingSourceLink('311234567', 601)).toBeNull(); // личный чат
  });

  it('пустые значения', () => {
    expect(listingSourceLink(null, null)).toBeNull();
    expect(listingSourceLink(undefined, 1)).toBeNull();
  });
});
