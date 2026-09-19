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
import { normalizeCity, parseRecurring } from './parser';
import { dedupeDescription, isRussianCity, normalizeContacts } from './util';

/** Дневной лимит ИИ-вызовов — страховка от неожиданного счёта. */
const DAILY_AI_LIMIT = 300;

export interface AiFields {
  type: ListingType;
  fromCity: string;
  toCity: string;
  departureDate: string | null;
  /** «каждый четверг», «ежедневно» — рейс регулярный, заявка не разовая. */
  recurring: string | null;
  weightKg: number | null;
  price: string | null;
  telegram: string | null;
  phone: string | null;
  description: string;
}

const SYSTEM_PROMPT = `Ты — строгий извлекатель данных из сообщений телеграм-чатов.
Доска объявлений «попутка.» — ТОЛЬКО про передачу посылок и вещей попутными машинами.
Верни ТОЛЬКО валидный JSON без пояснений и без markdown, по схеме:
{"listings": [{"is_listing": true, "is_passenger": false, "type": "offer", "from_city": "Город", "to_city": "Город", "departure_date": "YYYY-MM-DD", "recurring": "каждый четверг", "weight_kg": 5, "price": "50 zl", "telegram": "@username", "phone": null, "description": "сжатое описание до 300 символов"}]}

Правила:
- В одном сообщении может быть НЕСКОЛЬКО рейсов/направлений (туда и обратно, два маршрута, «18-19.9 туда, 20-21.9 обратно») — верни ОТДЕЛЬНЫЙ элемент listings на каждое направление (до 3), со своими городами и датой.
- recurring — РЕГУЛЯРНОЕ расписание рейса, короткой фразой как в сообщении: «каждый четверг», «по вторникам и пятницам», «ежедневно», «по будням», «раз в неделю». Заполняй ТОЛЬКО если рейс повторяется («каждый четверг возим», «езжу по вторникам»), одноразовый рейс — null. Для регулярного departure_date — ближайшая будущая дата по этому расписанию.
- type — по тому, КТО действует. "offer" — автор едет сам и может взять/передать посылку («возьму», «везу», «есть место», «рейс»). "request" — автор ИЩЕТ перевозчика и сам ничего не везёт: «нужно передать», «ищу водителя», «кто везёт завтра?», «кто-то занимается перевозом посылок?», «занимаетесь доставкой?».
- is_passenger: true — если это поиск или предложение ПОЕЗДКИ пассажиром БЕЗ посылок (пассажир, подвезти до, места в машине). «Попутчики + посылки/передачи» — НЕ пассажирское.
- Города — по-русски, кириллицей: Warsaw → Варшава. Сокращения раскрывай по смыслу: «Гр» → Гродно, «Мог» → Могилёв.
- from_city/to_city — крупные города начала и конца маршрута. Промежуточные города и пункты пропуска (Кузница, Брузги, Брест) — упомяни в description («через Кузницу»). Исключение: если такой город и есть КОНЕЧНАЯ точка маршрута («варшава-брест», «посылка до Бреста»), он — to_city (или from_city), выдумывать другой город нельзя.
- departure_date — ближайшая будущая дата относительно СЕГОДНЯ, формат YYYY-MM-DD. Даты нет — null. Даты «плавают» или альтернатив несколько («18/19.09», «20 или 21.09», «на выходных») — возьми САМУЮ РАННЮЮ конкретную дату, точную формулировку сохрани в description.
- Несколько городов назначения («в Мадрид или Париж») — to_city = первый упомянутый, альтернативу обязательно в description.
- Не выдумывай: чего нет в сообщении — null. weight_kg — число (кг) или null.
- telegram/phone — только явно указанные в сообщении (юзернейм без @ тоже годится, префиксы Vb/TG/Вайбер означают мессенджер). В telegram — ТОЛЬКО юзернейм (@username), в phone — ТОЛЬКО номер. Один и тот же контакт в оба поля не пиши: если контакт один, второе поле — null.
- description: суть одним-двумя предложениями, до 300 символов, по-русски. НЕ повторяй то, что уже есть в других полях: маршрут («Варшава-Минск»), дату, вес, цену, слова «водитель»/«нужно передать», номера телефонов и юзернеймы. Пиши только то, что полями не передать: что именно везёт, ограничения, способ связи словами («Telegram, Whatsapp»).
- Сообщение не про поездку/передачу — верни {"listings": []}.`;

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

  // Регулярное расписание: канонизируем знакомые формулировки («Каждый четверг»
  // → «каждый четверг»), незнакомые берём как есть, но коротко и без мусора
  let recurring: string | null = null;
  if (typeof b.recurring === 'string' && b.recurring.trim().length >= 3) {
    const label = b.recurring.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 40);
    const looksLikeSchedule = /кажд|ежедн|еженедел|раз в недел|недел|день|дням|будн|числ|месяц/.test(label);
    recurring = parseRecurring(label) ?? (looksLikeSchedule ? label : null);
  }

  const price = (typeof b.price === 'string' && b.price.trim()) ? b.price.trim().slice(0, 40) : null;

  // ИИ часто возвращает юзернейм без @ ("KgRBPL"), телефон с префиксом
  // мессенджера ("TG+48459568684", "Vb+375256663703") — а бывает, кладёт один
  // и тот же номер и в telegram, и в phone. Раскладываем по полям, дубль убираем:
  // иначе в карточке «Контакты:» печатается дважды, а на сайте t.me/+48… не работает.
  const { telegram, phone } = normalizeContacts(b.telegram, b.phone);

  // Описание: если ИИ не дал осмысленного — берём исходный текст
  let description = typeof b.description === 'string' ? b.description.trim() : '';
  const fromAi = description.length >= 5;
  if (!fromAi) description = opts.originalText.replace(/\s+/g, ' ').trim();

  // Текст, который сочинил ИИ, чистим полностью: маршрут, дата, вес, «Водитель»
  // и контакты уже показаны отдельными полями карточки — дублировать их не нужно.
  // Исходный текст сообщения не калечим: из него убираем только контакты.
  description = dedupeDescription(description, fromAi
    ? { type, fromCity, toCity, departureDate, telegram, phone }
    : { telegram, phone, stripFields: false }
  ).slice(0, 300);
  if (description.length < 5) return null;

  return { type, fromCity, toCity, departureDate, recurring, weightKg, price, telegram, phone, description };
}

