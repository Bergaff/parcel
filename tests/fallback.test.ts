/**
 * fallback.js — скрипт-заглушка для рекламной сети (pop-utka.app/fallback.js).
 * Сеть грузит его в свой iframe, когда нет рекламных материалов, — слот
 * занимает «свой баннер» с приглашением в бота. Проверяем, что файл на месте,
 * это валидный JS и он безопасен для страниц сайта.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('../public/fallback.js', import.meta.url), 'utf8');

describe('fallback.js для рекламной сети', () => {
  it('файл существует и это валидный JS', () => {
    expect(src.trim().length).toBeGreaterThan(100);
    // парсим без исполнения: синтаксическая ошибка упадёт здесь
    expect(() => new Function(src)).not.toThrow();
  });

  it('работает только в рекламном iframe — страницы сайта не трогает', () => {
    // главный предохранитель: вне iframe (открыли напрямую) — выходим
    expect(src).toContain('window.top === window.self');
  });

  it('ведёт на нашего бота и не делает внешних запросов', () => {
    expect(src).toContain('https://t.me/parcel_transfer_bot');
    // никаких других сетевых адресов: единственный URL в файле — наш бот
    expect(src.match(/https?:\/\/[^"')\s]+/g) ?? []).toEqual(['https://t.me/parcel_transfer_bot']);
  });

  it('баннер открывается в новой вкладке с nofollow', () => {
    expect(src).toContain('target="_blank"');
    expect(src).toContain('rel="noopener nofollow"');
  });
});
