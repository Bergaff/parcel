#!/usr/bin/env node
/**
 * Прогоняет экспорт истории чата Telegram через парсер объявлений.
 *
 * Зачем: увидеть на РЕАЛЬНЫХ сообщениях ваших чатов, что парсер распознаёт,
 * а что пропускает — и что добавить в CITY_FORMS / OFFER_HINTS / REQUEST_HINTS.
 *
 * Как получить файл:
 *   Telegram Desktop → чат → ⋮ (меню) → Export chat history →
 *   Format: Machine-readable JSON, фото/видео выключить → Export.
 *   Получится result.json — его и передать скрипту.
 *
 * Использование (нужен Node 22.6+):
 *   npm run parse:export -- путь/к/result.json
 *   npm run parse:export -- сообщения.txt   # альтернатива: по одному сообщению на строку
 */
import { readFileSync } from 'node:fs';
import { parseTelegramMessage, looksLikeListing } from '../src/parser.ts';

const path = process.argv[2];
if (!path) {
  console.error('Укажите файл: npm run parse:export -- путь/к/result.json');
  process.exit(1);
}

const raw = readFileSync(path, 'utf8');
let texts = [];

if (path.endsWith('.json')) {
  const data = JSON.parse(raw);
  const messages = data.messages ?? [];
  texts = messages
    .filter((m) => m && m.type === 'message')
    // В экспорте text бывает строкой или массивом кусков (при форматировании)
    .map((m) => Array.isArray(m.text)
      ? m.text.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('')
      : m.text)
    .filter((t) => typeof t === 'string' && t.trim().length >= 10);
} else {
  texts = raw.split('\n').map((s) => s.trim()).filter((s) => s.length >= 10);
}

let hit = 0;
const missed = [];
const hitSamples = [];
for (const t of texts) {
  const p = parseTelegramMessage(t);
  const ok = looksLikeListing(t) && p.confidence >= 0.7;
  if (ok) {
    hit++;
    if (hitSamples.length < 10) hitSamples.push({ t, p });
  } else {
    missed.push(t);
  }
}

const pct = Math.round((hit / Math.max(1, texts.length)) * 100);
console.log(`Сообщений с текстом: ${texts.length}`);
console.log(`Распознано как объявления: ${hit} (${pct}%)`);
console.log(`Пропущено: ${missed.length}`);

console.log('\n=== Примеры распознанных (первые 10) ===');
for (const s of hitSamples) {
  console.log(`--- [${s.p.fromCity} → ${s.p.toCity}] ${s.t.replace(/\n/g, ' ').slice(0, 160)}`);
}

console.log('\n=== Пропущенные (первые 30 — кандидаты в доработку словаря) ===');
for (const t of missed.slice(0, 30)) {
  console.log('--- ' + t.replace(/\n/g, ' ').slice(0, 200));
}
if (missed.length > 30) console.log(`… и ещё ${missed.length - 30}`);
