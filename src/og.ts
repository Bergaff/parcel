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
/** Поля слева/справа и полезная ширина текста. */
const MARGIN = 80;
const AREA = WIDTH - MARGIN * 2;

/** Примерная ширина символа DejaVu Serif относительно кегля (жирный шире).
 *  Оценка сознательно с запасом: чуть раньше ужать текст, чем вылезти за край.
 *  Калибровано по рендеру: фактическая ширина жирной строки ≈ 0.66 кегля. */
const REG_W = 0.62;
const BOLD_W = 0.72;

/** Урезает строку с «…», чтобы влезла в maxWidth при данном кегле. */
function fitLine(text: string, maxWidth: number, size: number, bold = false): string {
  const cw = size * (bold ? BOLD_W : REG_W);
  const max = Math.floor(maxWidth / cw);
  if (max < 4) return text.slice(0, 3);
  return text.length <= max ? text : text.slice(0, Math.max(1, max - 1)).trimEnd() + '…';
}

function buildSvg(l: Listing): string {
  const typeLabel = l.type === 'offer' ? 'водитель везёт' : 'нужно передать';

  // Метаданные: дата · вес · цена
  const metaRaw = [
    l.departureDate ? `выезд ${fmtDateRu(l.departureDate) ?? l.departureDate}` : null,
    l.weightKg != null ? `${String(l.weightKg).replace('.', ',')} кг` : null,
    l.price,
  ].filter(Boolean).join('   ·   ');
  const meta = fitLine(metaRaw, AREA, 38);

  // Маршрут: кегль от длины, при сверхдлинных городах — мельче и с «…»
  const routeLen = l.fromCity.length + l.toCity.length + 3;
  let routeSize = routeLen <= 16 ? 118 : routeLen <= 22 ? 98 : routeLen <= 30 ? 80 : routeLen <= 42 ? 62 : 50;
  const routeFits = (sz: number) => routeLen * sz * BOLD_W <= AREA;
  while (!routeFits(routeSize) && routeSize > 40) routeSize -= 4;
  let fromTxt = l.fromCity;
  let toTxt = l.toCity;
  if (!routeFits(routeSize)) {
    // не влезает даже мелким — урезаем оба города до симметричного бюджета
    const total = Math.floor(AREA / (routeSize * BOLD_W)) - 3;
    const budget = Math.max(4, Math.floor((total - 2) / 2));
    fromTxt = fitLine(fromTxt, budget * routeSize * BOLD_W, routeSize, true);
    toTxt = fitLine(toTxt, budget * routeSize * BOLD_W, routeSize, true);
  }

  // Описание: до двух строк, с «…» на второй
  let desc = (l.description ?? '').replace(/\s+/g, ' ').trim();
  const perLine = Math.floor(AREA / (30 * REG_W));
  let desc1 = '';
  let desc2: string | null = null;
  if (desc.length > perLine * 2) desc = desc.slice(0, perLine * 2 - 1).trimEnd() + '…';
  if (desc.length > perLine) {
    const cut = desc.lastIndexOf(' ', perLine);
    const cutAt = cut > perLine * 0.6 ? cut : perLine;
    desc1 = desc.slice(0, cutAt).trim();
    desc2 = fitLine(desc.slice(cutAt).trim(), AREA, 30);
  } else {
    desc1 = desc;
  }

  // Ширина плашки типа — грубая оценка по символам
  const badgeW = typeLabel.length * 20 + 72;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#f2eee5"/>

  <!-- лейбл сверху -->
  <text x="80" y="128" font-family="DejaVu Serif" font-size="64" font-weight="bold" fill="#201d17">попутка<tspan fill="#a43a10">.</tspan></text>
  <line x1="80" y1="170" x2="${WIDTH - 80}" y2="170" stroke="#a99e85" stroke-width="2"/>

  <!-- маршрут -->
  <text x="${WIDTH / 2}" y="330" text-anchor="middle" font-family="DejaVu Serif" font-size="${routeSize}" font-weight="bold" fill="#201d17">${escapeHtml(fromTxt)} <tspan fill="#a43a10">→</tspan> ${escapeHtml(toTxt)}</text>

  <!-- метаданные -->
  ${meta ? `<text x="${WIDTH / 2}" y="404" text-anchor="middle" font-family="DejaVu Serif" font-size="38" fill="#47423a">${escapeHtml(meta)}</text>` : ''}

  <!-- плашка типа -->
  <rect x="${(WIDTH - badgeW) / 2}" y="440" width="${badgeW}" height="66" fill="none" stroke="#201d17" stroke-width="3"/>
  <text x="${WIDTH / 2}" y="485" text-anchor="middle" font-family="DejaVu Serif" font-size="32" fill="#201d17">${escapeHtml(typeLabel)}</text>

  <!-- описание (одна или две строки) -->
  ${desc1 && !desc2 ? `<text x="${WIDTH / 2}" y="562" text-anchor="middle" font-family="DejaVu Serif" font-size="30" fill="#6f675a">${escapeHtml(desc1)}</text>` : ''}
  ${desc2 ? `<text x="${WIDTH / 2}" y="538" text-anchor="middle" font-family="DejaVu Serif" font-size="30" fill="#6f675a">${escapeHtml(desc1)}</text>
  <text x="${WIDTH / 2}" y="576" text-anchor="middle" font-family="DejaVu Serif" font-size="30" fill="#6f675a">${escapeHtml(desc2)}</text>` : ''}

  <!-- домен -->
  <text x="${WIDTH - 80}" y="${HEIGHT - 40}" text-anchor="end" font-family="DejaVu Serif" font-size="26" fill="#a99e85">pop-utka.app</text>
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
