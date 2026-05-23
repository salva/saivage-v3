/**
 * Telegram Bot for Analyst Chat
 *
 * Provides:
 * - TelegramBot class using polling mode (long polling via getUpdates)
 * - User filtering via allowedUserIds from saivage.json
 * - Markdown-to-HTML conversion for Telegram's HTML parse mode
 * - Message splitting at paragraph boundaries (4096 char limit)
 * - Per-chat analyst sessions using analyst-handler.ts
 * - Card notifications with card links and attachment mentions
 *
 * No external npm dependencies — uses fetch() directly against the
 * Telegram Bot API at https://api.telegram.org/bot<token>/METHOD.
 *
 * See docs/design/configuration.md § Telegram and docs/design/server-api.md § Telegram Channel.
 */

import type { SaivageConfig } from '../agents/index.js';
import {
  AnalystHandler,
  getOrCreateAnalystSession,
} from '../agents/index.js';
import { redactTextForOutbound } from '../redaction/index.js';
import type { NotificationRecord } from '../schemas/index.js';

export interface TelegramConfig {
  botToken?: string;
  allowedUserIds?: number[];
}
interface TelegramUpdate { update_id: number; message?: TelegramMessage; edited_message?: TelegramMessage; }
interface TelegramMessage { message_id: number; from?: { id: number; is_bot: boolean; first_name: string }; chat: { id: number }; text?: string; }
interface TelegramApiResponse<T> { ok: boolean; result?: T; description?: string; error_code?: number; }
const TELEGRAM_API_BASE = 'https://api.telegram.org';
const DEFAULT_MAX_MESSAGE_LENGTH = 4096;
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_SECONDS = 30;
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

