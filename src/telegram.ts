import type { Env, Listing, ListingInput, ListingType } from './types';
import { looksLikeListing, parseTelegramMessage, parseDate } from './parser';
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

function approveKeyboard(listingId: string): Record<string, unknown> {
  return {
    inline_keyboard: [[
      { text: '✅ Одобрить', callback_data: `appr:${listingId}` },
      { text: '❌ Отклонить', callback_data: `rej:${listingId}` },
    ]],
  };
}

/* ------------------------------------------------------------------ */
/* Форматирование                                                       */
/* ------------------------------------------------------------------ */

function formatListing(l: Listing, sourceNote = ''): string {
  const typeLabel = l.type === 'offer' ? '🚚 Водитель везёт' : '📦 Нужно передать';
  const parts = [
    `#${l.id.slice(0, 8)} ${typeLabel}`,
    `📍 ${escapeHtml(l.fromCity)} → ${escapeHtml(l.toCity)}`,
  ];
  if (l.departureDate) parts.push(`🗓 ${escapeHtml(l.departureDate)}`);
  const extras: string[] = [];
  if (l.weightKg != null) extras.push(`${l.weightKg} кг`);
  if (l.price) extras.push(escapeHtml(l.price));
  if (extras.length) parts.push(`⚖️ ${extras.join(' · ')}`);
  parts.push(`📝 ${escapeHtml(l.description.slice(0, 300))}`);
  if (l.telegram) parts.push(`✉️ ${escapeHtml(l.telegram)}`);
  if (l.phone) parts.push(`📞 ${escapeHtml(l.phone)}`);
  if (l.sourceChat) parts.push(`📡 Источник: ${escapeHtml(l.sourceChat)}`);
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
  step: 'type' | 'from' | 'to' | 'date' | 'details' | 'contact' | 'confirm';
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

const TYPE_MSG = 'Выберите тип объявления:\n\n1️⃣ <b>Водитель везёт</b> — у вас есть место в машине / посылка\n2️⃣ <b>Нужно передать</b> — ищете, кто передаст посылку\n\nОтправьте <b>1</b> или <b>2</b>, либо <i>/cancel</i> чтобы отменить.';

async function promptStep(env: Env, chatId: number, w: WizardState): Promise<void> {
  switch (w.step) {
    case 'type':
      await sendText(env, chatId, TYPE_MSG);
      break;
    case 'from':
      await sendText(env, chatId, '📍 <b>Откуда?</b>\nНапишите город отправления.');
      break;
    case 'to':
      await sendText(env, chatId, '📍 <b>Куда?</b>\nНапишите город назначения.');
      break;
    case 'date':
      await sendText(env, chatId, '🗓 <b>Когда?</b>\nНапример: <i>завтра</i>, <i>пятница</i>, <i>15.09</i>. Или просто <i>-</i>, если дата не важна.');
      break;
    case 'details':
      await sendText(env, chatId, '📝 <b>Опишите посылку / условия</b>\nВес, что за груз, сколько мест, цена (если есть). Одним сообщением.');
      break;
    case 'contact':
      await sendText(env, chatId, '✉️ <b>Как с вами связаться?</b>\nНапишите <code>@username</code> или номер телефона.');
      break;
    case 'confirm':
      await sendConfirmation(env, chatId, w);
      break;
  }
}

function draftSummary(w: WizardState): string {
  const d = w.draft;
  const typeLabel = d.type === 'offer' ? '🚚 Водитель везёт' : '📦 Нужно передать';
  return [
    `<b>Проверьте объявление:</b>`,
    `${typeLabel}`,
    `📍 ${escapeHtml(d.from ?? '?')} → ${escapeHtml(d.to ?? '?')}`,
    `🗓 ${d.date ? escapeHtml(d.date) : 'не указана'}`,
    `📝 ${escapeHtml((d.details ?? '').slice(0, 200))}`,
    `✉️ ${escapeHtml(d.contact ?? '?')}`,
  ].join('\n');
}

async function sendConfirmation(env: Env, chatId: number, w: WizardState): Promise<void> {
  await sendText(env, chatId, draftSummary(w) + '\n\nОтправьте <b>1</b> — опубликовать, <b>2</b> — отменить.', {
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Опубликовать', callback_data: `cfm:${chatId}` },
        { text: '❌ Отменить', callback_data: 'cancel' },
      ]],
    },
  });
}

