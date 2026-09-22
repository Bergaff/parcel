import type { Env, Listing, ListingInput, ListingType } from './types';
import { isMultiRoute, looksLikeListing, parseTelegramMessage, parseDate, parseRecurring, normalizeCity, isPassengerOnly, worthAiCheck, findCities } from './parser';
import { formatMatchDigest, pairListings } from './match';
import {
  addReport, createListing, createListingSafe, findByIdPrefix, findRelated, getListingById, listForMatching,
  listPending, markSeen, saveMatchRun, searchByCity, setSeenListing, updateListingStatus,
} from './store';
import {
  admins, dedupeDescription, escapeHtml, isRussianCity, mskTodayIso, normalizeContacts,
  normalizeTelegram, rateLimit, sanitizeContact, sanitizeText, tgLink, uniqueContacts,
} from './util';
import { aiExtractListing, type AiFields } from './ai';
import { currentPeriod, fmtPeriod, fmtPeriodGen } from './format';
import { listMonthStats, refreshStats, statsPostText, type MonthStat } from './stats';

/* ------------------------------------------------------------------ */
/* Минимальные типы Telegram Bot API (без внешних SDK)                  */
/* ------------------------------------------------------------------ */

interface TgUser { id: number; first_name?: string; username?: string; is_bot?: boolean }
interface TgChat { id: number; type: string; title?: string; username?: string }
interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  reply_to_message?: TgMessage;
  /** Признак пересланного сообщения (Bot API: forward_origin). */
  forward_origin?: unknown;
  forward_from?: TgUser;
}
interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  channel_post?: TgMessage;
  callback_query?: TgCallbackQuery;
}

/* ------------------------------------------------------------------ */
/* Вызовы Bot API                                                       */
/* ------------------------------------------------------------------ */

async function api(env: Env, method: string, body: Record<string, unknown>): Promise<unknown> {
  if (!env.BOT_TOKEN) throw new Error('BOT_TOKEN is not set');
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
  if (!res.ok || !json?.ok) {
    console.error(`telegram/${method} failed`, res.status, json?.description);
  }
  return json;
}

/** Сообщение в личке бота от администратора (ADMIN_IDS)? */
function isAdminChat(env: Env, msg: TgMessage): boolean {
  return admins(env).includes(String(msg.from?.id));
}

async function sendText(env: Env, chatId: number, text: string, extra: Record<string, unknown> = {}): Promise<void> {
  await api(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
}

async function answerCallback(env: Env, id: string, text?: string): Promise<void> {
  await api(env, 'answerCallbackQuery', { callback_query_id: id, text });
}

async function editMessageText(env: Env, chatId: number, messageId: number, text: string): Promise<void> {
  await api(env, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  }).catch(() => undefined);
}

function approveKeyboard(listingId: string): Record<string, unknown> {
  return {
    inline_keyboard: [[
      { text: 'Одобрить', callback_data: `appr:${listingId}` },
      { text: 'Отклонить', callback_data: `rej:${listingId}` },
    ]],
  };
}

/* ------------------------------------------------------------------ */
/* Форматирование                                                       */
/* ------------------------------------------------------------------ */

/** Карточка заявки для модератора (и ответ бота в личке). Экспортирована для тестов. */
export function formatListing(l: Listing, sourceNote = ''): string {
  const typeLabel = l.type === 'offer' ? 'Водитель везёт' : 'Нужно передать';
  const parts = [
    `#${l.id.slice(0, 8)} ${typeLabel}`,
    `Маршрут: ${escapeHtml(l.fromCity)} → ${escapeHtml(l.toCity)}`,
  ];
  if (l.departureDate) parts.push(`Дата: ${escapeHtml(l.departureDate)}`);
  // Регулярный рейс («каждый четверг») — отдельной строкой: сразу видно,
  // что заявка не разовая, а дата показывает ближайший заезд
  if (l.recurring) parts.push(`Регулярно: ${escapeHtml(l.recurring)}`);
  const extras: string[] = [];
  if (l.weightKg != null) extras.push(`вес ${l.weightKg} кг`);
  if (l.price) extras.push(`цена ${escapeHtml(l.price)}`);
  if (extras.length) parts.push(`Детали: ${extras.join(' · ')}`);
  parts.push(`Описание: ${escapeHtml(l.description.slice(0, 300))}`);
  // Контакты без дублей: раньше один и тот же номер печатался двумя строками
  const contacts = uniqueContacts(l.telegram, l.phone);
  if (contacts.length) parts.push(`Контакты: ${escapeHtml(contacts.join(', '))}`);
  const srcLink = listingSourceLink(l.sourceChatId, l.sourceMessageId);
  const srcRef = l.sourceChat
    ? (l.sourceChat.startsWith('Переслано от ') ? escapeHtml(l.sourceChat) : `чат «${escapeHtml(l.sourceChat)}»`)
    : '';
  const srcLinkTag = srcLink ? ` — <a href="${srcLink}">исходное сообщение</a>` : '';
  // Чем разобран текст (правилами или ИИ) — внутренняя деталь, людям она не нужна.
  // В карточке остаются только автор пересылки / чат и ссылка на исходное сообщение.
  if (l.sourceChat) parts.push(`Источник: ${srcRef}${srcLinkTag}`);
  if (sourceNote) parts.push(sourceNote);
  return parts.join('\n');
}

/** Ссылка на исходное сообщение в чате (t.me/c/…, открывается у участников).
 *  Есть только у супергрупп и каналов — их id начинается с -100;
 *  пересылки от людей и обычные группы честно остаются без ссылки. */
export function listingSourceLink(
  sourceChatId: string | null | undefined,
  sourceMessageId: number | null | undefined
): string | null {
  if (!sourceChatId) return null;
  const m = /^-100(\d+)$/.exec(sourceChatId);
  if (!m) return null;
  return `https://t.me/c/${m[1]}${sourceMessageId != null ? `/${sourceMessageId}` : ''}`;
}

/* ------------------------------------------------------------------ */
/* Wizard: публикация из лички                                          */
/* ------------------------------------------------------------------ */

interface WizardState {
  authorId?: number;
  authorUsername?: string;
  step: 'type' | 'from' | 'to' | 'date' | 'details' | 'contact' | 'confirm';
  contactMode?: 'tg' | 'phone';
  draft: {
    type?: ListingType;
    from?: string;
    to?: string;
    date?: string | null;
    /** «каждый четверг» — если рейс регулярный, а не разовый. */
    recurring?: string | null;
    details?: string;
    contact?: string;
  };
}

function wizardKey(chatId: number): string {
  return `wizard:${chatId}`;
}

async function getWizard(env: Env, chatId: number): Promise<WizardState | null> {
  const raw = await env.KV.get(wizardKey(chatId));
  if (!raw) return null;
  try { return JSON.parse(raw) as WizardState; } catch { return null; }
}

async function setWizard(env: Env, chatId: number, state: WizardState | null): Promise<void> {
  if (state === null) {
    await env.KV.delete(wizardKey(chatId));
  } else {
    await env.KV.put(wizardKey(chatId), JSON.stringify(state), { expirationTtl: 2 * 86400 });
  }
}

const TYPE_MSG = 'Выберите тип объявления:\n\n1. <b>Водитель везёт</b> (у вас есть место в машине или посылка)\n2. <b>Нужно передать</b> (ищете, кто передаст посылку)\n\nОтправьте 1 или 2, либо <i>/cancel</i>, чтобы отменить.';

async function promptStep(env: Env, chatId: number, w: WizardState): Promise<void> {
  switch (w.step) {
    case 'type':
      await sendText(env, chatId, TYPE_MSG);
      break;
    case 'from':
      await sendText(env, chatId, '<b>Откуда?</b>\nНапишите город отправления — по-русски, например <i>Варшава</i>.');
      break;
    case 'to':
      await sendText(env, chatId, '<b>Куда?</b>\nНапишите город назначения — по-русски, например <i>Минск</i>.');
      break;
    case 'date':
      await sendText(env, chatId, '<b>Когда?</b>\nНапример: <i>завтра</i>, <i>пятница</i>, <i>15.09</i>. Если рейс регулярный — напишите расписание: <i>каждый четверг</i>, <i>по будням</i>, <i>ежедневно</i>. Или просто минус, если дата не важна.');
      break;
    case 'details':
      await sendText(env, chatId, '<b>Опишите посылку и условия</b>\nВес, что за груз, сколько мест, цена. Одним сообщением.');
      break;
    case 'contact': {
      // Способ связи выбирается кнопками (см. handleCallback: contact:*)
      const rows: Array<Array<{ text: string; callback_data: string }>> = [];
      if (w.authorUsername) rows.push([{ text: `Мой юзернейм (@${w.authorUsername})`, callback_data: 'contact:me' }]);
      rows.push([
        { text: 'Другой юзернейм', callback_data: 'contact:other' },
        { text: 'Номер телефона', callback_data: 'contact:phone' },
      ]);
      await sendText(env, chatId, '<b>Как с вами связаться?</b>\nВыберите кнопку — или просто напишите контакт сообщением.', {
        reply_markup: { inline_keyboard: rows },
      });
      break;
    }
    case 'confirm':
      await sendConfirmation(env, chatId, w);
      break;
  }
}

