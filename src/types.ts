/** Точка входа для Cloudflare Worker — переменные окружения и биндинги. */
export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  BOT_TOKEN?: string;
  BOT_SECRET?: string;
  ADMIN_IDS?: string;
  AUTO_APPROVE?: string;
  SITE_URL?: string;
  BOT_USERNAME?: string;
  ADMIN_API_TOKEN?: string;
  /** "1" — бот отвечает в группах после распознавания объявления (по умолчанию молчит). */
  REPLY_IN_GROUPS?: string;
}

export type ListingType = 'offer' | 'request';
export type ListingStatus = 'pending' | 'published' | 'rejected' | 'expired';
export type ListingSource = 'site' | 'telegram' | 'parser';

export interface ListingInput {
  type: ListingType;
  fromCity: string;
  toCity: string;
  departureDate?: string | null;
  weightKg?: number | null;
  price?: string | null;
  description: string;
  phone?: string | null;
  telegram?: string | null;
  status: ListingStatus;
  source: ListingSource;
  sourceChat?: string | null;
  sourceChatId?: string | null;
  sourceMessageId?: number | null;
}

export interface Listing extends ListingInput {
  id: string;
  createdAt: string;
  publishedAt: string | null;
  views: number;
}

export interface ListFilters {
  type?: ListingType;
  from?: string;
  to?: string;
  date?: string;
  q?: string;
  page?: number;
  perPage?: number;
  status?: ListingStatus;
}

export interface ParsedMessage {
  intent: 'offer' | 'request' | null;
  fromCity: string | null;
  toCity: string | null;
  departureDate: string | null;
  weightKg: number | null;
  price: string | null;
  telegram: string | null;
  phone: string | null;
  confidence: number;
}
