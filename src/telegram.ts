import type { Env, Listing, ListingInput, ListingType } from './types';
import { looksLikeListing, parseTelegramMessage, parseDate, normalizeCity } from './parser';
import {
  createListing, getListingById, listPending, markSeen, setSeenListing, updateListingStatus,
} from './store';
import { admins, escapeHtml, normalizeTelegram, sanitizeContact, sanitizeText, tgLink } from './util';

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

function formatListing(l: Listing, sourceNote = ''): string {
  const typeLabel = l.type === 'offer' ? 'Водитель везёт' : 'Нужно передать';
  const parts = [
    `#${l.id.slice(0, 8)} ${typeLabel}`,
    `Маршрут: ${escapeHtml(l.fromCity)} → ${escapeHtml(l.toCity)}`,
  ];
  if (l.departureDate) parts.push(`Дата: ${escapeHtml(l.departureDate)}`);
  const extras: string[] = [];
  if (l.weightKg != null) extras.push(`вес ${l.weightKg} кг`);
  if (l.price) extras.push(`цена ${escapeHtml(l.price)}`);
  if (extras.length) parts.push(`Детали: ${extras.join(' · ')}`);
  parts.push(`Описание: ${escapeHtml(l.description.slice(0, 300))}`);
  if (l.telegram) parts.push(`Контакты: ${escapeHtml(l.telegram)}`);
  if (l.phone) parts.push(`Контакты: ${escapeHtml(l.phone)}`);
  if (l.sourceChat) parts.push(`Источник: ${escapeHtml(l.sourceChat)}`);
  if (sourceNote) parts.push(sourceNote);
  return parts.join('\n');
}

/** Ссылка на исходное сообщение в чате. Для публичных чатов работает как t.me/c/... */
function chatMessageLink(chatId: number, messageId: number): string | null {
  return `https://t.me/c/${chatId.toString().replace(/^-100/, '')}/${messageId}`;
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
      await sendText(env, chatId, '<b>Откуда?</b>\nНапишите город отправления.');
      break;
    case 'to':
      await sendText(env, chatId, '<b>Куда?</b>\nНапишите город назначения.');
      break;
    case 'date':
      await sendText(env, chatId, '<b>Когда?</b>\nНапример: <i>завтра</i>, <i>пятница</i>, <i>15.09</i>. Или просто минус, если дата не важна.');
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
    `Дата: ${d.date ? escapeHtml(d.date) : 'не указана'}`,
    `Описание: ${escapeHtml((d.details ?? '').slice(0, 200))}`,
    `Контакты: ${escapeHtml(d.contact ?? '?')}`,
  ].join('\n');
}

async function sendConfirmation(env: Env, chatId: number, w: WizardState): Promise<void> {
  await sendText(env, chatId, draftSummary(w) + '\n\nОтправьте <b>1</b>, чтобы опубликовать, или <b>2</b>, чтобы отменить.', {
    reply_markup: {
      inline_keyboard: [[
        { text: 'Опубликовать', callback_data: `cfm:${chatId}` },
        { text: 'Отменить', callback_data: 'cancel' },
      ]],
    },
  });
}

/** Разбор сообщения парсером и ответ с результатом (для /parse и пересланных сообщений). */
async function sendParseReport(env: Env, chatId: number, text: string): Promise<void> {
  const p = parseTelegramMessage(text);
  const verdict = looksLikeListing(text) && p.confidence >= 0.7
    ? '✅ бот возьмёт это объявление на модерацию'
    : '❌ бот пропустит это сообщение (не хватает маршрута или слов-признаков)';
  await sendText(env, chatId,
    '<b>Разбор сообщения</b>\n\n' +
    `Маршрут: ${escapeHtml(p.fromCity ?? '—')} → ${escapeHtml(p.toCity ?? '—')}\n` +
    `Тип: ${p.intent === 'offer' ? 'водитель везёт' : p.intent === 'request' ? 'нужно передать' : '—'}\n` +
    `Дата: ${p.departureDate ?? '—'}\n` +
    `Вес: ${p.weightKg != null ? `${String(p.weightKg).replace('.', ',')} кг` : '—'}\n` +
    `Цена: ${p.price ? escapeHtml(p.price) : '—'}\n` +
    `Контакт: ${escapeHtml(p.telegram ?? p.phone ?? '—')}\n` +
    `Уверенность: ${p.confidence}\n\n` +
    verdict
  );
}

