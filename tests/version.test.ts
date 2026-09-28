/**
 * Версия сайта: src/version.ts — единственное место, откуда её берут
 * /api/config и админка. Тест следит, что она не разъехалась с package.json
 * (забыли поднять — падает здесь, а не «на проде версия старая»).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { SITE_VERSION } from '../src/version';

describe('версия сайта', () => {
  it('совпадает с package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(SITE_VERSION).toBe(pkg.version);
  });

  it('семантический формат X.Y.Z', () => {
    expect(SITE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
