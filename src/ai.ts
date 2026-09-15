/**
 * ИИ-оформление объявлений (DeepSeek), каскад второй ступени.
 *
 * Первая ступень — правила (src/parser.ts): бесплатны и обрабатывают
 * большинство объявлений. Если уверенность правил < 0.7 (необычный формат,
 * неизвестные города, кривые даты) — сообщение уходит сюда.
 *
 * ИИ возвращает строго JSON, результат проходит жёсткую валидацию
 * (validateAiListing): города только кириллицей, дата в разумных пределах,
 * контакты валидны. Всё, что не прошло, — отбрасывается, а заявка в любом
 * случае попадает на ручную модерацию, как обычно.
 *
 * Включается секретом AI_API_KEY (platform.deepseek.com → API Keys).
 * Без ключа бот работает как раньше, ИИ не вызывается.
 * AI_MODEL — модель (по умолчанию deepseek-chat), AI_BASE_URL — для тестов.
 */
import type { Env, ListingType } from './types';
import { normalizeCity, } from './parser';
import { isRussianCity, sanitizeContact } from './util';

/** Дневной лимит ИИ-вызовов — страховка от неожиданного счёта. */
const DAILY_AI_LIMIT = 300;

export interface AiFields {
  type: ListingType;
  fromCity: string;
  toCity: string;
  departureDate: string | null;
  weightKg: number | null;
  price: string | null;
  telegram: string | null;
  phone: string | null;
  description: string;
}

const SYSTEM_PROMPT = `Ты — строгий извлекатель данных из сообщений телеграм-чатов.
Доска объявлений «попутка.» — ТОЛЬКО про передачу посылок и вещей попутными машинами.
Верни ТОЛЬКО валидный JSON без пояснений и без markdown, по схеме:
{"is_listing": true, "is_passenger": false, "type": "offer", "from_city": "Город", "to_city": "Город", "departure_date": "YYYY-MM-DD", "weight_kg": 5, "price": "50 zł", "telegram": "@username", "phone": null, "description": "сжатое описание до 300 символов"}

Правила:
- type: "offer" — автор едет и может взять/передать посылку; "request" — автор просит передать посылку.
- is_passenger: true — если это поиск или предложение ПОЕЗДКИ пассажиром без посылок (пассажир, подвезти до, довезти, места в машине). Такие сообщения доске не нужны.
- Города — по-русски, кириллицей: Warsaw → Варшава. Однозначно не знаешь перевода — напиши как в сообщении.
- departure_date — ближайшая будущая дата относительно СЕГОДНЯ, формат YYYY-MM-DD. Даты нет — null.
- Даты «плавают» или альтернатив несколько («18/19.09», «прибытие 20 или 21.09», «около 20 числа», «на выходных») — возьми САМУЮ РАННЮЮ конкретную дату, а точную формулировку с альтернативами обязательно сохрани в description.
- Несколько городов назначения («в Мадрид или Париж») — to_city = первый упомянутый город, альтернативу обязательно упомяни в description.
- Не выдумывай: чего нет в сообщении — null. weight_kg — число (кг) или null.
- telegram/phone — только если явно указаны в сообщении.
- description: суть одним-двумя предложениями, до 300 символов, по-русски.
- Сообщение не про поездку/передачу — верни {"is_listing": false}.`;

/** Валидация ответа ИИ: чему не доверяем — то отбрасываем. Чистая, тестируется юнит-тестами. */
export function validateAiListing(
  raw: unknown,
  opts: { now: Date; originalText: string }
): AiFields | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const b = raw as Record<string, unknown>;

  if (b.is_listing !== true) return null;
  // пассажирские попутки доске не нужны
  if (b.is_passenger === true) return null;

  const type: ListingType | null = b.type === 'offer' ? 'offer' : b.type === 'request' ? 'request' : null;
  if (!type) return null;

  // Города: ИИ просили по-русски, но проверяем — и незнакомую латиницу переводим
  const fromRaw = typeof b.from_city === 'string' ? b.from_city.trim() : '';
  const toRaw = typeof b.to_city === 'string' ? b.to_city.trim() : '';
  if (!fromRaw || !toRaw) return null;
  const fromCity = normalizeCity(fromRaw);
  const toCity = normalizeCity(toRaw);
  if (!isRussianCity(fromCity) || !isRussianCity(toCity)) return null;

  // Дата: YYYY-MM-DD, не дальше года вперёд и не старше 3 дней назад
  let departureDate: string | null = null;
  if (typeof b.departure_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.departure_date)) {
    const t = new Date(`${b.departure_date}T00:00:00Z`).getTime();
    const min = opts.now.getTime() - 3 * 86400_000;
    const max = opts.now.getTime() + 366 * 86400_000;
    if (Number.isFinite(t) && t >= min && t <= max) departureDate = b.departure_date;
  }

  let weightKg: number | null = null;
  if (typeof b.weight_kg === 'number' && Number.isFinite(b.weight_kg) && b.weight_kg > 0 && b.weight_kg <= 1000) {
    weightKg = Math.round(b.weight_kg * 100) / 100;
  }

  const price = (typeof b.price === 'string' && b.price.trim()) ? b.price.trim().slice(0, 40) : null;

  const telegram = typeof b.telegram === 'string' && b.telegram.trim() ? sanitizeContact(b.telegram.trim()) : null;
  const phone = typeof b.phone === 'string' && b.phone.trim() ? sanitizeContact(b.phone.trim()) : null;

  // Описание: если ИИ не дал осмысленного — берём исходный текст
  let description = typeof b.description === 'string' ? b.description.trim() : '';
  if (description.length < 5) description = opts.originalText.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (description.length < 5) return null;

  return { type, fromCity, toCity, departureDate, weightKg, price, telegram, phone, description };
}

/** Дневная квота ИИ-вызовов (KV-счётчик) — чтобы счёт не удивил. */
async function aiQuotaOk(env: Env): Promise<boolean> {
  const day = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  const key = `ai:day:${day}`;
  const raw = await env.KV.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= DAILY_AI_LIMIT) return false;
  await env.KV.put(key, String(count + 1), { expirationTtl: 2 * 86400 });
  return true;
}

/**
 * Оформить сообщение заявкой через DeepSeek. null — не вышло
 * (не объявление, пассажирская попутка, ошибка сети или квота).
 */
export async function aiExtractListing(env: Env, text: string): Promise<AiFields | null> {
  if (!env.AI_API_KEY) return null;
  if (!(await aiQuotaOk(env))) return null;

  const now = new Date();
  const today = new Date(now.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  const base = (env.AI_BASE_URL ?? 'https://api.deepseek.com').replace(/\/+$/, '');

  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.AI_MODEL ?? 'deepseek-chat',
        temperature: 0,
        max_tokens: 300,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `СЕГОДНЯ: ${today}\n\nСообщение из чата:\n"""\n${text.slice(0, 2000)}\n"""` },
        ],
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      console.error('deepseek http error', res.status);
      return null;
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content ?? '';
    const parsed = JSON.parse(content) as unknown;
    return validateAiListing(parsed, { now, originalText: text });
  } catch (e) {
    console.error('deepseek call failed', e);
    return null;
  }
}