/** Разобрать ответ ИИ (массив listings или старый одиночный объект)
 *  в список полей заявок: 0–3 штуки, каждый провалидирован. Чистая функция. */
export function parseAiListings(
  raw: unknown,
  opts: { now: Date; originalText: string }
): AiFields[] {
  const out: AiFields[] = [];
  const items = typeof raw === 'object' && raw !== null && Array.isArray((raw as Record<string, unknown>).listings)
    ? ((raw as Record<string, unknown>).listings as unknown[])
    : [raw];
  for (const item of items) {
    const f = validateAiListing(item, opts);
    if (f) out.push(f);
    if (out.length >= 3) break; // защита от разогнавшегося ИИ
  }
  return out;
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
 * Оформить сообщение через DeepSeek: 0–3 заявки (одно сообщение может
 * содержать несколько направлений). Пустой массив — не объявление,
 * пассажирская попутка, ошибка сети или исчерпана квота.
 */
export async function aiExtractListing(env: Env, text: string): Promise<AiFields[]> {
  if (!env.AI_API_KEY) return [];
  if (!(await aiQuotaOk(env))) return [];

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
        max_tokens: 450,
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
      return [];
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content ?? '';
    const parsed = JSON.parse(content) as unknown;
    return parseAiListings(parsed, { now, originalText: text });
  } catch (e) {
    console.error('deepseek call failed', e);
    return [];
  }
}