function draftSummary(w: WizardState): string {
  const d = w.draft;
  const typeLabel = d.type === 'offer' ? 'Водитель везёт' : 'Нужно передать';
  return [
    `<b>Проверьте объявление:</b>`,
    `${typeLabel}`,
    `Маршрут: ${escapeHtml(d.from ?? '?')} → ${escapeHtml(d.to ?? '?')}`,
    `Дата: ${d.date ? escapeHtml(d.date) : 'не указана'}${d.recurring ? ` (ближайшая — рейс регулярный, ${escapeHtml(d.recurring)})` : ''}`,
    d.recurring ? `Регулярно: ${escapeHtml(d.recurring)}` : null,
    `Описание: ${escapeHtml((d.details ?? '').slice(0, 200))}`,
    `Контакты: ${escapeHtml(d.contact ?? '?')}`,
  ].filter(Boolean).join('\n');
}

async function sendConfirmation(env: Env, chatId: number, w: WizardState): Promise<void> {
  await sendText(env, chatId, draftSummary(w) + '\n\nОпубликовать — кнопкой выше. Передумали — кнопка «Отменить» или команда /cancel.', {
    reply_markup: {
      inline_keyboard: [[
        { text: 'Опубликовать', callback_data: `cfm:${chatId}` },
        { text: 'Отменить', callback_data: 'cancel' },
      ]],
    },
  });
}

/* ------------------------------------------------------------------ */
/* Поиск по городу: /поиск, /search, /серч                             */
/* ------------------------------------------------------------------ */

const SEARCH_MONTHS = [
  'янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
];

function searchLine(env: Env, l: Listing, today: string): string {
  const site = (env.SITE_URL ?? '').replace(/\/+$/, '');
  const route = site
    ? `<a href="${site}/item/${l.id}">${escapeHtml(l.fromCity)} → ${escapeHtml(l.toCity)}</a>`
    : `${escapeHtml(l.fromCity)} → ${escapeHtml(l.toCity)}`;
  const bits: string[] = [];
  if (l.departureDate) {
    const m = l.departureDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) bits.push(`${parseInt(m[3]!, 10)} ${SEARCH_MONTHS[parseInt(m[2]!, 10) - 1]}`);
    else bits.push(l.departureDate);
  }
  if (l.recurring) bits.push(`↻ ${escapeHtml(l.recurring)}`);
  if (l.weightKg != null) bits.push(`${String(l.weightKg).replace('.', ',')} кг`);
  if (l.price) bits.push(escapeHtml(l.price));
  const contacts = uniqueContacts(l.telegram, l.phone);
  if (contacts.length) bits.push(escapeHtml(contacts.join(', ')));
  // Поездка уже прошла — заявка из архива (ещё месяц доступна, потом удаляется)
  if (l.status === 'expired' || (l.departureDate != null && l.departureDate < today)) bits.push('🗄️ архив');
  return `• ${route}${bits.length ? ' · ' + bits.join(' · ') : ''}`;
}

async function cmdSearch(env: Env, chatId: number, query: string): Promise<void> {
  const raw = query.trim();
  if (raw.length < 2) {
    await sendText(env, chatId,
      'Напишите город после команды:\n<code>/поиск Москва</code> — покажу все заявки в Москву и из Москвы.');
    return;
  }
  // Знакомое латинское написание переводим сами и говорим об этом,
  // незнакомое просим написать кириллицей.
  let q = raw;
  let hint = '';
  if (/[a-z]/i.test(raw)) {
    const normalized = normalizeCity(raw);
    if (isRussianCity(normalized)) {
      q = normalized;
      hint = `Города у нас — по-русски, искал «${escapeHtml(normalized)}».\n\n`;
    } else {
      await sendText(env, chatId,
        '✍️ Города пишите по-русски, кириллицей.\n' +
        'Например: <code>/поиск Варшава</code> или <code>/поиск Минск</code>.');
      return;
    }
  }
  if (!/[а-яё]/i.test(q)) {
    await sendText(env, chatId,
      '✍️ Название города пишите по-русски: <code>/поиск Минск</code>.');
    return;
  }
  const items = await searchByCity(env, q, 40);
  if (items.length === 0) {
    const site = (env.SITE_URL ?? '').replace(/\/+$/, '');
    await sendText(env, chatId,
      `${hint}По запросу «${escapeHtml(q)}» ничего нет.\n` +
      `Загляните на доску позже или разместите своё объявление: /post${site ? `\n${site}` : ''}`);
    return;
  }
  const today = mskTodayIso();
  const offers = items.filter((l) => l.type === 'offer');
  const requests = items.filter((l) => l.type === 'request');
  const chunks: string[] = [`${hint}🔍 <b>${escapeHtml(q)}</b> — заявок: ${items.length}`];
  if (offers.length) {
    chunks.push(`\n🚚 <b>Водители везут (${offers.length}):</b>`);
    for (const l of offers.slice(0, 10)) chunks.push(searchLine(env, l, today));
    if (offers.length > 10) chunks.push(`…и ещё ${offers.length - 10}`);
  }
  if (requests.length) {
    chunks.push(`\n📦 <b>Нужно передать (${requests.length}):</b>`);
    for (const l of requests.slice(0, 10)) chunks.push(searchLine(env, l, today));
    if (requests.length > 10) chunks.push(`…и ещё ${requests.length - 10}`);
  }
  await sendText(env, chatId, chunks.join('\n'));
}

function isSearchCommand(text: string): boolean {
  return /^\/(search|поиск|серч)(@\w+)?(\s|$)/i.test(text);
}

/* ------------------------------------------------------------------ */
/* Жалоба: /репорт, /report, /жалоба                                   */
/* ------------------------------------------------------------------ */

function isReportCommand(text: string): boolean {
  return /^\/(report|репорт|жалоба)(@\w+)?(\s|$)/i.test(text);
}

const REPORT_HINT =
  '<b>Пожаловаться</b>\n\n' +
  '• на объявление — номер заявки или ссылку:\n' +
  '<code>/репорт a1b2c3d4</code> — номер из сообщения бота или «№» на сайте\n' +
  '<code>/репорт https://…/item/…</code> — скопированная ссылка на карточку\n' +
  '• на что угодно другое — просто напишите текстом:\n' +
  '<code>/репорт человек просит предоплату и пропадает</code>';

