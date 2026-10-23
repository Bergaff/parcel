/**
 * Рекламные макеты для Яндекс.Директа (РСЯ): 1080×1080 и 1080×608.
 *
 * Рендер — тем же resvg-wasm и теми же шрифтами (public/og-font*.ttf, DejaVu
 * Serif), что и OG-картинки объявлений: кириллица и палитра совпадают с
 * брендом поточно, генеративные модели так не умеют. Палитра снята с
 * docs/social-preview.png и public/og-cover.png:
 *   фон #f2eee5, чернила #201d17, второй #47423a, приглушённый #6f675a,
 *   ржавчина #a43a10, зелень штампа #47571f, волосяная линия #a99e85.
 *
 * Запуск из корня репозитория: node scripts/make-ads.mjs
 * Результат: docs/ads/rsya-*.png. Правки текста — только здесь, макеты
 * пересобираются детерминированно.
 *
 * Ограничения рекламных текстов (те же, что для объявлений): без «самый
 * дешёвый», «№1», «гарантированно доставим», телефонов и КАПСА. Все фразы
 * ниже — описание того, что сервис делает на самом деле.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { initWasm, Resvg } from '@resvg/resvg-wasm';

const BG = '#f2eee5';
const INK = '#201d17';
const INK2 = '#47423a';
const MUT = '#6f675a';
const RUST = '#a43a10';
const GREEN = '#47571f';
const HAIR = '#a99e85';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Логотип: «попутка» + ржавая точка. x,y — базовая линия. */
function logo(x, y, size, anchor = 'start') {
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="DejaVu Serif" font-size="${size}" font-weight="bold" fill="${INK}">попутка<tspan fill="${RUST}">.</tspan></text>`;
}

/** Наклонный штамп-рамка с подписью, как в social-preview. */
function stamp(cx, cy, w, h, angle, color, text, size) {
  return `<g transform="rotate(${angle} ${cx} ${cy})">
    <rect x="${cx - w / 2}" y="${cy - h / 2}" width="${w}" height="${h}" fill="${BG}" stroke="${color}" stroke-width="3"/>
    <text x="${cx}" y="${cy + size * 0.36}" text-anchor="middle" font-family="DejaVu Serif" font-size="${size}" font-weight="bold" fill="${color}">${esc(text)}</text>
  </g>`;
}

/** Маршрут точками на волосяной линии: города над точками, стрелки между. */
function routeLine(y, xs, names, nameSize) {
  const parts = [];
  parts.push(`<line x1="${xs[0]}" y1="${y}" x2="${xs[xs.length - 1]}" y2="${y}" stroke="${HAIR}" stroke-width="2"/>`);
  xs.forEach((x, i) => {
    parts.push(`<circle cx="${x}" cy="${y}" r="${Math.round(nameSize * 0.28)}" fill="${RUST}"/>`);
    parts.push(`<text x="${x}" y="${y - nameSize * 0.9}" text-anchor="middle" font-family="DejaVu Serif" font-size="${nameSize}" font-weight="bold" fill="${INK}">${esc(names[i])}</text>`);
    if (i < xs.length - 1) {
      const mx = (xs[i] + xs[i + 1]) / 2;
      parts.push(`<text x="${mx}" y="${y + nameSize * 0.36}" text-anchor="middle" font-family="DejaVu Serif" font-size="${Math.round(nameSize * 0.8)}" fill="${RUST}">→</text>`);
    }
  });
  return parts.join('\n    ');
}

function frame(w, h, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="${BG}"/>
  ${body}
  <text x="${w - 72}" y="${h - 44}" text-anchor="end" font-family="DejaVu Serif" font-size="${h > 700 ? 30 : 26}" fill="${MUT}">pop-utka.app</text>
</svg>`;
}

/* ------------------------------------------------------------------ */
/* Квадрат 1080×1080                                                    */
/* ------------------------------------------------------------------ */

const sq = {};