export function formatDurableNotificationForTelegram(
  notification: NotificationRecord,
  options: { title?: string; attachments?: string[] } = {},
): string {
  const title = options.title ?? `${notification.kind} (${notification.severity})`;
  let text = `<b>Notification</b>: ${escapeHtmlEntities(title)}`;
  text += `
Severity: ${escapeHtmlEntities(notification.severity)}`;
  text += `
Kind: ${escapeHtmlEntities(notification.kind)}`;
  if (notification.related_card_id) text += `
Card: ${escapeHtmlEntities(notification.related_card_id)}`;
  if (notification.related_note_id) text += `
Note: ${escapeHtmlEntities(notification.related_note_id)}`;
  if (notification.related_process_id) text += `
Process: ${escapeHtmlEntities(notification.related_process_id)}`;
  if (notification.related_version_seq !== undefined) text += `
Version: ${notification.related_version_seq}`;
  text += `
${escapeHtmlEntities(redactTextForOutbound(notification.payload_summary, 'notification.transport', { source: 'notification-center' }))}`;
  if (options.attachments && options.attachments.length > 0) {
    text += `
Attachments: ${options.attachments.map((attachment) => escapeHtmlEntities(attachment)).join(', ')}`;
  }
  if (text.length > DEFAULT_MAX_MESSAGE_LENGTH) text = text.slice(0, DEFAULT_MAX_MESSAGE_LENGTH - 3) + '...';
  return text;
}
export function convertMarkdownToHtml(markdown: string): string {
  if (!markdown) return '';
  let result = markdown;
  result = result.replace(/```([\s\S]*?)```/g, (_match, content: string) => `<pre>${escapeHtmlEntities(content.replace(/^\n/, '').replace(/\n$/, ''))}</pre>`);
  result = result.replace(/`([^`]+)`/g, (_match, content: string) => `<code>${escapeHtmlEntities(content)}</code>`);
  result = result.replace(/\*\*(.+?)\*\*/g, (_match, content: string) => `<b>${escapeHtmlEntities(content)}</b>`);
  result = result.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, (_match, content: string) => `<i>${escapeHtmlEntities(content)}</i>`);
  result = result.replace(/~~(.+?)~~/g, (_match, content: string) => `<s>${escapeHtmlEntities(content)}</s>`);
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text: string, url: string) => `<a href="${escapeHtmlEntities(url)}">${escapeHtmlEntities(text)}</a>`);
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  result = result.replace(/^(\s*)-(\s+)/gm, '$1•$2');
  return result;
}
function escapeHtmlEntities(text: string): string { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
export function splitLongMessage(text: string, maxLength: number = DEFAULT_MAX_MESSAGE_LENGTH): string[] {
  if (!text) return [];
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let currentChunk = '';
  for (const paragraph of paragraphs) {
    const candidate = currentChunk ? `${currentChunk}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxLength) currentChunk = candidate;
    else if (currentChunk) {
      chunks.push(currentChunk.trimEnd());
      currentChunk = '';
      if (paragraph.length > maxLength) chunks.push(...splitSingleParagraph(paragraph, maxLength));
      else currentChunk = paragraph;
    } else chunks.push(...splitSingleParagraph(paragraph, maxLength));
  }
  if (currentChunk.trim()) chunks.push(currentChunk.trimEnd());
  if (chunks.length === 0) return [text.slice(0, maxLength)];
  return chunks;
}
function splitSingleParagraph(paragraph: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = paragraph;
  while (remaining.length > 0) {
    if (remaining.length <= maxLength) { chunks.push(remaining.trim()); break; }
    const slice = remaining.slice(0, maxLength);
    const sentenceBreak = findLastMatch(slice, /[.!?]\s+/);
    if (sentenceBreak && sentenceBreak > 0) { chunks.push(remaining.slice(0, sentenceBreak + 1).trim()); remaining = remaining.slice(sentenceBreak + 1).trimStart(); }
    else {
      const wordBreak = findLastMatch(slice, /\s+/);
      if (wordBreak && wordBreak > 0) { chunks.push(remaining.slice(0, wordBreak).trim()); remaining = remaining.slice(wordBreak).trimStart(); }
      else { chunks.push(slice.trim()); remaining = remaining.slice(maxLength).trimStart(); }
    }
  }
  return chunks;
}
function findLastMatch(text: string, regex: RegExp): number | null {
  const matches = text.match(new RegExp(regex.source, 'g' + regex.flags.replace('g', '')));
  if (!matches || matches.length === 0) return null;
  let lastIndex = -1;
  let searchPos = 0;
  for (const m of matches) { const idx = text.indexOf(m, searchPos); if (idx === -1) break; lastIndex = idx + m.length - 1; searchPos = idx + m.length; }
  return lastIndex >= 0 ? lastIndex : null;
}
export class TelegramBot {
  private projectRoot: string;
  private config: TelegramConfig;
  private analystHandler: AnalystHandler;
  private running = false;
  private pollAbortController: AbortController | null = null;
  private pollPromise: Promise<void> | null = null;
  private lastUpdateId = 0;
  constructor(projectRoot: string, saivageConfig?: SaivageConfig) {
    this.projectRoot = projectRoot;
    if (!saivageConfig) {
      throw new Error('TelegramBot requires validated SaivageConfig from Environment.');
    }
    this.config = { botToken: saivageConfig.telegram?.botToken, allowedUserIds: saivageConfig.telegram?.allowedUserIds };
    this.analystHandler = new AnalystHandler(projectRoot, undefined, undefined, 'analyst', 'telegram');
  }
  async start(): Promise<void> { if (this.running) return; if (!this.config.botToken) return; this.running = true; this.pollAbortController = new AbortController(); this.pollPromise = this._pollLoop(this.pollAbortController.signal); }
  async stop(): Promise<void> { if (!this.running) return; this.running = false; if (this.pollAbortController) { this.pollAbortController.abort(); this.pollAbortController = null; } if (this.pollPromise) { try { await raceWithTimeout(this.pollPromise, STOP_TIMEOUT_MS, 'Poll shutdown timeout'); } catch {} this.pollPromise = null; } }
  async sendMessage(chatId: number, text: string, options?: { parseMode?: 'Markdown' | 'HTML' }): Promise<void> { if (!this.config.botToken) return; let parseMode: string | undefined; let processedText = text; if (options?.parseMode === 'Markdown') { processedText = convertMarkdownToHtml(text); parseMode = 'HTML'; } else if (options?.parseMode === 'HTML') { parseMode = 'HTML'; processedText = escapeHtmlEntities(text); } const chunks = splitLongMessage(processedText, DEFAULT_MAX_MESSAGE_LENGTH); for (const chunk of chunks) { await this._telegramApi('sendMessage', { chat_id: chatId, text: chunk, ...(parseMode ? { parse_mode: parseMode } : {}) }); if (chunks.length > 1) await sleep(50); } }
  async sendNotification(chatId: number, notification: { title: string; cardId?: string; attachments?: string[]; details?: string; }): Promise<void> { if (!this.config.botToken) return; await this.sendDurableNotification(chatId, { id: `legacy-${Date.now()}`, session_id: null, kind: 'card_changed', severity: 'warn', payload_summary: notification.details ?? notification.title, related_card_id: notification.cardId, source_actor: 'runtime', source_surface: 'rest', created_at: new Date().toISOString(), delivered_at: null, acknowledged_at: null }, { title: notification.title, attachments: notification.attachments }); }
  async sendDurableNotification(chatId: number, notification: NotificationRecord, options?: { title?: string; attachments?: string[] }): Promise<void> { if (!this.config.botToken) return; await this._telegramApi('sendMessage', { chat_id: chatId, text: formatDurableNotificationForTelegram(notification, options), parse_mode: 'HTML' }); }
  isAuthorized(userId: number): boolean { if (!this.config.allowedUserIds || this.config.allowedUserIds.length === 0) return false; return this.config.allowedUserIds.includes(userId); }
  isRunning(): boolean { return this.running; }
  private async _pollLoop(signal: AbortSignal): Promise<void> { while (!signal.aborted) { try { const updates = await this._getUpdates(signal); for (const update of updates) { if (signal.aborted) break; await this._handleUpdate(update); this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id); } } catch (err) { if (signal.aborted) break; console.error(`[telegram] Poll error: ${redactTextForOutbound(err, 'telegram.diagnostic', { source: 'telegram-bot' })}`); await sleepWithSignal(POLL_INTERVAL_MS, signal); } } }
  private async _getUpdates(signal: AbortSignal): Promise<TelegramUpdate[]> { const params: Record<string, unknown> = { offset: this.lastUpdateId + 1, timeout: POLL_TIMEOUT_SECONDS, allowed_updates: ['message'] }; const response = await this._telegramApiWithRetry<TelegramUpdate[]>('getUpdates', params, signal); return response ?? []; }
  private async _handleUpdate(update: TelegramUpdate): Promise<void> { const msg = update.message ?? update.edited_message; if (!msg || !msg.text) return; const from = msg.from; if (!from) return; const userId = from.id; const chatId = msg.chat.id; if (!this.isAuthorized(userId)) return; const sessionId = `telegram-${chatId}`; try { getOrCreateAnalystSession(this.projectRoot, sessionId); } catch (err) { console.error(`[telegram] Failed to create session for chat ${chatId}: ${redactTextForOutbound(err, 'telegram.diagnostic', { source: 'telegram-bot' })}`); return; } try { const response = await this.analystHandler.handleMessage(sessionId, msg.text); await this.sendMessage(chatId, response.message.content, { parseMode: 'Markdown' }); } catch (err) { console.error(`[telegram] Error handling message from ${userId}: ${redactTextForOutbound(err, 'telegram.diagnostic', { source: 'telegram-bot' })}`); try { await this.sendMessage(chatId, 'Sorry, something went wrong processing your request.'); } catch {} } }
  private async _telegramApi<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T | undefined> { const url = `${TELEGRAM_API_BASE}/bot${this.config.botToken}/${method}`; const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal }); const data = (await response.json()) as TelegramApiResponse<T>; if (!data.ok) throw new Error(`Telegram API error (${method}): ${data.description ?? 'unknown'} (code ${data.error_code ?? 'N/A'})`); return data.result; }
  private async _telegramApiWithRetry<T>(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<T | undefined> { let lastError: Error | null = null; for (let attempt = 0; attempt < MAX_RETRIES; attempt++) { if (signal.aborted) throw new Error('Aborted'); try { return await this._telegramApi<T>(method, params, signal); } catch (err) { lastError = err instanceof Error ? err : new Error(String(err)); if (signal.aborted) break; if (lastError.message.includes('Telegram API error') && !lastError.message.includes('code 5') && !lastError.message.includes('code N/A')) throw lastError; const delay = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt) + Math.random() * 500, MAX_BACKOFF_MS); console.warn(`[telegram] Retry ${attempt + 1}/${MAX_RETRIES} for ${method}: ${redactTextForOutbound(lastError, 'telegram.diagnostic', { source: 'telegram-bot' })} (waiting ${Math.round(delay)}ms)`); await sleepWithSignal(delay, signal); } } throw lastError ?? new Error('Max retries exceeded'); }
}
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> { return new Promise((resolve, reject) => { const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms); function onAbort() { clearTimeout(timer); reject(new Error('Aborted')); } signal.addEventListener('abort', onAbort, { once: true }); }); }
function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> { let timer: ReturnType<typeof setTimeout> | undefined; const timeoutPromise = new Promise<never>((_, reject) => { timer = setTimeout(() => { timer = undefined; reject(new Error(message)); }, timeoutMs); }); return Promise.race([promise.then((value) => { if (timer !== undefined) clearTimeout(timer); return value; }, (err) => { if (timer !== undefined) clearTimeout(timer); throw err; }), timeoutPromise]); }
