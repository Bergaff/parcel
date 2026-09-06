#!/usr/bin/env node
/** Удаляет вебхук Telegram (полезно, если бот нужен в режиме long-polling). */
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
if (!BOT_TOKEN) {
  console.error('Нужен BOT_TOKEN (env или .dev.vars).');
  process.exit(1);
}
const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook`, { method: 'POST' });
const json = await res.json().catch(() => null);
console.log(json?.ok ? '✅ Вебхук удалён.' : `❌ Ошибка: ${JSON.stringify(json)}`);
process.exit(json?.ok ? 0 : 1);