// 1. Штампы: логотип + две наклейки + теглайн + маршрут строкой
sq.stampy = frame(1080, 1080, `
    ${logo(96, 500, 168)}
    ${stamp(760, 210, 356, 70, -5, GREEN, 'водитель везёт', 31)}
    ${stamp(800, 310, 372, 70, 4, RUST, 'нужно передать', 31)}
    <line x1="96" y1="575" x2="984" y2="575" stroke="${HAIR}" stroke-width="2"/>
    <text x="96" y="665" font-family="DejaVu Serif" font-size="44" fill="${INK2}">доска попутных передач посылок</text>
    <text x="96" y="765" font-family="DejaVu Serif" font-size="40" font-weight="bold" fill="${INK}">Брест <tspan fill="${RUST}">→</tspan> Варшава <tspan fill="${RUST}">→</tspan> Минск</text>
    <text x="96" y="841" font-family="DejaVu Serif" font-size="30" fill="${MUT}">заявки водителей и тех, кому нужно передать</text>
  `);

// 2. Маршрут точками
sq.route = frame(1080, 1080, `
    ${logo(96, 220, 84)}
    ${routeLine(520, [220, 540, 860], ['Брест', 'Варшава', 'Минск'], 48)}
    <text x="540" y="655" text-anchor="middle" font-family="DejaVu Serif" font-size="30" fill="${MUT}">по этим дорогам посылки уже едут с попутчиками</text>
    <line x1="96" y1="765" x2="984" y2="765" stroke="${HAIR}" stroke-width="2"/>
    <text x="96" y="850" font-family="DejaVu Serif" font-size="44" fill="${INK2}">доска попутных передач посылок</text>
  `);

// 3. Вопрос водителю
sq.edesh = frame(1080, 1080, `
    <text x="96" y="400" font-family="DejaVu Serif" font-size="80" font-weight="bold" fill="${INK}">Едешь из Минска</text>
    <text x="96" y="505" font-family="DejaVu Serif" font-size="80" font-weight="bold" fill="${INK}">в Варшаву<tspan fill="${RUST}">?</tspan></text>
    <text x="96" y="625" font-family="DejaVu Serif" font-size="44" fill="${INK2}">Передай посылку по пути.</text>
    <line x1="96" y1="740" x2="984" y2="740" stroke="${HAIR}" stroke-width="2"/>
    ${logo(96, 850, 64)}
    <text x="96" y="920" font-family="DejaVu Serif" font-size="32" fill="${MUT}">заявки тех, кому нужно передать, — на доске</text>
  `);

// 4. Вопрос отправителю
sq.peredat = frame(1080, 1080, `
    <text x="96" y="400" font-family="DejaVu Serif" font-size="80" font-weight="bold" fill="${INK}">Нужно передать</text>
    <text x="96" y="505" font-family="DejaVu Serif" font-size="80" font-weight="bold" fill="${INK}">посылку<tspan fill="${RUST}">?</tspan></text>
    <text x="96" y="625" font-family="DejaVu Serif" font-size="44" fill="${INK2}">Найди водителя, который</text>
    <text x="96" y="685" font-family="DejaVu Serif" font-size="44" fill="${INK2}">едет твоим маршрутом.</text>
    <line x1="96" y1="800" x2="984" y2="800" stroke="${HAIR}" stroke-width="2"/>
    ${logo(96, 910, 64)}
  `);

// 5. Только бренд
sq.logo = frame(1080, 1080, `
    ${logo(540, 540, 176, 'middle')}
    <line x1="320" y1="620" x2="760" y2="620" stroke="${HAIR}" stroke-width="2"/>
    <text x="540" y="720" text-anchor="middle" font-family="DejaVu Serif" font-size="44" fill="${INK2}">доска попутных передач посылок</text>
  `);

/* ------------------------------------------------------------------ */
/* Широкий 1080×608 (16:9)                                              */
/* ------------------------------------------------------------------ */

const wide = {};

