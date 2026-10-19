/**
 * География маршрутов: километраж, время в пути, пункты пропуска.
 *
 * Главное, за чем следим: числа симметричны (Минск → Москва = Москва → Минск),
 * неизвестный город даёт null, а не выдуманное расстояние, и блок не пугает
 * границей там, где её фактически нет (внутри Шенгена).
 */
import { describe, expect, it } from 'vitest';

import {
  CITY_GEO, CROSSINGS, crossingsFor, driveHours, fmtHours, routeKm, straightKm, tripInfo,
} from '../src/geo';

describe('routeKm — расстояние по дороге', () => {
  it('курируемые направления: точное число, одинаково в обе стороны', () => {
    expect(routeKm('Минск', 'Москва')).toBe(720);
    expect(routeKm('Москва', 'Минск')).toBe(720);
    expect(routeKm('Минск', 'Брест')).toBe(345);
    expect(routeKm('Варшава', 'Минск')).toBe(590);
    expect(routeKm('Вроцлав', 'Минск')).toBe(1150);
    expect(routeKm('Москва', 'Забайкальск')).toBe(5600);
  });

  it('один город — ноль, а не оценка', () => {
    expect(routeKm('Минск', 'Минск')).toBe(0);
    expect(routeKm('минск', 'МИНСК')).toBe(0);
  });

  it('неизвестный город — null: выдуманного расстояния на странице не будет', () => {
    expect(routeKm('Минск', 'Нету-Такого')).toBeNull();
    expect(routeKm('Пупкино', 'Залесье')).toBeNull();
  });

  it('нет курируемого числа — оценка по координатам, округлённая до 10 км', () => {
    const km = routeKm('Минск', 'Рига');
    expect(km).not.toBeNull();
    expect(km! % 10).toBe(0);
    // Минск — Рига по дороге ~470-520 км: оценка обязана попасть в этот район
    expect(km!).toBeGreaterThan(400);
    expect(km!).toBeLessThan(600);
  });

  it('по прямой всегда меньше, чем по дороге', () => {
    const a = CITY_GEO['Минск']!;
    const b = CITY_GEO['Варшава']!;
    const straight = straightKm(a, b);
    expect(straight).toBeGreaterThan(400);
    expect(straight).toBeLessThan(590);
  });

  it('все курируемые ключи отсортированы и без дублей (иначе запись мёртвая)', () => {
    const keys = Object.keys(CROSSINGS).concat([]);
    for (const k of keys) {
      const [a, b] = k.split('|');
      expect([a, b].sort().join('|')).toBe(k);
    }
  });
});

describe('driveHours — время за рулём', () => {
  it('округляется до получаса, минимум полчаса', () => {
    expect(driveHours(720)).toBe(9.5);
    expect(driveHours(590)).toBe(8);
    expect(driveHours(345)).toBe(5);
    expect(driveHours(215)).toBe(3);
    expect(driveHours(10)).toBe(0.5);
    expect(driveHours(0)).toBe(0);
  });

  it('русская дробная часть в тексте', () => {
    expect(fmtHours(9.5)).toBe('9,5');
    expect(fmtHours(8)).toBe('8');
    expect(fmtHours(0.5)).toBe('0,5');
  });
});

describe('пункты пропуска', () => {
  it('Беларусь — Польша: названы пары, включая Кузницу (запрос «кузницу»)', () => {
    const list = crossingsFor('Минск', 'Варшава');
    expect(list.length).toBeGreaterThan(0);
    expect(list.map(([a, b]) => `${a} — ${b}`)).toContain('Брузги — Кузница');
    expect(list.map(([a, b]) => `${a} — ${b}`)).toContain('Брест — Тересполь');
    // направление не важно
    expect(crossingsFor('Брест', 'Варшава')).toEqual(list);
  });

  it('внутри страны переходов нет', () => {
    expect(crossingsFor('Минск', 'Брест')).toEqual([]);
    expect(crossingsFor('Варшава', 'Краков')).toEqual([]);
    expect(crossingsFor('Киев', 'Львов')).toEqual([]);
  });

  it('внутри Шенгена границы на дорогах нет', () => {
    expect(tripInfo('Варшава', 'Берлин')!.border).toBeNull();
    expect(tripInfo('Прага', 'Вена')!.border).toBeNull();
    expect(crossingsFor('Варшава', 'Берлин')).toEqual([]);
  });

  it('несуществующая граница (Беларусь — Россия) названа, но без списка переходов', () => {
    const t = tripInfo('Минск', 'Москва')!;
    expect(t.border).toBe('Беларусь — Россия');
    expect(t.crossings).toEqual([]);
  });

  it('Беларусь — Литва и Польша — Украина: списки на месте', () => {
    expect(crossingsFor('Минск', 'Вильнюс').map(([a]) => a)).toContain('Каменный Лог');
    expect(crossingsFor('Варшава', 'Львов').map(([, ua]) => ua)).toContain('Ягодин');
  });

  it('город неизвестен — tripInfo null', () => {
    expect(tripInfo('Минск', 'Нету')).toBeNull();
    expect(tripInfo('Минск', 'Минск')).toBeNull();
  });
});
