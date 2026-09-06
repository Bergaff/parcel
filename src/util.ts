import type { Env } from './types';

export function getIp(c: { req: { header: (name: string) => string | undefined } }): string {
  return (
    c.req.header('CF-Connecting-IP') ??
    c.req.header('X-Forwarded-For') ??
    'unknown'
  ).split(',')[0]!.trim();
}

/** Простой лимитер на KV: не более max запросов за окно windowSec. */
export async function rateLimit(
  env: Env,
  key: string,
  max: number,
  windowSec = 3600
): Promise<{ allowed: boolean; remaining: number }> {
  const bucket = Math.floor(Date.now() / (windowSec * 1000));
  const k = `rl:${key}:${bucket}`;
  const raw = await env.KV.get(k);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= max) return { allowed: false, remaining: 0 };
  await env.KV.put(k, String(count + 1), { expirationTtl: windowSec });
  return { allowed: true, remaining: max - count - 1 };
}

export function sanitizeText(s: unknown, maxLen: number, field = 'text'): string | null {
  if (typeof s !== 'string') return null;
  const clean = s.replace(/\s+/g, ' ').trim();
  if (clean.length === 0 || clean.length > maxLen) return null;
  return clean;
}

export function sanitizeCity(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const clean = s.replace(/[^А-ЯЁа-яёA-Za-z0-9\-\s,.]/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length < 1 || clean.length > 80) return null;
  return clean;
}

export function sanitizeContact(s: unknown): string | null {
  if (typeof s !== 'string') return null;
  const clean = s.trim();
  if (clean.length === 0 || clean.length > 64) return null;
  if (!/^(@[a-zA-Z0-9_]{4,32}|(?:https?:\/\/)?t\.me\/[a-zA-Z0-9_]{4,32}|\+?[\d][\d\s\-()]{8,16}[\d])$/.test(clean)) return null;
  return clean;
}

export function normalizeTelegram(s: string): string {
  const m = s.match(/(?:t\.me\/|@)([a-zA-Z0-9_]{4,32})$/);
  return m ? `@${m[1]!}` : s;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

export function tgLink(username: string | null | undefined): string | null {
  if (!username) return null;
  const u = username.replace(/^@/, '');
  return `https://t.me/${u}`;
}

export function admins(env: Env): string[] {
  return (env.ADMIN_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