async function handlePrivateText(env: Env, msg: TgMessage): Promise<void> {
  const text = (msg.text ?? '').trim();
  const chatId = msg.chat.id;

  // Пересланное из чата сообщение: показываем, как его понимает парсер.
  // Удобно для настройки: переслали реальное объявление — бот ответил разбором.
  if (msg.forward_origin != null || msg.forward_from != null) {
    if (!text) {
      await sendText(env, chatId, 'Переслано без текста — парсер работает только с текстовыми сообщениями.');
      return;
    }
    await sendParseReport(env, chatId, text);
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
          `Привет! Я бот доски попутных передач.\n\n` +
          `• <b>/post</b>: разместить объявление\n` +
          `• <b>/parse</b>: проверить, как я понимаю сообщение из чата (или просто перешлите его мне)\n` +
          `• Добавьте меня в чаты водителей и релокантов: я буду находить объявления и отправлять их на доску\n` +
          `• Сайт: ${site}\n\n<i>Важно: у бота должен быть выключен режим приватности (BotFather → Group Privacy → Off), иначе он не увидит сообщения в группах.</i>`
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
        const pending = await listPending(env, 10);
        if (pending.length === 0) {
          await sendText(env, chatId, 'Очередь модерации пуста.');
          return;
        }
        for (const l of pending.slice(0, 3)) {
          await sendText(env, chatId, formatListing(l, `\n<i>Заявка ${pending.indexOf(l) + 1} из ${pending.length}</i>`), {
            reply_markup: approveKeyboard(l.id),
          });
        }
        if (pending.length > 3) {
          await sendText(env, chatId, `… и ещё ${pending.length - 3}.`);
        }
        break;
      }
      default:
        await sendText(env, chatId, 'Не знаю такую команду. Список команд: /help.');
    }
    return;
  }

  const w = await getWizard(env, chatId);
  if (!w) {
    // Текст без активного мастера: если похоже на объявление, предлагаем /post
    if (looksLikeListing(text)) {
      await sendText(env, chatId, 'Похоже, это объявление. Нажмите /post, чтобы разместить его на доске, я помогу заполнить поля.');
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
      if (w.step === 'from') { draft.from = canonical; w.step = 'to'; }
      else { draft.to = canonical; w.step = 'date'; }
      break;
    }
    case 'date': {
      if (text === '-' || /не важно|без даты/i.test(text)) draft.date = null;
      else {
        draft.date = parseDate(text);
        if (!draft.date) { await sendText(env, chatId, 'Не понял дату. Формат: <i>завтра</i>, <i>пятница</i>, <i>15.09</i>. Или <i>-</i>.'); return; }
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
      await sendText(env, chatId, 'Мы уже на этапе подтверждения. Кнопки выше 👆');
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
    description: d.details,
    telegram: isTg ? contact : null,
    phone: isTg ? null : contact,
    status: env.AUTO_APPROVE === '1' ? 'published' : 'pending',
    source: 'telegram',
    sourceChat: `Личное сообщение боту`,
    sourceChatId: String(chatId),
  };
  const listing = await createListing(env, input);
  await setWizard(env, chatId, null);
  const statusNote =
    input.status === 'published'
      ? '\n<b>Опубликовано.</b> Объявление уже на доске.'
      : '\n<b>Отправлено на модерацию.</b> Администратор одобрит его в ближайшее время.';
  await sendText(env, chatId, formatListing(listing) + statusNote);
  await notifyAdmins(env, listing);
}

/* ------------------------------------------------------------------ */
/* Парсинг групповых сообщений                                          */
/* ------------------------------------------------------------------ */

async function handleGroupText(env: Env, msg: TgMessage): Promise<void> {
  const text = (msg.text ?? '').trim();
  if (!text || text.length < 10 || text.length > 4000) return;
  // Не реагируем на собственные сообщения и ботов
  if (msg.from?.username === env.BOT_USERNAME || msg.from?.is_bot) return;

  const parsed = parseTelegramMessage(text);
  if (parsed.confidence < 0.7) return; // слишком похоже на обычный разговор

  const chatKey = String(msg.chat.id);
  if (!(await markSeen(env, chatKey, msg.message_id))) return; // уже обработано

  const telegram = parsed.telegram ?? (msg.from?.username ? `@${msg.from.username}` : null);
  const sourceChatId = String(msg.chat.id);

  const input: ListingInput = {
    type: parsed.intent ?? 'offer',
    fromCity: parsed.fromCity ?? 'не указано',
    toCity: parsed.toCity ?? 'не указано',
    departureDate: parsed.departureDate,
    weightKg: parsed.weightKg,
    price: parsed.price,
    description: text.slice(0, 2000),
    phone: parsed.phone,
    telegram,
    status: env.AUTO_APPROVE === '1' ? 'published' : 'pending',
    source: 'telegram',
    sourceChat: msg.chat.title ?? null,
    sourceChatId,
    sourceMessageId: msg.message_id,
  };

  let listing: Listing;
  try {
    listing = await createListing(env, input);
    await setSeenListing(env, chatKey, msg.message_id, listing.id);
  } catch (e) {
    // Вернём возможность обработать сообщение при повторной доставке вебхука
    await env.DB.prepare('DELETE FROM tg_seen WHERE chat_id = ? AND message_id = ?')
      .bind(chatKey, msg.message_id).run().catch(() => undefined);
    console.error('create listing from group failed', e);
    return;
  }

  if (env.REPLY_IN_GROUPS === '1') {
    const site = env.SITE_URL?.replace(/\/+$/, '');
    await sendText(env, msg.chat.id,
      `Спасибо! Ваше объявление отправлено на доску${env.AUTO_APPROVE === '1' ? '' : ' (на модерацию)'}.${site ? `\n${site}` : ''}`
    );
  }
  await notifyAdmins(env, listing);
}

export async function notifyAdmins(env: Env, listing: Listing): Promise<void> {
  if (!listing || listing.status !== 'pending') return;
  const link = listing.sourceMessageId
    ? chatMessageLink(Number(listing.sourceChatId), listing.sourceMessageId)
    : null;
  for (const adminId of admins(env)) {
    await sendText(env, Number(adminId),
      formatListing(listing, link ? `Ссылка: <a href="${link}">исходное сообщение</a>` : ''),
      { reply_markup: approveKeyboard(listing.id) }
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
