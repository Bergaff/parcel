/**
 * Яндекс.Метрика (счётчик 114285172) — на всех публичных страницах.
 *
 * Повод: кампания в Яндекс.Директе была слепа по конверсиям (клик из
 * объявления тонул в «напрямую» собственной статистики). Счётчик ставится
 * в начало <head>: SSR-шелл (все /r/*, /gorod/*, /item/*, /peredat*,
 * /itogi), статика (index.html, 404.html), 503-страница аварии и запасная
 * 404 воркера. Приватные страницы за логином (медиакит) счётчик не несут.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { METRIKA_ID, METRIKA_SNIPPET } from '../src/metrika';
import { seoPageShell } from '../src/seo-routes';
import { renderLoginPage } from '../src/mediakit';

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

const shell = seoPageShell({
  title: 'Передать посылку Гданьск → Минск — 3 заявки | попутка.',
  description: 'Живые заявки водителей и попутчиков на маршруте Гданьск — Минск.',
  canonical: 'https://pop-utka.app/r/gdansk-minsk',
  origin: 'https://pop-utka.app',
  body: '<p>контент</p>',
});

describe('сниппет счётчика', () => {
  it('несёт id счётчика в tag.js и в noscript-пикселе', () => {
    expect(METRIKA_SNIPPET).toContain(`https://mc.yandex.ru/metrika/tag.js?id=${METRIKA_ID}`);
    expect(METRIKA_SNIPPET).toContain(`https://mc.yandex.ru/watch/${METRIKA_ID}`);
    expect(METRIKA_SNIPPET).toContain(`ym(${METRIKA_ID}, 'init'`);
  });
});

describe('SSR-шелл (все SEO-страницы)', () => {
  it('счётчик вклеен дословно и в начале head — до title и до </head>', () => {
    expect(shell).toContain(METRIKA_SNIPPET);
    const at = shell.indexOf('mc.yandex.ru/metrika/tag.js');
    expect(at).toBeGreaterThan(shell.indexOf('<meta charset'));
    expect(at).toBeLessThan(shell.indexOf('<title>'));
    expect(at).toBeLessThan(shell.indexOf('</head>'));
  });

  it('cookie-плашка честная: Метрика упомянута, «без трекеров» не обещаем', () => {
    expect(shell).toContain('Яндекс.Метрику (cookies, запись сессий)');
    expect(shell).not.toContain('без рекламных cookies и трекеров');
  });
});

describe('статические страницы (ассеты отдаются без воркера)', () => {
  it('index.html: тот же сниппет дословно, в head, плашка обновлена', () => {
    const html = read('public/index.html');
    expect(html).toContain(METRIKA_SNIPPET);
    const at = html.indexOf('mc.yandex.ru/metrika/tag.js');
    expect(at).toBeLessThan(html.indexOf('</head>'));
    // SSR главной подменяет только SEO-блок — сниппет должен быть до него
    expect(at).toBeLessThan(html.indexOf('<!--SEO:START-->'));
    expect(html).toContain('Яндекс.Метрику (cookies, запись сессий)');
    expect(html).not.toContain('без рекламных cookies и трекеров');
  });

  it('404.html: тот же сниппет дословно, в head', () => {
    const html = read('public/404.html');
    expect(html).toContain(METRIKA_SNIPPET);
    expect(html.indexOf('mc.yandex.ru/metrika/tag.js')).toBeLessThan(html.indexOf('</head>'));
  });
});

describe('деградированные страницы воркера', () => {
  it('503 «временно не отвечает» и запасная 404 содержат сниппет', () => {
    const indexSrc = read('src/index.ts');
    expect(indexSrc).toContain("import { METRIKA_SNIPPET } from './metrika'");
    expect(indexSrc).toContain('${METRIKA_SNIPPET}');
    const pagesSrc = read('src/pages.ts');
    expect(pagesSrc).toContain("import { METRIKA_SNIPPET } from './metrika'");
    expect(pagesSrc).toContain('<meta charset="utf-8">${METRIKA_SNIPPET}');
  });
});

describe('приватные страницы за логином счётчик не несут', () => {
  it('логин медиакита — без Метрики', () => {
    expect(renderLoginPage()).not.toContain('mc.yandex.ru');
  });

  it('исходники медиакита и страницы аудитории — без сниппета', () => {
    expect(read('src/mediakit.ts')).not.toContain('METRIKA_SNIPPET');
    expect(read('src/visit-stats.ts')).not.toContain('METRIKA_SNIPPET');
  });
});