wide.stampy = frame(1080, 608, `
    ${logo(80, 260, 116)}
    ${stamp(760, 120, 300, 56, -4, GREEN, 'водитель везёт', 26)}
    ${stamp(800, 200, 316, 56, 3, RUST, 'нужно передать', 26)}
    <line x1="80" y1="320" x2="1000" y2="320" stroke="${HAIR}" stroke-width="2"/>
    <text x="80" y="392" font-family="DejaVu Serif" font-size="34" fill="${INK2}">доска попутных передач посылок</text>
    <text x="80" y="466" font-family="DejaVu Serif" font-size="34" font-weight="bold" fill="${INK}">Брест <tspan fill="${RUST}">→</tspan> Варшава <tspan fill="${RUST}">→</tspan> Минск</text>
  `);

wide.route = frame(1080, 608, `
    ${logo(80, 120, 60)}
    ${routeLine(330, [200, 540, 880], ['Брест', 'Варшава', 'Минск'], 40)}
    <text x="540" y="440" text-anchor="middle" font-family="DejaVu Serif" font-size="30" fill="${MUT}">по этим дорогам посылки уже едут с попутчиками</text>
    <text x="80" y="530" font-family="DejaVu Serif" font-size="30" fill="${INK2}">доска попутных передач посылок</text>
  `);

wide.edesh = frame(1080, 608, `
    <text x="80" y="205" font-family="DejaVu Serif" font-size="50" font-weight="bold" fill="${INK}">Едешь из Минска в Варшаву<tspan fill="${RUST}">?</tspan></text>
    <text x="80" y="290" font-family="DejaVu Serif" font-size="36" fill="${INK2}">Передай посылку по пути.</text>
    <line x1="80" y1="380" x2="1000" y2="380" stroke="${HAIR}" stroke-width="2"/>
    ${logo(80, 480, 52)}
    <text x="80" y="540" font-family="DejaVu Serif" font-size="28" fill="${MUT}">заявки тех, кому нужно передать, — на доске</text>
  `);

wide.peredat = frame(1080, 608, `
    <text x="80" y="205" font-family="DejaVu Serif" font-size="50" font-weight="bold" fill="${INK}">Нужно передать посылку<tspan fill="${RUST}">?</tspan></text>
    <text x="80" y="290" font-family="DejaVu Serif" font-size="32" fill="${INK2}">Найди водителя, который едет твоим маршрутом.</text>
    <line x1="80" y1="380" x2="1000" y2="380" stroke="${HAIR}" stroke-width="2"/>
    ${logo(80, 480, 52)}
  `);

wide.logo = frame(1080, 608, `
    ${logo(80, 330, 148)}
    <line x1="80" y1="390" x2="1000" y2="390" stroke="${HAIR}" stroke-width="2"/>
    <text x="80" y="470" font-family="DejaVu Serif" font-size="38" fill="${INK2}">доска попутных передач посылок</text>
  `);

/* ------------------------------------------------------------------ */

const fonts = [
  new Uint8Array(readFileSync('public/og-font.ttf')),
  new Uint8Array(readFileSync('public/og-font-bold.ttf')),
];
await initWasm(new Uint8Array(readFileSync('src/resvg.wasm')));

mkdirSync('docs/ads', { recursive: true });
for (const [name, svg] of Object.entries(sq)) {
  const r = new Resvg(svg, {
    font: { fontBuffers: fonts, loadSystemFonts: false, defaultFontFamily: 'DejaVu Serif' },
  });
  writeFileSync(`docs/ads/rsya-1080x1080-${name}.png`, r.render().asPng());
}
for (const [name, svg] of Object.entries(wide)) {
  const r = new Resvg(svg, {
    font: { fontBuffers: fonts, loadSystemFonts: false, defaultFontFamily: 'DejaVu Serif' },
  });
  writeFileSync(`docs/ads/rsya-1080x608-${name}.png`, r.render().asPng());
}
console.log('готово: docs/ads/rsya-*.png —', Object.keys(sq).length + Object.keys(wide).length, 'файлов');
