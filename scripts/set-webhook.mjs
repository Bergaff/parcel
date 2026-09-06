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
 *   SITE_URL    — публичный URL воркера, напр. https://poputchka.workers.dev
 *
 * Сначала:  wrangler secret put BOT_TOKEN  (и т.д.), либо положите значения в .dev.vars для локалки.
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
const SITE_URL = (process.env.SITE_URL ?? vars.SITE_URL ?? '').replace(/\/+$/, '');

if (!BOT_TOKEN || !BOT_SECRET || !SITE_URL) {
  console.error('Нужны BOT_TOKEN, BOT_SECRET и SITE_URL (env или .dev.vars).');
  process.exit(1);
}

const url = `${SITE_URL}/api/telegram/${BOT_SECRET}`;
const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url, allowed_updates: ['message', 'channel_post', 'callback_query'] }),
});
const json = await res.json().catch(() => null);
console.log(json?.ok ? `✅ Вебхук установлен: ${url}` : `❌ Ошибка: ${JSON.stringify(json)}`);
process.exit(json?.ok ? 0 : 1);
