import { describe, expect, it } from 'vitest';
import { accusativeCity, fromCity, genitiveCity, inCountry, intoCity, locativeCountry } from '../src/ru';

describe('склонение городов', () => {
  it('мужской род на согласный: родительный -а, винительный без изменений', () => {
    expect(genitiveCity('Минск')).toBe('Минска');
    expect(genitiveCity('Киев')).toBe('Киева');
    expect(genitiveCity('Брест')).toBe('Бреста');
    expect(genitiveCity('Гомель')).toBe('Гомеля');
    expect(genitiveCity('Вильнюс')).toBe('Вильнюса');
    expect(genitiveCity('Париж')).toBe('Парижа');
    expect(accusativeCity('Минск')).toBe('Минск');
  });

  it('женский род на -а', () => {
    expect(genitiveCity('Варшава')).toBe('Варшавы');
    expect(genitiveCity('Прага')).toBe('Праги');
    expect(genitiveCity('Одесса')).toBe('Одессы');
    expect(genitiveCity('Москва')).toBe('Москвы');
    expect(accusativeCity('Варшава')).toBe('Варшаву');
    expect(accusativeCity('Прага')).toBe('Прагу');
    expect(accusativeCity('Москва')).toBe('Москву');
  });

  it('несклоняемые и множественное число', () => {
    expect(genitiveCity('Гродно')).toBe('Гродно');
    expect(genitiveCity('Катовице')).toBe('Катовице');
    expect(genitiveCity('Черновцы')).toBe('Черновцов');
    expect(genitiveCity('Барановичи')).toBe('Барановичей');
    expect(accusativeCity('Гродно')).toBe('Гродно');
  });

  it('мягкий знак: род женский и мужской различаются', () => {
    expect(genitiveCity('Кёльн')).toBe('Кёльна');
    expect(genitiveCity('Казань')).toBe('Казани');
    expect(genitiveCity('Познань')).toBe('Познани');
    expect(genitiveCity('Гданьск')).toBe('Гданьска');
  });

  it('предлоги «в» / «во»', () => {
    expect(intoCity('Варшава')).toBe('в Варшаву');
    expect(intoCity('Львов')).toBe('во Львов');
    expect(intoCity('Вроцлав')).toBe('во Вроцлав');
    expect(intoCity('Владивосток')).toBe('во Владивосток');
    expect(intoCity('Минск')).toBe('в Минск');
    expect(fromCity('Варшава')).toBe('из Варшавы');
    expect(fromCity('Гродно')).toBe('из Гродно');
  });

  it('пустое название не ломает', () => {
    expect(genitiveCity('')).toBe('');
    expect(intoCity('')).toBe('в ');
  });
});

describe('склонение стран', () => {
  it('предложный падеж', () => {
    expect(locativeCountry('Польша')).toBe('Польше');
    expect(locativeCountry('Украина')).toBe('Украине');
    expect(locativeCountry('Беларусь')).toBe('Беларуси');
    expect(locativeCountry('Литва')).toBe('Литве');
    expect(locativeCountry('Германия')).toBe('Германии');
    expect(locativeCountry('Чехия')).toBe('Чехии');
    expect(locativeCountry('Россия')).toBe('России');
    expect(locativeCountry('Нидерланды')).toBe('Нидерландах');
    expect(locativeCountry('Казахстан')).toBe('Казахстане');
    expect(locativeCountry('Израиль')).toBe('Израиле');
  });

  it('с предлогом', () => {
    expect(inCountry('Польша')).toBe('в Польше');
    expect(inCountry('Франция')).toBe('во Франции');
    expect(inCountry('Беларусь')).toBe('в Беларуси');
  });
});
