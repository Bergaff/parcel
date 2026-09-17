/**
 * Разбор цены из объявления: числа, диапазоны и валюты.
 * От этого зависит «средняя цена» в итогах месяца — смешать евро с рублями
 * нельзя, а «договорная» не должна попадать в среднее нулём.
 */
import { describe, expect, it } from 'vitest';
import { CURRENCY_LABEL, fmtPrice, parsePrice } from '../src/price';

const money = (raw: string | null | undefined) => parsePrice(raw);

describe('валюта', () => {
  it('основные обозначения', () => {
    expect(money('30 BYN')?.currency).toBe('BYN');
    expect(money('20 евро')?.currency).toBe('EUR');
    expect(money('€15')?.currency).toBe('EUR');
    expect(money('50 zł')?.currency).toBe('PLN');
    expect(money('100 zl')?.currency).toBe('PLN');
    expect(money('40$')?.currency).toBe('USD');
    expect(money('$40')?.currency).toBe('USD');
    expect(money('500 грн')?.currency).toBe('UAH');
    expect(money('2000 рублей')?.currency).toBe('RUB');
    expect(money('60 ₽')?.currency).toBe('RUB');
    expect(money('25 фунтов')?.currency).toBe('GBP');
    expect(money('300 CZK')?.currency).toBe('CZK');
  });

  it('«бел руб» — это BYN, а не RUB', () => {
    expect(money('60 бел руб')?.currency).toBe('BYN');
    expect(money('60 бел. рублей')?.currency).toBe('BYN');
    expect(money('60 бр')?.currency).toBe('BYN');
    expect(money('1000 рублей РБ')?.currency).toBe('BYN');
  });

  it('без валюты — currency null, но число остаётся', () => {
    const p = money('50');
    expect(p?.currency).toBeNull();
    expect(p?.amount).toBe(50);
  });
});

describe('числа и диапазоны', () => {
  it('одно число', () => {
    expect(money('30 BYN')).toMatchObject({ amount: 30, min: 30, max: 30, free: false });
  });

  it('диапазон через дефис, тире и «до»', () => {
    expect(money('20-30 EUR')).toMatchObject({ amount: 25, min: 20, max: 30, currency: 'EUR' });
    expect(money('20 – 30 EUR')).toMatchObject({ amount: 25, currency: 'EUR' });
    expect(money('от 20 до 30 евро')).toMatchObject({ amount: 25, currency: 'EUR' });
    expect(money('20/30 BYN')).toMatchObject({ min: 20, max: 30 });
  });

  it('десятые через запятую и точку', () => {
    expect(money('27,5 евро')?.amount).toBe(27.5);
    expect(money('27.5 евро')?.amount).toBe(27.5);
  });

  it('пробел как разделитель разрядов', () => {
    expect(money('1 000 рублей')?.amount).toBe(1000);
    expect(money('2 500 - 3 000 BYN')).toMatchObject({ min: 2500, max: 3000 });
  });

  it('числа после цены в расчёт не берём (вес, дни)', () => {
    expect(money('30 евро, возьму до 10 кг')).toMatchObject({ amount: 30, currency: 'EUR' });
    expect(money('25 EUR, выезд 20.09')).toMatchObject({ amount: 25, currency: 'EUR' });
  });
});

describe('без цены', () => {
  it('договорная — null', () => {
    expect(money('договорная')).toBeNull();
    expect(money('цена по договорённости')).toBeNull();
    expect(money('уточняйте')).toBeNull();
    expect(money('')).toBeNull();
    expect(money(null)).toBeNull();
    expect(money(undefined)).toBeNull();
  });

  it('договорная, но с числом — число важнее', () => {
    expect(money('договорная, от 20 евро')).toMatchObject({ amount: 20, currency: 'EUR' });
  });

  it('бесплатно', () => {
    expect(money('бесплатно')).toMatchObject({ free: true, amount: 0 });
    expect(money('даром')).toMatchObject({ free: true });
    expect(money('возьму за спасибо')).toMatchObject({ free: true });
  });
});

describe('вывод', () => {
  it('короткая запись', () => {
    expect(fmtPrice(parsePrice('30 EUR')!)).toBe('30 €');
    expect(fmtPrice(parsePrice('20-30 zł')!)).toBe('20–30 zł');
    expect(fmtPrice(parsePrice('бесплатно')!)).toBe('бесплатно');
    expect(fmtPrice(parsePrice('50')!)).toBe('50 ед.');
  });

  it('у валют есть человеческие подписи', () => {
    expect(CURRENCY_LABEL.EUR).toBe('евро');
    expect(CURRENCY_LABEL.BYN).toBe('белорусских рублей');
    expect(CURRENCY_LABEL.none).toBe('валюта не указана');
  });
});