/** Достаём из аргумента номер заявки: ссылка …/item/<id>, «#a1b2c3d4» или голый id. */
function extractListingId(arg: string): { id: string; reason: string } | null {
  const parts = arg.split(/\s+/);
  const first = (parts[0] ?? '').replace(/^#/, '');
  const link = arg.match(/item\/([0-9a-fA-F-]{4,36})/);
  if (link) {
    return {
      id: link[1]!.toLowerCase(),
      reason: arg.replace(link[0], '').replace(/\s+/g, ' ').trim().slice(0, 500),
    };
  }
  if (/^[0-9a-fA-F-]{4,36}$/.test(first)) {
    return { id: first.toLowerCase(), reason: parts.slice(1).join(' ').slice(0, 500) };
  }
  return null;
}

async function cmdReport(env: Env, msg: TgMessage, query: string): Promise<void> {
  const chatId = msg.chat.id;
  const arg = query.trim();
  if (!arg) {
    await sendText(env, chatId, REPORT_HINT);
    return;
  }

  // Не чаще 5 жалоб в час с одного аккаунта
  const rl = await rateLimit(env, `tg-report:${msg.from?.id ?? chatId}`, 5, 3600);
  if (!rl.allowed) {
    await sendText(env, chatId, 'Слишком много жалоб подряд. Подождите немного и попробуйте снова.');
    return;
  }

  const target = extractListingId(arg);
  if (target) {
    const matches = await findByIdPrefix(env, target.id);
    if (matches.length === 0) {
      await sendText(env, chatId,
        `Заявку с номером «${escapeHtml(target.id)}» не нашёл. ` +
        'На сайте у объявления есть кнопка «скопировать ссылку» — пришлите её.');
      return;
    }
    if (matches.length > 1) {
      await sendText(env, chatId,
        `Под номером «${escapeHtml(target.id)}» несколько заявок. Пришлите полную ссылку на карточку, чтобы я понял, о какой речь.`);
      return;
    }
    const l = matches[0]!;
    const res = await addReport(env, l.id, target.reason || 'жалоба через бота', `telegram:${msg.from?.id ?? chatId}`);
    if (!res.ok) {
      await sendText(env, chatId, 'Эта заявка уже не на доске (в архиве или удалена) — жаловаться не на что.');
      return;
    }
    await notifyAdminsReport(env, l, target.reason || 'жалоба через бота', res.count);
    await sendText(env, chatId,
      res.autoRejected
        ? 'Жалоба принята — объявление скрыто автоматически (набралось 3 жалобы).'
        : `Жалоба на «${escapeHtml(l.fromCity)} → ${escapeHtml(l.toCity)}» отправлена модераторам. Спасибо.`);
    return;
  }

  // Не похоже на номер заявки — свободная жалоба, пересылаем админам как есть
  const text = sanitizeText(arg, 2000);
  if (!text || text.length < 3) {
    await sendText(env, chatId, REPORT_HINT);
    return;
  }
  const from = msg.from;
  const who = [
    from?.first_name ? escapeHtml(from.first_name) : null,
    from?.username ? `@${escapeHtml(from.username)}` : null,
    from ? `id ${from.id}` : null,
  ].filter(Boolean).join(' ');
  const where = msg.chat.type === 'private'
    ? 'личка бота'
    : `${escapeHtml(msg.chat.title ?? msg.chat.type)} (${chatId})`;
  for (const adminId of admins(env)) {
    await sendText(env, Number(adminId),
      `⚠️ <b>Жалоба (не по заявке)</b>\nОт: ${who}\nГде: ${where}\n\n${escapeHtml(text)}`
    ).catch(() => undefined);
  }
  await sendText(env, chatId, 'Передал администраторам, спасибо.');
}

/* ------------------------------------------------------------------ */
/* Связи заявки: /связи, /матч, /match                                  */
/* ------------------------------------------------------------------ */

function relatedDay(iso: string | null | undefined): string {
  if (!iso) return 'без даты';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  return `${parseInt(m[3]!, 10)} ${SEARCH_MONTHS[parseInt(m[2]!, 10) - 1]}`;
}

function relatedLine(l: Listing): string {
  const bits = [
    relatedDay(l.departureDate),
    l.recurring ? `↻ ${l.recurring}` : null,
    l.weightKg != null ? `${String(l.weightKg).replace('.', ',')} кг` : null,
    l.price,
    uniqueContacts(l.telegram, l.phone)[0] ?? null,
    l.status === 'expired' ? 'архив' : null,
    l.status === 'pending' ? 'на модерации' : null,
    `№ ${l.id.slice(0, 8)}`,
  ].filter(Boolean).join(' · ');
  return `• ${escapeHtml(l.fromCity)} → ${escapeHtml(l.toCity)} · ${escapeHtml(bits)}`;
}

/** Связи заявки: встречные рейсы, тот же маршрут, другие заявки автора. */
/**
 * Служебные слова команды /подбор: их нужно вычеркнуть, прежде чем принимать
 * оставшиеся слова за города («с архивом и одним общим городом» — это флаги,
 * а не два города).
 */
const MATCH_ARG_NOISE =
  /(с\s+|и\s+|без\s+)?архив[а-яё]*|(од(ин|ним|ного|ной)\s+(общ[а-яё]*\s+)?город[а-яё]*)|частичн[а-яё]*|неполн[а-яё]*|по\s+городам|окн[а-яё]*|(?<!\d)\d{1,3}\s*(дн|день|дня|дней|days?)[а-яё.]*/gi;

/** Города из аргументов команды: «Варшава Минск», «из Варшавы в Минск», «Варшава». */
export function matchArgCities(args: string): { fromCity: string | null; toCity: string | null } {
  const clean = (args ?? '').trim();
  if (!clean) return { fromCity: null, toCity: null };
  // знакомые города находим в любом падеже — остальное в аргументах игнорируем
  const found = findCities(clean).map((c) => c.city);
  const words = found.length
    ? found
    // незнакомые города: вычеркиваем флаги, дни и предлоги, нормализуем остаток
    : clean
        .replace(MATCH_ARG_NOISE, ' ')
        .split(/[\s,;]+/)
        .filter((w) => w.length > 1 && !/^(из|в|во|до|на|с|со|от|по|и|или|только|без|не|-|—|→)$/i.test(w))
        .map((w) => normalizeCity(w));
  const uniq: string[] = [];
  for (const city of words) {
    if (!city) continue;
    if (!uniq.some((u) => u.toLowerCase() === city.toLowerCase())) uniq.push(city);
  }
  return { fromCity: uniq[0] ?? null, toCity: uniq[1] ?? null };
}

/** Окно по датам из аргументов: «7 дней», «窗口» не поддерживаем — только дни. */
export function matchArgDays(args: string): number {
  const m = /(?<!\d)(\d{1,3})\s*(?:дн|день|дня|дней|days?)/i.exec(args ?? '');
  if (!m) return 3;
  const n = Number(m[1]);
  // «0 дней» — бессмыслица, берём окно по умолчанию; больше месяца не нужно
  if (!Number.isFinite(n) || n <= 0) return 3;
  return Math.min(30, Math.round(n));
}

/** Флаги из аргументов: «с архивом», «и с одним общим городом».
 *  \b с кириллицей не работает (для JS это не «слово»), поэтому границы не ставим. */
export function matchArgFlags(args: string): { includeArchive: boolean; partial: boolean } {
  const text = args ?? '';
  return {
    includeArchive: /архив/i.test(text),
    // «один город», «с одним общим городом», «частично» — в любых падежах
    // \w и \b кириллицу не понимают — только явные классы букв
    partial: /(од(ин|ним|ного|ной)\s+(общ[а-яё]*\s+)?город|частичн|неполн|по городам)/i.test(text),
  };
}

/**
 * /подбор — то же, что кнопка в админке, только из Telegram: сравнить водителей
 * с заявками «нужно передать», прислать сводку и сохранить прогон в историю.
 */
async function cmdMatch(env: Env, msg: TgMessage, args: string): Promise<void> {
  const chatId = msg.chat.id;
  if (!admins(env).includes(String(msg.from?.id))) {
    await sendText(env, chatId, 'Подбор пар — команда администратора.');
    return;
  }
  const { fromCity, toCity } = matchArgCities(args);
  const days = matchArgDays(args);
  const { includeArchive, partial } = matchArgFlags(args);

  const where = fromCity || toCity ? [fromCity, toCity].filter(Boolean).join(' → ') : 'все города';
  await sendText(env, chatId, `🧩 Подбор пар: ${escapeHtml(where)}, окно ${days} дн. Считаю…`).catch(() => undefined);

  const listings = await listForMatching(env, { includeArchive });
  const { pairs, stats } = pairListings(listings, { fromCity, toCity, days, includeArchive, partial, limit: 50 });
  // Прогон сохраняем: история подборов общая и для кнопки в админке, и для команды
  const run = await saveMatchRun(env, {
    fromCity, toCity, daysWindow: days, includeArchive, partial,
    offersTotal: stats.offers, requestsTotal: stats.requests,
    notified: true, note: 'из Telegram: /подбор',
  }, pairs).catch((e) => {
    console.error('saveMatchRun failed', e);
    return null;
  });

  const digest = formatMatchDigest({ fromCity, toCity, days, pairs, stats, siteUrl: env.SITE_URL, maxPairs: 15 });
  for (const part of splitDigest(digest)) {
    await sendText(env, chatId, part).catch(() => undefined);
  }
  if (run) {
    const site = (env.SITE_URL ?? '').replace(/\/+$/, '');
    await sendText(env, chatId,
      `Прогон № ${run.id.slice(0, 8)} сохранён в истории` +
      (site ? ` — открыть в <a href="${site}/admin">админке</a>, вкладка «подбор».` : ' — вкладка «подбор» в админке.')
    ).catch(() => undefined);
  }
}

/**
 * /статистика — итоги месяца готовым текстом для поста в канал.
 *
 * Админ просил «чтобы можно было просто скопировать и опубликовать», поэтому
 * текст приходит одним блоком <pre>: в Telegram он копируется без разметки.
 * Аргументы: «прошлый» — последний закрытый месяц, «force» — пересчитать всё.
 */
async function cmdStats(env: Env, msg: TgMessage, args: string): Promise<void> {
  const chatId = msg.chat.id;
  if (!admins(env).includes(String(msg.from?.id))) {
    await sendText(env, chatId, 'Статистика — команда администратора.');
    return;
  }
  const lower = args.toLowerCase();
  const force = /force|полн|пересчит|заново/.test(lower);
  const wantClosed = /прошл|предыд|закрыт|prev|last/.test(lower);

  await sendText(env, chatId, '📊 Считаю итоги…').catch(() => undefined);

  const res = await refreshStats(env, { force }).catch((e) => {
    console.error('refreshStats failed', e);
    return null;
  });
  const months = res?.months ?? (await listMonthStats(env).catch(() => [] as MonthStat[]));
  if (months.length === 0) {
    await sendText(env, chatId, 'Пока считать нечего: на доске не было опубликованных объявлений.');
    return;
  }

  const current = currentPeriod();
  const stat = wantClosed
    ? months.find((m) => m.month !== current) ?? months[0]!
    : months[0]!;
  const site = (env.SITE_URL ?? '').replace(/\/+$/, '');
  const post = statsPostText(stat, { site: site || undefined, month: stat.month === current ? 'current' : 'past' });

  // <pre> не режем по абзацам: иначе теги разъедутся. Длинный текст — без блока.
  const body = post.length < 3500 ? `<pre>${escapeHtml(post)}</pre>` : escapeHtml(post);
  const head = `📊 ${fmtPeriod(stat.month)}${stat.month === current ? ' (месяц ещё идёт)' : ''}: `
    + `${stat.total} объявлений, ${stat.offers} «везут» и ${stat.requests} «нужно передать». `
    + 'Текст ниже готов к публикации — копируйте как есть.';
  await sendText(env, chatId, `${head}\n\n${body}`).catch(() => undefined);

  const notes: string[] = [];
  if (res) notes.push(`пересчитано месяцев: ${res.saved.length || 'ничего нового'}`);
  if (months.length > 1) notes.push(`всего месяцев в истории: ${months.length}`);
  const bullets = notes.map((n) => `• ${escapeHtml(n)}`);
  if (site) {
    // кликабельно для предпросмотра перед публикацией; ссылка уже в конце поста
    bullets.push(
      `• <a href="${site}/itogi/${stat.month}">итоги ${fmtPeriodGen(stat.month)} на сайте</a> — ссылка уже в конце поста`
    );
  }
  if (bullets.length) {
    await sendText(env, chatId, bullets.join('\n')).catch(() => undefined);
  }
}

async function cmdRelated(env: Env, chatId: number, query: string): Promise<void> {
  const arg = query.trim();
  if (!arg) {
    await sendText(env, chatId,
      'Напишите номер заявки:\n<code>/связи a1b2c3d4</code> — покажу встречные рейсы, тот же маршрут и другие заявки автора.');
    return;
  }
  const target = extractListingId(arg);
  if (!target) {
    await sendText(env, chatId, 'Не понял номер. Пример: <code>/связи a1b2c3d4</code> — номер из сообщения бота или «№» на сайте.');
    return;
  }
  const matches = await findByIdPrefix(env, target.id);
  if (matches.length === 0) {
    await sendText(env, chatId, `Заявку с номером «${escapeHtml(target.id)}» не нашёл.`);
    return;
  }
  if (matches.length > 1) {
    await sendText(env, chatId, `Под номером «${escapeHtml(target.id)}» несколько заявок — пришлите более длинный кусок номера.`);
    return;
  }
  const l = matches[0]!;
  const rel = await findRelated(env, l);
  const chunks: string[] = [`🔗 <b>Заявка:</b> ${escapeHtml(l.fromCity)} → ${escapeHtml(l.toCity)} · ${relatedDay(l.departureDate)} · ${escapeHtml(uniqueContacts(l.telegram, l.phone)[0] ?? 'без контакта')} · № ${l.id.slice(0, 8)}`];
  if (rel.reverse.length) {
    chunks.push(`\n↔ <b>Встречные рейсы (${rel.reverse.length}):</b>`);
    for (const x of rel.reverse) chunks.push(relatedLine(x));
  }
  if (rel.same.length) {
    chunks.push(`\n→ <b>Тот же маршрут, близкие даты (${rel.same.length}):</b>`);
    for (const x of rel.same) chunks.push(relatedLine(x));
  }
  if (rel.sameContact.length) {
    chunks.push(`\n👤 <b>Ещё от этого контакта (${rel.sameContact.length}):</b>`);
    for (const x of rel.sameContact) chunks.push(relatedLine(x));
  }
  if (chunks.length === 1) {
    chunks.push('\nСвязей не нашёл: ни встречных, ни похожих, ни других заявок от этого контакта.');
  }
  await sendText(env, chatId, chunks.join('\n'));
}

/** Разбор сообщения парсером и ответ с результатом (для /parse и пересланных сообщений). */
async function sendParseReport(env: Env, chatId: number, text: string): Promise<void> {
  const p = parseTelegramMessage(text);
  const verdict = isPassengerOnly(text)
    ? '❌ бот пропустит это сообщение (пассажирская попутка — доска только про посылки)'
    : looksLikeListing(text) && p.confidence >= 0.7
      ? '✅ бот возьмёт это объявление на модерацию'
      : '❌ бот пропустит это сообщение (не хватает маршрута или слов-признаков)';
  await sendText(env, chatId,
    '<b>Разбор сообщения</b>\n\n' +
    `Маршрут: ${escapeHtml(p.fromCity ?? '—')} → ${escapeHtml(p.toCity ?? '—')}\n` +
    `Тип: ${p.intent === 'offer' ? 'водитель везёт' : p.intent === 'request' ? 'нужно передать' : '—'}\n` +
    `Дата: ${p.departureDate ?? '—'}\n` +
    `Регулярно: ${p.recurring ? escapeHtml(p.recurring) : '—'}\n` +
    `Вес: ${p.weightKg != null ? `${String(p.weightKg).replace('.', ',')} кг` : '—'}\n` +
    `Цена: ${p.price ? escapeHtml(p.price) : '—'}\n` +
    `Контакт: ${escapeHtml(uniqueContacts(p.telegram, p.phone)[0] ?? '—')}\n` +
    `Уверенность: ${p.confidence}\n\n` +
    verdict
  );
}

/* ------------------------------------------------------------------ */
/* Каскад разбора: правила → при неуверенности ИИ                      */
/* ------------------------------------------------------------------ */

/** Поля заявки из правил парсера. */
function rulesFields(
  parsed: ReturnType<typeof parseTelegramMessage>,
  text: string
): AiFields {
  // Один и тот же контакт не должен лежать в двух полях (дубль строки «Контакты:»)
  const { telegram, phone } = normalizeContacts(parsed.telegram, parsed.phone);
  return {
    type: parsed.intent ?? 'offer',
    fromCity: parsed.fromCity ?? 'не указано',
    toCity: parsed.toCity ?? 'не указано',
    departureDate: parsed.departureDate,
    recurring: parsed.recurring,
    weightKg: parsed.weightKg,
    price: parsed.price,
    telegram,
    phone,
    // Исходный текст модератору нужен дословно — убираем из него только контакты,
    // которые карточка и так показывает отдельной строкой
    description: dedupeDescription(text.slice(0, 2000), { telegram, phone, stripFields: false }),
  };
}

/** Разобрать текст объявления: уверенно правилами, иначе ИИ (DeepSeek).
 *  Одно сообщение может дать НЕСКОЛЬКО заявок (туда-обратно, два рейса) —
 *  такие сообщения всегда уходят ИИ. Пустой список — не объявление. */
async function cascade(
  env: Env,
  text: string
): Promise<{ list: AiFields[]; source: ListingInput['source'] }> {
  const parsed = parseTelegramMessage(text);
  const multi = isMultiRoute(text);
  if (parsed.confidence >= 0.7 && !multi) {
    return { list: [rulesFields(parsed, text)], source: 'telegram' };
  }
  if (env.AI_API_KEY && worthAiCheck(text)) {
    const list = await aiExtractListing(env, text);
    if (list.length > 0) return { list, source: 'parser' };
  }
  // ИИ не задан или не справился — хотя бы одно объявление правилами
  if (parsed.confidence >= 0.7) return { list: [rulesFields(parsed, text)], source: 'telegram' };
  return { list: [], source: 'telegram' };
}

/** Из forward_origin достаём исходный чат/сообщение (для дедупликации),
 *  название источника и @username автора пересланного сообщения. */
function extractForwardOrigin(msg: TgMessage): {
  chatId?: number; messageId?: number; title?: string; authorUsername?: string;
} {
  const o = (msg.forward_origin ?? {}) as Record<string, unknown>;
  const chat = (o.chat ?? null) as Record<string, unknown> | null;
  // автор-человек: обычная пересылка (sender_user) или старое поле forward_from
  const senderUser = (o.sender_user ?? msg.forward_from ?? null) as Record<string, unknown> | null;
  const hiddenName = typeof o.sender_user_name === 'string' ? o.sender_user_name : undefined;
  const chatId = chat && typeof chat.id === 'number' ? chat.id : undefined;
  const messageId = typeof o.message_id === 'number' ? o.message_id : undefined;
  const authorUsername =
    senderUser && typeof senderUser.username === 'string' && senderUser.username
      ? `@${senderUser.username}`
      : undefined;
  const rawAuthorName =
    senderUser && typeof senderUser.first_name === 'string' && senderUser.first_name
      ? senderUser.first_name
      : hiddenName;
  const authorName = rawAuthorName?.replace(/\s+/g, ' ').trim() || undefined;
  const title =
    chat && typeof chat.title === 'string' ? chat.title
    : authorName ? `Переслано от ${authorName}`
    : undefined;
  return { chatId, messageId, title, authorUsername };
}

async function handlePrivateText(env: Env, msg: TgMessage): Promise<void> {
  const text = (msg.text ?? '').trim();
  const chatId = msg.chat.id;

  // Пересланное сообщение → заявка на модерацию. Так объявления попадают
  // на доску даже из чатов, куда бота не добавили: пересылайте их боту.
  if (msg.forward_origin != null || msg.forward_from != null) {
    if (!text) {
      await sendText(env, chatId, 'Переслано без текста — парсер работает только с текстовыми сообщениями.');
      return;
    }
    if (isPassengerOnly(text)) {
      await sendText(env, chatId,
        'Похоже, это пассажирская попутка. Доска «попутка.» — пока только про посылки и вещи.');
      return;
    }
    // Лимит пересылок защищает от флуда посторонних, но админы пересылают
    // объявления пачками по 30–50 штук из чатов за раз — и на 31-й бот
    // отказывался, объявления терялись. Администраторам лимит не мешает.
    const isAdmin = admins(env).includes(String(msg.from?.id));
    if (!isAdmin) {
      const rl = await rateLimit(env, `fwd:${msg.from?.id ?? chatId}`, 30, 3600);
      if (!rl.allowed) {
        await sendText(env, chatId, 'Много пересылок подряд — подождите пару минут и продолжайте.');
        return;
      }
    }
    // Дедупликация: у пересылки поста из канала помним исходный чат+сообщение
    // (тот же ключ, что у обработки в самих чатах — дубль не создастся).
    const origin = extractForwardOrigin(msg);
    const seenChat = origin.chatId != null && origin.messageId != null
      ? String(origin.chatId)
      : `fwd:${chatId}`;
    const seenMsg = origin.messageId ?? msg.message_id;
    if (!(await markSeen(env, seenChat, seenMsg))) {
      await sendText(env, chatId, 'Это сообщение я уже обрабатывал — заявка в очереди модерации или уже на доске.');
      return;
    }
    const { list, source } = await cascade(env, text);
    if (list.length === 0) {
      // Не распозналось — покажем диагностику разбора, как раньше
      await sendParseReport(env, chatId, text);
      return;
    }
    const created: Listing[] = [];
    const repeats: Repeat[] = [];
    for (const fields of list) {
      const input: ListingInput = {
        ...fields,
        // контакт — автор сообщения (из forward-данных), а не тот, кто переслал
        telegram: fields.telegram ?? origin.authorUsername ?? null,
        status: env.AUTO_APPROVE === '1' ? 'published' : 'pending',
        source,
        sourceChat: origin.title ?? 'Пересланное сообщение',
        sourceChatId: seenChat,
        sourceMessageId: origin.messageId ?? null,
        byAdmin: isAdmin,
      };
      // Пересылку админа дедуплицируем как раньше (одно и то же объявление
      // пересылают каждый день — вторую заявку не плодим). Пересылку от
      // постороннего человека — нет: возможно, владелец подал сам, а копию
      // мы уже принесли из чата; тогда заявку создаём и показываем конфликт.
      const res = await createListingSafe(env, input, { force: !isAdmin });
      if (!res.created) {
        repeats.push({ listing: res.listing, why: res.why });
        await notifyAdminsRepeat(env, res.listing, res.why);
        continue;
      }
      created.push(res.listing);
      await notifyAdmins(env, res.listing, res.duplicateOf
        ? { id: res.duplicateOf.id, why: res.why, selfSubmitted: !isAdmin }
        : similarNote(res));
      if (res.duplicateOf && res.listing.status !== 'pending') {
        await notifyAdminsConflict(env, res.listing, res.duplicateOf, res.why);
      }
    }
    if (created.length === 0) {
      await sendText(env, chatId, repeatReply(repeats));
      return;
    }
    const statusNote = env.AUTO_APPROVE === '1'
      ? '\n<b>Опубликовано.</b> Объявление уже на доске.'
      : '\n<b>Отправлено на модерацию.</b> Проверю и опубликую в ближайшее время.';
    await sendText(env, chatId,
      created.map((l) => formatListing(l)).join('\n\n') + statusNote +
      (repeats.length ? `\n\n${repeatReply(repeats)}` : ''));
    return;
  }

  if (text.startsWith('/')) {
    const parts = text.split(/\s+/);
    const cmd = parts[0]!.split('@')[0]!.toLowerCase();
    switch (cmd) {
      case '/start':
      case '/help': {
        const site = env.SITE_URL ?? 'ваш сайт';
        await sendText(env, chatId,
          `Привет! Я бот доски попутных передач посылок.\n\n` +
          `• <b>/post</b>: разместить объявление\n` +
          `• <b>/поиск город</b>: заявки по городу — что везут и что нужно передать (город — по-русски)\n` +
          `• <b>/репорт</b>: пожаловаться на объявление (номер или ссылка) или на что угодно другое\n` +
          `• <b>/связи номер</b>: встречные рейсы и похожие заявки — полезно владельцам чатов\n` +
          `• <b>/подбор</b> (для администратора): найти пары «водитель везёт» ↔ «нужно передать»; можно сузить городами и окном по датам: <code>/подбор Варшава Минск 7 дней</code>\n` +
          `• <b>/статистика</b> (для администратора): итоги месяца — сколько объявлений, какие направления и средняя цена; текст готов к публикации в канале\n` +
          `• Заявки с прошедшей датой уходят в архив на месяц — видны в /поиск, потом удаляются\n` +
          `• <b>/parse</b>: проверить, как я понимаю сообщение из чата (или просто перешлите его мне)\n` +
          `• Добавьте меня в чаты водителей и релокантов: я буду находить объявления и отправлять их на доску\n` +
          `• Сайт: ${site}`
        );
        await setWizard(env, chatId, null);
        break;
      }
      case '/post': {
        const wizard: WizardState = {
          step: 'type',
          draft: {},
          authorId: msg.from?.id,
          authorUsername: msg.from?.username,
        };
        await setWizard(env, chatId, wizard);
        await promptStep(env, chatId, wizard);
        break;
      }
      case '/cancel':
        await setWizard(env, chatId, null);
        await sendText(env, chatId, 'Отменено.');
        break;
      case '/parse': {
        // Диагностика парсера: вставьте реальное сообщение из чата — бот покажет,
        // что он из него извлекёт и возьмёт ли на модерацию.
        const rest = text.split(/\s+/).slice(1).join(' ');
        if (!rest) {
          await sendText(env, chatId,
            'Пришлите сообщение для проверки сразу после команды:\n' +
            '<code>/parse Варшава — Львов, завтра, возьму посылку до 10 кг, 100 zł</code>\n\n' +
            'Или просто перешлите боту любое сообщение из чата — он разберёт его так же.');
          break;
        }
        await sendParseReport(env, chatId, rest);
        break;
      }
      case '/pending': {
        if (!admins(env).includes(String(msg.from?.id))) {
          await sendText(env, chatId, 'Команда доступна только администраторам.');
          return;
        }
        const pending = await listPending(env, 100);
        if (pending.length === 0) {
          await sendText(env, chatId, '✅ Необработанных заявок нет — очередь модерации пуста.');
          return;
        }
        await sendText(env, chatId,
          `⏳ Необработано заявок: <b>${pending.length}</b>` +
          (pending.length > 10 ? '\nПоказаны последние 10 — разберите их и напишите /pending снова.' : ''));
        for (const [i, l] of pending.slice(-10).entries()) {
          await sendText(env, chatId,
            formatListing(l, `\n<i>Заявка ${i + 1} из ${pending.length}</i>`),
            { reply_markup: approveKeyboard(l.id) }
          );
        }
        break;
      }
      case '/search':
      case '/поиск':
      case '/серч': {
        await cmdSearch(env, chatId, text.split(/\s+/).slice(1).join(' '));
        break;
      }
      case '/report':
      case '/репорт':
      case '/жалоба': {
        await cmdReport(env, msg, text.split(/\s+/).slice(1).join(' '));
        break;
      }
      case '/связи':
      case '/матч':
      case '/match':
      case '/links': {
        await cmdRelated(env, chatId, text.split(/\s+/).slice(1).join(' '));
        break;
      }
      case '/подбор':
      case '/подборы':
      case '/пары':
      case '/podbor': {
        await cmdMatch(env, msg, text.split(/\s+/).slice(1).join(' '));
        break;
      }
      case '/статистика':
      case '/стата':
      case '/итоги':
      case '/stats': {
        await cmdStats(env, msg, text.split(/\s+/).slice(1).join(' '));
        break;
      }
      default:
        await sendText(env, chatId, 'Не знаю такую команду. Список команд: /help.');
    }
    return;
  }

  const w = await getWizard(env, chatId);
  if (!w) {
    // Пассажирские попутки — вежливо отказываем (доска только про посылки)
    if (isPassengerOnly(text)) {
      await sendText(env, chatId,
        'Похоже, это пассажирская попутка. Доска «попутка.» — пока только про посылки и вещи.\n' +
        'Если нужно что-то передать — напишите объявление сюда одним сообщением, я оформлю.');
      return;
    }
    // Текст без активного мастера: пробуем оформить сразу —
    // сначала правилами, затем ИИ (если задан AI_API_KEY).
    if (looksLikeListing(text) || worthAiCheck(text)) {
      const parsed = parseTelegramMessage(text);
      let created: Listing[] = [];
      const repeats: Repeat[] = [];
      if (parsed.confidence >= 0.7 || (env.AI_API_KEY && worthAiCheck(text))) {
        if (await markSeen(env, String(chatId), msg.message_id)) {
          const { list, source } = await cascade(env, text);
          for (const fields of list) {
            const input: ListingInput = {
              ...fields,
              telegram: fields.telegram ?? (msg.from?.username ? `@${msg.from.username}` : null),
              status: env.AUTO_APPROVE === '1' ? 'published' : 'pending',
              source,
              sourceChat: 'Личное сообщение боту',
              sourceChatId: String(chatId),
              sourceMessageId: msg.message_id,
              byAdmin: isAdminChat(env, msg),
            };
            // от постороннего человека дубль не сливаем — см. блок пересылок
            const fromAdmin = isAdminChat(env, msg);
            const res = await createListingSafe(env, input, { force: !fromAdmin });
            if (!res.created) {
              repeats.push({ listing: res.listing, why: res.why });
              await notifyAdminsRepeat(env, res.listing, res.why);
              continue;
            }
            created.push(res.listing);
            await notifyAdmins(env, res.listing, res.duplicateOf
              ? { id: res.duplicateOf.id, why: res.why, selfSubmitted: !fromAdmin }
              : similarNote(res));
            if (res.duplicateOf && res.listing.status !== 'pending') {
              await notifyAdminsConflict(env, res.listing, res.duplicateOf, res.why);
            }
          }
          if (created.length > 0) {
            const statusNote = env.AUTO_APPROVE === '1'
              ? '\n<b>Опубликовано.</b> Объявление уже на доске.'
              : '\n<b>Отправлено на модерацию.</b> Проверю и опубликую в ближайшее время.';
            await sendText(env, chatId,
              created.map((l) => formatListing(l)).join('\n\n') + statusNote +
              (repeats.length ? `\n\n${repeatReply(repeats)}` : ''));
            return;
          }
          if (repeats.length > 0) {
            await sendText(env, chatId, repeatReply(repeats));
            return;
          }
        }
      }
      if (looksLikeListing(text)) {
        await sendText(env, chatId,
          'Похоже, это объявление, но целиком я его не разобрал. Нажмите /post — проведу по шагам.');
        return;
      }
    }
    return;
  }

  const draft = w.draft;
  switch (w.step) {
    case 'type': {
      if (text === '1' || /водител/i.test(text)) draft.type = 'offer';
      else if (text === '2' || /передат/i.test(text)) draft.type = 'request';
      else { await sendText(env, chatId, 'Отправьте <b>1</b> или <b>2</b>.'); return; }
      w.step = 'from';
      break;
    }
    case 'from':
    case 'to': {
      const city = text.replace(/[^\p{L}\- ]/gu, ' ').trim();
      if (/\d/.test(text)) { await sendText(env, chatId, 'В названии города не может быть цифр. Попробуйте ещё раз.'); return; }
      if (city.length < 2 || city.length > 60) { await sendText(env, chatId, 'Похоже, это не город. Попробуйте ещё раз.'); return; }
      // Любое написание (Warsaw, warsawa, Варшаве) → каноническое «Варшава»
      const canonical = normalizeCity(city);
      // Латиницу перевести не смогли — просим по-русски
      if (!isRussianCity(canonical)) {
        await sendText(env, chatId,
          '✍️ Город пишите по-русски, кириллицей: например <i>Варшава</i>, а не Warsaw. Попробуйте ещё раз.');
        return;
      }
      if (w.step === 'from') { draft.from = canonical; w.step = 'to'; }
      else { draft.to = canonical; w.step = 'date'; }
      break;
    }
    case 'date': {
      if (text === '-' || /не важно|без даты/i.test(text)) { draft.date = null; draft.recurring = null; }
      else {
        // «каждый четверг» / «по будням» — рейс регулярный: запоминаем
        // расписание, датой ставим ближайший заезд
        draft.recurring = parseRecurring(text);
        draft.date = parseDate(text);
        if (!draft.date && !draft.recurring) { await sendText(env, chatId, 'Не понял дату. Формат: <i>завтра</i>, <i>пятница</i>, <i>15.09</i>. Для регулярного рейса: <i>каждый четверг</i>, <i>ежедневно</i>. Или <i>-</i>.'); return; }
      }
      w.step = 'details';
      break;
    }
    case 'details': {
      if (text.length < 5) { await sendText(env, chatId, 'Опишите чуть подробнее, хотя бы пару слов.'); return; }
      draft.details = text.slice(0, 2000);
      w.step = 'contact';
      break;
    }
    case 'contact': {
      // Режим выбран кнопкой (contact:other / contact:phone) или юзер пишет сразу
      if (w.contactMode === 'tg') {
        const username = text.replace(/^@/, '').trim();
        if (!/^[a-zA-Z0-9_]{4,32}$/.test(username)) {
          await sendText(env, chatId, 'Юзернейм — 4–32 символа, латиница/цифры/подчёркивание. Можно без <code>@</code>.');
          return;
        }
        draft.contact = `@${username}`;
      } else if (w.contactMode === 'phone') {
        const phone = sanitizeContact(text);
        if (!phone || phone.startsWith('@')) {
          await sendText(env, chatId, 'Пришлите номер телефона, например <code>+48 123 456 789</code>.');
          return;
        }
        draft.contact = phone;
      } else {
        // Кнопку не нажимали — попробуем понять сам текст, иначе снова покажем кнопки
        const contact = sanitizeContact(text);
        if (!contact) { await promptStep(env, chatId, w); return; }
        draft.contact = contact;
      }
      w.contactMode = undefined;
      w.step = 'confirm';
      break;
    }
    case 'confirm': {
      await sendText(env, chatId, 'Мы уже на этапе подтверждения. Кнопки выше 👆\nЕсли передумали — /cancel, всё отменится и черновик удалится.');
      return;
    }
  }
  await setWizard(env, chatId, w);
  await promptStep(env, chatId, w);
}

async function finalizeWizard(env: Env, chatId: number, w: WizardState): Promise<void> {
  const d = w.draft;
  if (!d.type || !d.from || !d.to || !d.details || !d.contact) {
    await sendText(env, chatId, 'Что-то пошло не так. Начните заново: /post');
    await setWizard(env, chatId, null);
    return;
  }
  const contact = normalizeTelegram(d.contact);
  const isTg = contact.startsWith('@') || contact.includes('t.me/');
  const input: ListingInput = {
    type: d.type,
    fromCity: d.from,
    toCity: d.to,
    departureDate: d.date,
    recurring: d.recurring ?? null,
    description: d.details,
    telegram: isTg ? contact : null,
    phone: isTg ? null : contact,
    status: env.AUTO_APPROVE === '1' ? 'published' : 'pending',
    source: 'telegram',
    sourceChat: `Личное сообщение боту`,
    sourceChatId: String(chatId),
    byAdmin: admins(env).includes(String(chatId)),
  };
  // /post человек заполняет сам, шаг за шагом, — заявку создаём в любом случае,
  // но если такая уже есть, предупреждаем и его, и модератора.
  const res = await createListingSafe(env, input, { force: true });
  const listing = res.listing;
  await setWizard(env, chatId, null);
  const statusNote =
    input.status === 'published'
      ? '\n<b>Опубликовано.</b> Объявление уже на доске.'
      : '\n<b>Отправлено на модерацию.</b> Администратор одобрит его в ближайшее время.';
  const dupNote = res.duplicateOf
    ? `\n\n<i>⚠ Похоже, такая заявка уже есть: №${res.duplicateOf.id.slice(0, 8)} (${escapeHtml(res.why)}). Модератор это увидит.</i>`
    : '';
  await sendText(env, chatId, formatListing(listing) + statusNote + dupNote);
  await notifyAdmins(env, listing, res.duplicateOf
    ? { id: res.duplicateOf.id, why: res.why, selfSubmitted: !input.byAdmin }
    : null);
}

/* ------------------------------------------------------------------ */
/* Парсинг групповых сообщений                                          */
/* ------------------------------------------------------------------ */

async function handleGroupText(env: Env, msg: TgMessage): Promise<void> {
  const text = (msg.text ?? '').trim();
  if (!text) return;
  // Не реагируем на собственные сообщения и ботов
  if (msg.from?.username === env.BOT_USERNAME || msg.from?.is_bot) return;

  // /поиск, /search, /серч работают и в группах
  if (isSearchCommand(text)) {
    await cmdSearch(env, msg.chat.id, text.split(/\s+/).slice(1).join(' '));
    return;
  }
  // /репорт, /report, /жалоба — тоже
  if (isReportCommand(text)) {
    await cmdReport(env, msg, text.split(/\s+/).slice(1).join(' '));
    return;
  }
  if (text.length < 10 || text.length > 4000) return;

  // Доска — про посылки: пассажирские попутки («Пассажир. Гродно-Минск»,
  // «кто подвезёт до…») пропускаем молча. Водители остаются.
  if (isPassengerOnly(text)) return;

  const chatKey = String(msg.chat.id);
  const sourceChatId = String(msg.chat.id);

  // Каскад: уверенно правилами (бесплатно), иначе ИИ. Болтовню — нет
  // уверенности правил и нечего послать ИИ — пропускаем молча.
  const parsed = parseTelegramMessage(text);
  if (parsed.confidence < 0.7 && !(env.AI_API_KEY && worthAiCheck(text))) return;
  if (!(await markSeen(env, chatKey, msg.message_id))) return; // уже обработано

  const { list, source } = await cascade(env, text);
  if (list.length === 0) return; // ИИ не признал объявлением — мимо

  const created: Listing[] = [];
  const repeats: Repeat[] = [];
  const similarBy = new Map<string, { id: string; why: string }>();
  for (const fields of list) {
    const telegram = fields.telegram ?? (msg.from?.username ? `@${msg.from.username}` : null);
    const input: ListingInput = {
      ...fields,
      telegram,
      status: env.AUTO_APPROVE === '1' ? 'published' : 'pending',
      source,
      sourceChat: msg.chat.title ?? null,
      sourceChatId,
      sourceMessageId: msg.message_id,
    };
    try {
      const res = await createListingSafe(env, input);
      if (!res.created) {
        // Повтор в чате: в группе не шумим, модератору сообщаем лично
        repeats.push({ listing: res.listing, why: res.why });
        await notifyAdminsRepeat(env, res.listing, res.why);
        continue;
      }
      const listing = res.listing;
      created.push(listing);
      await setSeenListing(env, chatKey, msg.message_id, listing.id);
      const note = similarNote(res);
      if (note) similarBy.set(listing.id, note);
    } catch (e) {
      // Вернём возможность обработать сообщение при повторной доставке вебхука
      // (если не создано ни одной заявки — иначе повтор даст дубль)
      if (created.length === 0) {
        await env.DB.prepare('DELETE FROM tg_seen WHERE chat_id = ? AND message_id = ?')
          .bind(chatKey, msg.message_id).run().catch(() => undefined);
      }
      console.error('create listing from group failed', e);
      break;
    }
  }
  if (created.length === 0) return;

  if (env.REPLY_IN_GROUPS === '1') {
    const site = env.SITE_URL?.replace(/\/+$/, '');
    await sendText(env, msg.chat.id,
      `Спасибо! Ваше объявление отправлено на доску${env.AUTO_APPROVE === '1' ? '' : ' (на модерацию)'}.${site ? `\n${site}` : ''}`
    );
  }
  // Карточки модератору — по одной на заявку (с предупреждением, если похоже на дубль)
  for (const listing of created) {
    await notifyAdmins(env, listing, similarBy.get(listing.id) ?? null);
  }
}

/** Повтор: такое объявление уже есть, новую заявку не создавали. */
export interface Repeat {
  listing: Listing;
  why: string;
}

/** Предупреждение модератору о «похожей» заявке: создали, но пусть проверит. */
function similarNote(res: {
  kind: string | null;
  why: string;
  duplicateOf: Listing | null;
}): { id: string; why: string } | null {
  return res.kind === 'similar' && res.duplicateOf ? { id: res.duplicateOf.id, why: res.why } : null;
}

function listingLine(l: Listing): string {
  return `№${l.id.slice(0, 8)} · ${escapeHtml(l.fromCity)} → ${escapeHtml(l.toCity)}` +
    (l.departureDate ? ` · ${l.departureDate}` : '');
}

/** Ответ человеку: объявление уже на доске, дубль не создан. */
function repeatReply(repeats: Repeat[]): string {
  const published = repeats.some(({ listing }) => listing.status === 'published');
  const lines = repeats.map(({ listing, why }) => `${listingLine(listing)}\n${escapeHtml(why)}`);
  return '♻️ <b>Такое объявление уже есть на доске</b> — дубль создавать не стал' +
    (published ? ', освежил его (заявка снова вверху списка).' : '.') +
    `\n\n${lines.join('\n\n')}` +
    '\n\nЕсли это другой человек или другой рейс — добавьте отдельно: /post.';
}

/** Короткая заметка модератору: пришёл повтор, дубль не создан. */
export async function notifyAdminsRepeat(env: Env, listing: Listing, why: string): Promise<void> {
  const site = (env.SITE_URL ?? '').replace(/\/+$/, '');
  const link = site ? ` — <a href="${site}/item/${listing.id}">открыть</a>` : '';
  const refreshed = listing.status === 'published' ? ' Освежил: заявка снова вверху доски.' : '';
  for (const adminId of admins(env)) {
    await sendText(env, Number(adminId),
      `♻️ <b>Повтор, дубль не создавал</b>\n${listingLine(listing)}${link}\n` +
      `<b>Почему:</b> ${escapeHtml(why)}.${refreshed}`
    ).catch(() => undefined);
  }
}

/**
 * Карточка на модерацию. `dup` — если такая заявка уже есть: модератор видит
 * предупреждение до того, как нажмёт «Одобрить». `selfSubmitted` — заявку
 * подал сам человек (сайт или личка бота, не админ): это конфликт «владелец
 * подал сам, а копию уже принесли из чата», в очереди есть «заменить старую».
 */
export async function notifyAdmins(
  env: Env,
  listing: Listing,
  dup?: { id: string; why: string; selfSubmitted?: boolean } | null
): Promise<void> {
  if (!listing || listing.status !== 'pending') return;
  // У пересылок от людей со скрытым профилем контакта не бывает: модератор
  // дописывает его вручную в админке — даём ссылку прямо в карточке.
  const site = (env.SITE_URL ?? '').replace(/\/+$/, '');
  const editLink = site ? `, дописать в <a href="${site}/admin">админке</a>` : ' — допишите вручную в админке';
  const noContact = uniqueContacts(listing.telegram, listing.phone).length === 0
    ? `\n<i>⚠ Контакта нет (автор пересылки мог скрыть профиль)${editLink}</i>`
    : '';
  const dupNote = dup && dup.id
    ? (dup.selfSubmitted
        ? `\n<i>🗂 Человек подал сам (${listing.source === 'site' ? 'с сайта' : 'в личке бота'}), а похожая заявка уже есть: №${dup.id.slice(0, 8)} — ${escapeHtml(dup.why)}.</i>\n<i>Если это владелец — в очереди модерации нажмите «заменить старую»: старая удалится, эта опубликуется.</i>`
        : `\n<i>⚠ Похоже на дубль: №${dup.id.slice(0, 8)} — ${escapeHtml(dup.why)}</i>`)
    : '';
  for (const adminId of admins(env)) {
    // ссылка на исходное сообщение (если есть) — уже внутри formatListing
    await sendText(env, Number(adminId),
      formatListing(listing, noContact + dupNote),
      { reply_markup: approveKeyboard(listing.id) }
    ).catch(() => undefined);
  }
}

/**
 * Конфликт при автопубликации: человек подал сам, похожая уже была, и новая
 * сразу оказалась на доске (AUTO_APPROVE=1). Карточки модерации нет —
 * пишем короткую сводку, чтобы админ удалил старую руками.
 */
export async function notifyAdminsConflict(
  env: Env,
  listing: Listing,
  old: Listing,
  why: string
): Promise<void> {
  const site = (env.SITE_URL ?? '').replace(/\/+$/, '');
  const link = site ? ` — <a href="${site}/item/${listing.id}">открыть</a>` : '';
  const oldLabel = old.status === 'published' ? 'на доске' : old.status === 'pending' ? 'в очереди' : 'в архиве';
  for (const adminId of admins(env)) {
    await sendText(env, Number(adminId),
      `🗂 <b>Человек подал сам</b> (${listing.source === 'site' ? 'с сайта' : 'в личке бота'}), а похожая заявка уже есть.\n` +
      `${listingLine(listing)}${link}\n` +
      `Старая — №${old.id.slice(0, 8)} (${oldLabel}): ${escapeHtml(why)}.\n` +
      `Новая уже на доске (автопубликация). Если это владелец — старую стоит удалить: админка, вкладка «на доске».`
    ).catch(() => undefined);
  }
}

/** Уведомление администраторов о жалобе на объявление (с кнопкой «Скрыть»). */
export async function notifyAdminsReport(env: Env, listing: Listing, reason: string | null, count: number): Promise<void> {
  if (!listing) return;
  const header = count >= 3
    ? '🚫 <b>Объявление скрыто автоматически</b> (3 жалобы)'
    : `⚠️ <b>Жалоба на объявление</b> (${count}/3)`;
  for (const adminId of admins(env)) {
    await sendText(env, Number(adminId),
      header + '\n\n' + formatListing(listing) +
      (reason ? `\n<b>Причина:</b> ${escapeHtml(reason.slice(0, 300))}` : ''),
      {
        reply_markup: {
          inline_keyboard: [[
            { text: 'Скрыть объявление', callback_data: `rej:${listing.id}` },
          ]],
        },
      }
    ).catch(() => undefined);
  }
}

/**
 * Отправить готовую HTML-сводку всем админам (например, результат подбора пар
 * «водитель ↔ нужно передать»). Режем на части: лимит сообщения Telegram — 4096 символов.
 */
export async function notifyAdminsDigest(env: Env, html: string): Promise<void> {
  const text = (html ?? '').trim();
  if (!text) return;
  const parts = splitDigest(text, 3800);
  for (const adminId of admins(env)) {
    for (const part of parts) {
      await sendText(env, Number(adminId), part).catch(() => undefined);
    }
  }
}

/** Разбить длинный текст на сообщения по пустым строкам (блоки не рвём). */
export function splitDigest(text: string, max = 3800): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = '';
  for (const block of text.split('\n\n')) {
    const piece = cur ? `${cur}\n\n${block}` : block;
    if (piece.length <= max) { cur = piece; continue; }
    if (cur) out.push(cur);
    // Один блок длиннее лимита — режем жёстко
    if (block.length > max) {
      for (let i = 0; i < block.length; i += max) out.push(block.slice(i, i + max));
      cur = '';
    } else {
      cur = block;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/* ------------------------------------------------------------------ */
/* Callback queries                                                     */
/* ------------------------------------------------------------------ */

async function handleCallback(env: Env, cb: TgCallbackQuery): Promise<void> {
  const data = cb.data ?? '';
  const userId = cb.from.id;
  const isAdmin = admins(env).includes(String(userId));

  // Выбор способа контакта в мастере /post (шаг «contact»)
  if (data === 'contact:me' || data === 'contact:other' || data === 'contact:phone') {
    const chatId = cb.message?.chat.id;
    if (!chatId) { await answerCallback(env, cb.id, 'Сообщение устарело, начните заново: /post'); return; }
    const w = await getWizard(env, chatId);
    if (!w || w.step !== 'contact') { await answerCallback(env, cb.id, 'Начните заново: /post'); return; }

    if (data === 'contact:me') {
      if (!w.authorUsername) {
        await answerCallback(env, cb.id, 'У вас не задан юзернейм в Telegram');
        await sendText(env, chatId, 'В вашем аккаунте нет юзернейма. Введите другой юзернейм или телефон.');
        return;
      }
      w.draft.contact = `@${w.authorUsername}`;
      w.contactMode = undefined;
      w.step = 'confirm';
      await setWizard(env, chatId, w);
      await answerCallback(env, cb.id, 'Юзернейм выбран');
      await editMessageText(env, chatId, cb.message!.message_id, `Контакт: @${w.authorUsername}`);
      await promptStep(env, chatId, w);
      return;
    }

    w.contactMode = data === 'contact:other' ? 'tg' : 'phone';
    await setWizard(env, chatId, w);
    await answerCallback(env, cb.id, '');
    await editMessageText(env, chatId, cb.message!.message_id,
      w.contactMode === 'tg'
        ? 'Отправьте юзернейм Telegram (можно без <code>@</code>).'
        : 'Отправьте номер телефона, например <code>+48 123 456 789</code>.');
    return;
  }

  if (data === 'cancel') {
    await setWizard(env, cb.message?.chat.id ?? 0, null);
    await answerCallback(env, cb.id, 'Отменено');
    if (cb.message?.message_id) {
      await api(env, 'editMessageText', {
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        text: 'Отменено.',
      });
    }
    return;
  }

  const appr = data.match(/^appr:(.+)$/);
  const rej = data.match(/^rej:(.+)$/);
  if (appr || rej) {
    if (!isAdmin) {
      await answerCallback(env, cb.id, 'Только администратор может это делать');
      return;
    }
    const id = (appr ?? rej)![1]!;
    const status = appr ? 'published' : 'rejected';
    await updateListingStatus(env, id, status);
    await answerCallback(env, cb.id, appr ? 'Одобрено' : 'Отклонено');
    if (cb.message?.message_id) {
      await api(env, 'editMessageReplyMarkup', {
        chat_id: cb.message.chat.id,
        message_id: cb.message.message_id,
        reply_markup: undefined,
      });
    }
    if (appr) {
      const listing = await getListingById(env, id);
      if (listing) {
        for (const adminId of admins(env)) {
          await sendText(env, Number(adminId), `Опубликовано на доске:\n${formatListing(listing)}`);
        }
      }
    }
    return;
  }

  const cfm = data.match(/^cfm:(\d+)$/);
  if (cfm) {
    const chatId = Number(cfm[1]!);
    const w = await getWizard(env, chatId);
    if (!w || w.step !== 'confirm') {
      await answerCallback(env, cb.id, 'Сессия не найдена');
      return;
    }
    if (cb.message?.chat.id !== chatId || (w.authorId !== undefined && w.authorId !== userId && !isAdmin)) {
      await answerCallback(env, cb.id, 'Публикация доступна только автору');
      return;
    }
    await finalizeWizard(env, chatId, w);
    await answerCallback(env, cb.id, 'Готово');
    return;
  }
}

/* ------------------------------------------------------------------ */
/* Точка входа                                                          */
/* ------------------------------------------------------------------ */

export async function handleTelegramUpdate(env: Env, update: TgUpdate): Promise<{ ok: boolean }> {
  try {
    if (update.message) {
      const msg = update.message;
      if (msg.chat.type === 'private') await handlePrivateText(env, msg);
      else await handleGroupText(env, msg);
    } else if (update.channel_post) {
      await handleGroupText(env, update.channel_post);
    } else if (update.callback_query) {
      await handleCallback(env, update.callback_query);
    }
    return { ok: true };
  } catch (e) {
    console.error('telegram update failed', e);
    return { ok: false };
  }
}