async function handlePrivateText(env: Env, msg: TgMessage): Promise<void> {
  const text = (msg.text ?? '').trim();
  const chatId = msg.chat.id;

  if (text.startsWith('/')) {
    const parts = text.split(/\s+/);
    const cmd = parts[0]!.split('@')[0]!.toLowerCase();
    switch (cmd) {
      case '/start':
      case '/help': {
        const site = env.SITE_URL ?? 'ваш сайт';
        await sendText(env, chatId,
          `👋 Привет! Я бот доски попутных посылок.\n\n` +
          `• <b>/post</b> — разместить объявление\n` +
          `• Добавьте меня в чаты водителей/релокантов — я буду находить объявления и отправлять их на доску\n` +
          `• Сайт: ${site}\n\n<i>Важно: у бота должен быть выключен режим приватности (BotFather → Group Privacy → Off), иначе он не увидит сообщения в группах.</i>`
        );
        await setWizard(env, chatId, null);
        break;
      }
      case '/post': {
        const wizard: WizardState = { step: 'type', draft: {}, authorId: msg.from?.id };
        await setWizard(env, chatId, wizard);
        await promptStep(env, chatId, wizard);
        break;
      }
      case '/cancel':
        await setWizard(env, chatId, null);
        await sendText(env, chatId, 'Отменено.');
        break;
      case '/pending': {
        if (!admins(env).includes(String(msg.from?.id))) {
          await sendText(env, chatId, 'Команда доступна только администраторам.');
          return;
        }
        const pending = await listPending(env, 10);
        if (pending.length === 0) {
          await sendText(env, chatId, '✅ Очередь модерации пуста.');
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
        await sendText(env, chatId, 'Не знаю такую команду. /help — список.');
    }
    return;
  }

  const w = await getWizard(env, chatId);
  if (!w) {
    // Текст без активного мастера: если похоже на объявление — предлагаем /post
    if (looksLikeListing(text)) {
      await sendText(env, chatId, 'Похоже, это объявление! Нажмите /post, чтобы разместить его на доске, — я помогу заполнить поля.');
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
      const city = text.replace(/[^\p{L}\p{N}\- ]/gu, ' ').trim();
      if (city.length < 2 || city.length > 60) { await sendText(env, chatId, 'Похоже, это не город. Попробуйте ещё раз.'); return; }
      if (w.step === 'from') { draft.from = city; w.step = 'to'; }
      else { draft.to = city; w.step = 'date'; }
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
      if (text.length < 5) { await sendText(env, chatId, 'Опишите чуть подробнее — хотя бы пару слов.'); return; }
      draft.details = text.slice(0, 2000);
      w.step = 'contact';
      break;
    }
    case 'contact': {
      const contact = sanitizeContact(text);
      if (!contact) { await sendText(env, chatId, 'Нужен <code>@username</code> или телефон в формате <code>+48 123 456 789</code>.'); return; }
      draft.contact = contact;
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
      ? '\n✅ <b>Опубликовано!</b> Объявление уже на доске.'
      : '\n⏳ <b>Отправлено на модерацию.</b> Администратор одобрит его в ближайшее время.';
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
    fromCity: parsed.fromCity ?? '—',
    toCity: parsed.toCity ?? '—',
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
    const site = tgLink(env.SITE_URL);
    await sendText(env, msg.chat.id,
      `✅ Спасибо! Ваше объявление отправлено на доску${env.AUTO_APPROVE === '1' ? ' 👇' : ' (на модерацию)'}.${site ? `\n${site}` : ''}`
    );
  }
  await notifyAdmins(env, listing);
}

async function notifyAdmins(env: Env, listing: Listing): Promise<void> {
  if (!listing || listing.status !== 'pending') return;
  const link = listing.sourceMessageId
    ? chatMessageLink(Number(listing.sourceChatId), listing.sourceMessageId)
    : null;
  for (const adminId of admins(env)) {
    await sendText(env, Number(adminId),
      formatListing(listing, link ? `🔗 <a href="${link}">Исходное сообщение</a>` : ''),
      { reply_markup: approveKeyboard(listing.id) }
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
    await answerCallback(env, cb.id, appr ? '✅ Одобрено' : '❌ Отклонено');
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
          await sendText(env, Number(adminId), `✅ Опубликовано на доске:\n${formatListing(listing)}`);
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
