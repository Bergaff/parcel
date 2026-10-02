/**
 * Медиакит (/mediakit): страница статистики для рекламных бирж — вход по
 * логину/паролю, cookie-сессия и агрегатные цифры без персональных данных.
 */
import { describe, expect, it } from 'vitest';

import type { Env } from '../src/types';
import type { MediaStats } from '../src/mediakit';
import {
  getCookie,
  isMediaAuthed,
  mediaCookieValue,
  renderLoginPage,
  renderMediaPage,
} from '../src/mediakit';

const env = {
  MEDIA_LOGIN: 'partner',
  MEDIA_PASSWORD: 's3cret',
} as unknown as Env;

describe('вход по логину и паролю', () => {
  it('cookie стабильна для одной пары и меняется от пароля', async () => {
    const a = await mediaCookieValue('partner', 's3cret');
    const b = await mediaCookieValue('partner', 's3cret');
    const c = await mediaCookieValue('partner', 'другой');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('isMediaAuthed: верная пара — true, мусор и пустые секреты — false', async () => {
    const good = await mediaCookieValue('partner', 's3cret');
    expect(await isMediaAuthed(good, env)).toBe(true);
    expect(await isMediaAuthed('f'.repeat(64), env)).toBe(false);
    expect(await isMediaAuthed(null, env)).toBe(false);
    expect(await isMediaAuthed(good, {} as Env)).toBe(false);
  });

  it('getCookie достаёт нужное значение из заголовка', () => {
    const req = new Request('https://pop-utka.app/mediakit', {
      headers: { cookie: 'other=1; media=abc123; theme=dark' },
    });
    expect(getCookie(req, 'media')).toBe('abc123');
    expect(getCookie(req, 'нет')).toBeNull();
    expect(getCookie(new Request('https://x/'), 'media')).toBeNull();
  });
});

describe('страница входа', () => {
  it('форма логина/пароля, noindex, без статистики', () => {
    const html = renderLoginPage('Неверный логин или пароль.');
    expect(html).toContain('action="/mediakit/login"');
    expect(html).toContain('type="password"');
    expect(html).toContain('Неверный логин или пароль.');
    expect(html).toContain('noindex');
    // статистики на логине нет: ни цифр, ни заголовков разделов
    // (стили общие, поэтому проверяем содержательные маркеры)
    expect(html).not.toContain('Ключевые цифры');
    expect(html).not.toContain('просмотров карточек');
  });
});

describe('страница статистики', () => {
  const stats: MediaStats = {
    generatedAt: '2026-10-02T12:00:00Z',
    onBoard: { offer: 120, request: 34 },
    last30: { arrived: 210, approved: 180, cities: 17, directions: 8 },
    viewsTotal: 5230,
    daily: Array.from({ length: 30 }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, '0')}`, arrived: (i % 7) + 1 })),
    topDirections: [
      { from: 'Варшава', to: 'Минск', n: 42 },
      { from: 'Гродно', to: 'Белосток', n: 11 },
    ],
    sources: [
      { label: 'Бот Telegram', n: 140, share: 67 },
      { label: 'Сайт', n: 70, share: 33 },
    ],
  };

  it('ключевые цифры, график по дням, направления и источники', () => {
    const html = renderMediaPage(stats, { contact: '@owner' });
    expect(html).toContain('154'); // 120 + 34 на доске
    expect(html).toContain('210'); // заявок за 30 дней
    expect(html).toContain('5230'); // просмотры
    expect(html).toContain('media-chart');
    expect(html).toContain('Варшава → Минск');
    expect(html).toContain('Бот Telegram — 67% (140)');
    expect(html).toContain('@owner');
    expect(html).toContain('выйти');
    expect(html).toContain('noindex');
  });

  it('никаких персональных данных: контакты и ссылки на карточки не выводим', () => {
    const html = renderMediaPage(stats, { contact: '@owner' });
    // единственная ссылка t.me — контакт владельца или бот, карточек нет
    expect(html).not.toContain('/item/');
    expect(html).not.toContain('+375');
    expect(html).not.toContain('+48');
  });

  it('города направлений экранируются', () => {
    const dirty = { ...stats, topDirections: [{ from: '<script>x</script>', to: 'Минск', n: 1 }] };
    const html = renderMediaPage(dirty);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('пустые данные не ломают страницу', () => {
    const empty: MediaStats = {
      generatedAt: '2026-10-02T12:00:00Z',
      onBoard: { offer: 0, request: 0 },
      last30: { arrived: 0, approved: 0, cities: 0, directions: 0 },
      viewsTotal: 0,
      daily: [],
      topDirections: [],
      sources: [],
    };
    const html = renderMediaPage(empty);
    expect(html).toContain('Направления появятся');
    expect(html).toContain('media-chart'); // пустой график не роняет разметку
  });
});
