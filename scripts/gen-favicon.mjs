/**
 * Генерация фавиконов: node scripts/gen-favicon.mjs
 *
 * Поисковики (Яндекс, Google) не читают data-URI из <link rel="icon"> — в
 * выдаче вместо значка показывался глобус. Нужны настоящие файлы: favicon.ico
 * в корне (его ищет Яндекс), PNG/ICO в <link rel="icon"> (Google), SVG —
 * для современных браузеров, apple-touch-icon — для закладок на iPhone.
 *
 * Рисует «п» тем же DejaVu Serif Bold, что и ворйдмарк «попутка.» на
 * OG-картинках (public/og-font-bold.ttf), цвета сайта: бежевый #f2eee5 и
 * чернильный #201d17. ICO собирается из PNG (16/32/48) — так и рендер
 * остаётся чётким на каждом размере, и формат читают все браузеры.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { initWasm, Resvg } from '@resvg/resvg-wasm';

const BG = '#f2eee5';
const INK = '#201d17';
const CAP = 0.729; // высота прописной буквы DejaVu Serif относительно кегля

const root = new URL('..', import.meta.url);
await initWasm(new Uint8Array(readFileSync(new URL('src/resvg.wasm', root))));
const fontBold = new Uint8Array(readFileSync(new URL('public/og-font-bold.ttf', root)));

function letterSvg(size) {
  const fs = size * 0.74;               // кегль: буква занимает ~54% высоты значка
  const y = size / 2 + (CAP * fs) / 2;  // базовая линия для вертикального центрирования
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    + `<rect width="${size}" height="${size}" fill="${BG}"/>`
    + `<text x="${size / 2}" y="${y.toFixed(2)}" text-anchor="middle" `
    + `font-family="DejaVu Serif" font-weight="bold" font-size="${fs.toFixed(2)}" fill="${INK}">п</text>`
    + `</svg>`;
}

function renderPng(size) {
  const resvg = new Resvg(letterSvg(size), {
    font: {
      fontBuffers: [fontBold],
      loadSystemFonts: false,
      defaultFontFamily: 'DejaVu Serif',
      serifFamily: 'DejaVu Serif',
    },
    fitTo: { mode: 'original' },
  });
  return Buffer.from(resvg.render().asPng());
}

/** ICO из готовых PNG: заголовок 6 байт + по 16 байт описания на значок. */
function pngIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);                 // type: icon
  header.writeUInt16LE(entries.length, 4);
  const parts = [header];
  let offset = 6 + 16 * entries.length;
  for (const [size, png] of entries) {
    const e = Buffer.alloc(16);
    e[0] = size;                              // ширина (0 означал бы 256)
    e[1] = size;                              // высота
    e.writeUInt16LE(1, 4);                    // planes
    e.writeUInt16LE(32, 6);                   // бит на пиксель
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    parts.push(e);
    offset += png.length;
  }
  for (const [, png] of entries) parts.push(png);
  return Buffer.concat(parts);
}

const sizes = [16, 32, 48];
const pngs = sizes.map((s) => [s, renderPng(s)]);
writeFileSync(new URL('public/favicon.ico', root), pngIco(pngs));
writeFileSync(new URL('public/apple-touch-icon.png', root), renderPng(180));
writeFileSync(
  new URL('public/favicon.svg', root),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${BG}"/><text x="50" y="68" font-size="52" font-family="Georgia, 'DejaVu Serif', serif" text-anchor="middle" fill="${INK}">п</text></svg>\n`
);
console.log('favicon.ico (16/32/48), apple-touch-icon.png (180), favicon.svg — готовы');
