/**
 * Динамические OG-картинки объявлений (1200×630, PNG).
 *
 * Растеризация — resvg-wasm. Wasm-бинарник импортируется статически
 * (в воркерах запрещена динамическая компиляция WebAssembly из байтов).
 * Шрифты читаются через биндинг ASSETS: воркер НЕ может сделать fetch()
 * на собственный домен (self-fetch запрещён), а биндинг отдаёт файлы
 * из assets-директории напрямую, без сети.
 */
import wasmModule from './resvg.wasm';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import type { Env, Listing } from './types';
import { escapeHtml } from './util';

let initPromise: Promise<Uint8Array[]> | null = null;

async function lazyInit(env: Env): Promise<Uint8Array[]> {
  if (!initPromise) {
    initPromise = (async () => {
      const [fontRes, boldRes] = await Promise.all([
        env.ASSETS.fetch(new Request('https://assets/og-font.ttf')),
        env.ASSETS.fetch(new Request('https://assets/og-font-bold.ttf')),
      ]);
      if (!fontRes.ok || !boldRes.ok) {
        throw new Error(`og fonts unavailable: ${fontRes.status}/${boldRes.status}`);
      }
      await initWasm(wasmModule);
      return [
        new Uint8Array(await fontRes.arrayBuffer()),
        new Uint8Array(await boldRes.arrayBuffer()),
      ];
    })();
    // при ошибке даём повторить на следующем запросе
    initPromise.catch(() => { initPromise = null; });
  }
  return initPromise;
}

const MONTHS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

function fmtDateRu(iso: string): string | null {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const day = parseInt(m[3]!, 10);
  const month = MONTHS_GEN[parseInt(m[2]!, 10) - 1];
  return month ? `${day} ${month}` : iso;
}

const WIDTH = 1200;
const HEIGHT = 630;

function buildSvg(l: Listing): string {
  const typeLabel = l.type === 'offer' ? 'водитель везёт' : 'нужно передать';

  // Метаданные: дата · вес · цена
  const meta = [
    l.departureDate ? `выезд ${fmtDateRu(l.departureDate) ?? l.departureDate}` : null,
    l.weightKg != null ? `${String(l.weightKg).replace('.', ',')} кг` : null,
    l.price,
  ].filter(Boolean).join('   ·   ');

  // Размер шрифта маршрута — от длины строки
  const routeLen = l.fromCity.length + l.toCity.length + 3;
  const routeSize = routeLen <= 16 ? 128 : routeLen <= 22 ? 104 : routeLen <= 30 ? 82 : 64;

  // Описание: одна строка, при необходимости режем
  let desc = (l.description ?? '').replace(/\s+/g, ' ').trim();
  if (desc.length > 130) desc = desc.slice(0, 129).trimEnd() + '…';

  // Ширина плашки типа — грубая оценка по символам
  const badgeW = typeLabel.length * 20 + 72;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#f2eee5"/>

  <!-- лейбл сверху -->
  <text x="80" y="128" font-family="DejaVu Serif" font-size="64" font-weight="bold" fill="#201d17">попутка<tspan fill="#a43a10">.</tspan></text>
  <line x1="80" y1="170" x2="${WIDTH - 80}" y2="170" stroke="#a99e85" stroke-width="2"/>

  <!-- маршрут -->
  <text x="${WIDTH / 2}" y="330" text-anchor="middle" font-family="DejaVu Serif" font-size="${routeSize}" font-weight="bold" fill="#201d17">${escapeHtml(l.fromCity)} <tspan fill="#a43a10">→</tspan> ${escapeHtml(l.toCity)}</text>

  <!-- метаданные -->
  ${meta ? `<text x="${WIDTH / 2}" y="404" text-anchor="middle" font-family="DejaVu Serif" font-size="38" fill="#47423a">${escapeHtml(meta)}</text>` : ''}

  <!-- плашка типа -->
  <rect x="${(WIDTH - badgeW) / 2}" y="440" width="${badgeW}" height="66" fill="none" stroke="#201d17" stroke-width="3"/>
  <text x="${WIDTH / 2}" y="485" text-anchor="middle" font-family="DejaVu Serif" font-size="32" fill="#201d17">${escapeHtml(typeLabel)}</text>

  <!-- описание -->
  ${desc ? `<text x="${WIDTH / 2}" y="562" text-anchor="middle" font-family="DejaVu Serif" font-size="30" fill="#6f675a">${escapeHtml(desc)}</text>` : ''}

  <!-- домен -->
  <text x="${WIDTH - 80}" y="${HEIGHT - 40}" text-anchor="end" font-family="DejaVu Serif" font-size="26" fill="#a99e85">parcel-61u.pages.dev</text>
</svg>`;
}

export async function renderOgImage(listing: Listing, env: Env): Promise<Uint8Array> {
  const fontBuffers = await lazyInit(env);
  const resvg = new Resvg(buildSvg(listing), {
    font: {
      fontBuffers,
      loadSystemFonts: false,
      defaultFontFamily: 'DejaVu Serif',
      serifFamily: 'DejaVu Serif',
    },
    fitTo: { mode: 'original' },
  });
  return resvg.render().asPng();
}
