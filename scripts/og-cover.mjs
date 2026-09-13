/**
 * Генератор обложки сайта (og-cover.png, 1200×630) — превью ссылки на главную.
 * Чистая версия: вордмарк «попутка.» и подзаголовок, без маршрутов и стрелок.
 *
 * Запуск: node scripts/og-cover.mjs  → public/og-cover.png
 * После генерации поднять версию в og:image (?v=N), чтобы Telegram
 * перезакачал картинку (превью кэшируется по URL).
 */
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

await initWasm(readFileSync(resolve(root, 'src/resvg.wasm')));

const WIDTH = 1200;
const HEIGHT = 630;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#f2eee5"/>

  <!-- вордмарк по центру -->
  <text x="${WIDTH / 2}" y="330" text-anchor="middle" font-family="DejaVu Serif" font-size="176" font-weight="bold" fill="#201d17">попутка<tspan fill="#a43a10">.</tspan></text>
  <line x1="${WIDTH / 2 - 260}" y1="380" x2="${WIDTH / 2 + 260}" y2="380" stroke="#a99e85" stroke-width="2"/>

  <!-- подзаголовок -->
  <text x="${WIDTH / 2}" y="452" text-anchor="middle" font-family="DejaVu Serif" font-size="40" fill="#6f675a">доска попутных передач посылок</text>

  <!-- домен -->
  <text x="${WIDTH - 80}" y="${HEIGHT - 40}" text-anchor="end" font-family="DejaVu Serif" font-size="26" fill="#a99e85">pop-utka.app</text>
</svg>`;

const resvg = new Resvg(svg, {
  font: {
    fontBuffers: [
      readFileSync('/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf'),
      readFileSync('/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf'),
    ],
    loadSystemFonts: false,
    defaultFontFamily: 'DejaVu Serif',
    serifFamily: 'DejaVu Serif',
  },
  fitTo: { mode: 'original' },
});

const png = resvg.render().asPng();
writeFileSync(resolve(root, 'public/og-cover.png'), png);
console.log(`public/og-cover.png: ${png.length} bytes, ${WIDTH}x${HEIGHT}`);
