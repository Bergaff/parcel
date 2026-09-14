/**
 * Генератор социальной картинки репозитория (GitHub → Settings → Social preview).
 * 1280×640, стиль сайта «попутка.»: бумага, антиква, акцентная точка, штампы.
 *
 * Запуск: node scripts/social-preview.mjs  → docs/social-preview.png
 * Шрифты — системные DejaVu Serif (те же, из которых нарезаны og-font*.ttf).
 */
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

await initWasm(readFileSync(resolve(root, 'src/resvg.wasm')));

const WIDTH = 1280;
const HEIGHT = 640;

function stamp(x, y, w, text, color, rotate) {
  return `<g transform="rotate(${rotate} ${x + w / 2} ${y + 33})">
    <rect x="${x}" y="${y}" width="${w}" height="66" fill="none" stroke="${color}" stroke-width="3"/>
    <text x="${x + w / 2}" y="${y + 45}" text-anchor="middle" font-family="DejaVu Serif" font-size="28" font-weight="bold" fill="${color}">${text}</text>
  </g>`;
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#f2eee5"/>

  <!-- штампы, как на доске -->
  ${stamp(860, 120, 320, 'водитель везёт', '#47571f', -3)}
  ${stamp(920, 218, 310, 'нужно передать', '#a43a10', -3)}

  <!-- вордмарк -->
  <text x="100" y="310" font-family="DejaVu Serif" font-size="176" font-weight="bold" fill="#201d17">попутка<tspan fill="#a43a10">.</tspan></text>
  <line x1="100" y1="352" x2="${WIDTH - 100}" y2="352" stroke="#a99e85" stroke-width="2"/>

  <!-- подзаголовок -->
  <text x="102" y="430" font-family="DejaVu Serif" font-size="50" fill="#6f675a">доска попутных передач посылок</text>

  <!-- маршрут -->
  <text x="102" y="505" font-family="DejaVu Serif" font-size="46" font-weight="bold" fill="#47423a">Варшава <tspan fill="#a43a10">→</tspan> Минск <tspan fill="#a43a10">→</tspan> Краков <tspan fill="#a43a10">→</tspan> Берлин</text>

  <!-- подпись -->
  <text x="102" y="585" font-family="DejaVu Serif" font-size="28" fill="#a99e85">без коммерции · код открыт: github.com/Bergaff/parcel</text>
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

mkdirSync(resolve(root, 'docs'), { recursive: true });
const png = resvg.render().asPng();
writeFileSync(resolve(root, 'docs/social-preview.png'), png);
console.log(`docs/social-preview.png: ${png.length} bytes, ${WIDTH}x${HEIGHT}`);
