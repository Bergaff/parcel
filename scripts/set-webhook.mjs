#!/usr/bin/env node
/**
 * Устанавливает вебхук Telegram на Cloudflare Worker.
 *
 * Использование:
 *   node scripts/set-webhook.mjs
 *
 * Переменные:
 *   BOT_TOKEN   — токен от @BotFather (обязательно)
 *   BOT_SECRET  — секрет из /api/telegram/:secret (обязательно)
 *   WORKER_URL  — публичный URL ВОРКЕРА, напр. https://poputchka-api.workers.dev (обязательно)
 *   SITE_URL    — публичный URL сайта (Pages), используется только как fallback для WORKER_URL
 *
 * Важно: вебхук должен указывать на воркер, а не на Pages!
 * Pages раздаёт статику и не умеет принимать /api/telegram/...
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

function loadDevVars() {
  const p = resolve(process.cwd(), '.dev.vars');
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const vars = loadDevVars();
const BOT_TOKEN = process.env.BOT_TOKEN ?? vars.BOT_TOKEN;
const BOT_SECRET = process.env.BOT_SECRET ?? vars.BOT_SECRET;
const WORKER_URL = (process.env.WORKER_URL ?? vars.WORKER_URL ?? process.env.SITE_URL ?? vars.SITE_URL ?? '').replace(/\/+$/, '');

if (!BOT_TOKEN || !BOT_SECRET || !WORKER_URL) {
  console.error('Нужны BOT_TOKEN, BOT_SECRET и WORKER_URL (env или .dev.vars).');
  console.error('WORKER_URL — это адрес воркера, например https://poputchka-api.workers.dev, а не Pages.');
  process.exit(1);
}

const url = `${WORKER_URL}/api/telegram/${BOT_SECRET}`;
const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url, allowed_updates: ['message', 'channel_post', 'callback_query'] }),
});
const json = await res.json().catch(() => null);
console.log(json?.ok ? `✅ Вебхук установлен: ${url}` : `❌ Ошибка: ${JSON.stringify(json)}`);
process.exit(json?.ok ? 0 : 1);
