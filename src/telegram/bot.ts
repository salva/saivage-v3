/**
 * Telegram Bot for Analyst Chat
 *
 * Provides:
 * - TelegramBot class using polling mode (long polling via getUpdates)
 * - User filtering via allowedUserIds from saivage.yaml
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

import type { SaivageConfig } from '../agents/config-api.js';
import {
  AnalystRuntime,
  resolveAnalystSessionId,
} from '../agents/analyst-api.js';
import { redactTextForOutbound } from '../redaction/index.js';
import { readConversationMessages } from '../runtime/actors/conversation-session.js';

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
  private running = false;
  private pollAbortController: AbortController | null = null;
  private pollPromise: Promise<void> | null = null;
  private stopAbortReason: object | null = null;
  private lastUpdateId = 0;
  constructor(projectRoot: string, private readonly analystRuntime: AnalystRuntime, saivageConfig?: SaivageConfig) {
    this.projectRoot = projectRoot;
    if (!saivageConfig) {
      throw new Error('TelegramBot requires validated SaivageConfig from Environment.');
    }
    this.config = { botToken: saivageConfig.telegram?.botToken, allowedUserIds: saivageConfig.telegram?.allowedUserIds };
  }
  async start(): Promise<void> {
    if (this.running) return;
    if (!this.config.botToken) return;
    this.running = true;
    this.pollAbortController = new AbortController();
    this.stopAbortReason = Object.freeze({});
    this.pollPromise = this._pollLoop(this.pollAbortController.signal, this.stopAbortReason);
  }
  closeAdmission(): void { this.running = false; }
  async stop(): Promise<void> {
    const controller = this.pollAbortController;
    const poll = this.pollPromise;
    const stopReason = this.stopAbortReason;
    this.closeAdmission();
    if (!controller || !poll || !stopReason) return;
    controller.abort(stopReason);
    try { await poll; }
    catch (error) { if (error !== stopReason) throw error; }
    finally {
      if (this.pollAbortController === controller) this.pollAbortController = null;
      if (this.pollPromise === poll) this.pollPromise = null;
      if (this.stopAbortReason === stopReason) this.stopAbortReason = null;
    }
  }
  async sendMessage(chatId: number, text: string, options?: { parseMode?: 'Markdown' | 'HTML' }): Promise<void> { if (!this.config.botToken) return; let parseMode: string | undefined; let processedText = text; if (options?.parseMode === 'Markdown') { processedText = convertMarkdownToHtml(text); parseMode = 'HTML'; } else if (options?.parseMode === 'HTML') { parseMode = 'HTML'; processedText = escapeHtmlEntities(text); } const chunks = splitLongMessage(processedText, DEFAULT_MAX_MESSAGE_LENGTH); for (const chunk of chunks) { await this._telegramApi('sendMessage', { chat_id: chatId, text: chunk, ...(parseMode ? { parse_mode: parseMode } : {}) }); if (chunks.length > 1) await sleep(50); } }
  async sendNotification(chatId: number, notification: { title: string; cardId?: string; attachments?: string[]; details?: string; }): Promise<void> { if (!this.config.botToken) return; await this._telegramApi('sendMessage', { chat_id: chatId, text: escapeHtmlEntities(notification.title), parse_mode: 'HTML' }); }
  isAuthorized(userId: number): boolean { if (!this.config.allowedUserIds || this.config.allowedUserIds.length === 0) return false; return this.config.allowedUserIds.includes(userId); }
  isRunning(): boolean { return this.running; }
  private async _pollLoop(signal: AbortSignal, stopReason: object): Promise<void> { while (!signal.aborted) { try { const updates = await this._getUpdates(signal, stopReason); for (const update of updates) { if (signal.aborted) throw signal.reason; await this._handleUpdate(update); this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id); } } catch (err) { if (err === stopReason) throw err; if (signal.aborted) throw err; console.error(`[telegram] Poll error: ${redactTextForOutbound(err, 'telegram.diagnostic', { source: 'telegram-bot' })}`); await sleepWithSignal(POLL_INTERVAL_MS, signal); } } if (signal.reason === stopReason) throw stopReason; }
  private async _getUpdates(signal: AbortSignal, stopReason: object): Promise<TelegramUpdate[]> { const params: Record<string, unknown> = { offset: this.lastUpdateId + 1, timeout: POLL_TIMEOUT_SECONDS, allowed_updates: ['message'] }; const response = await this._telegramApiWithRetry<TelegramUpdate[]>('getUpdates', params, signal, stopReason); return response ?? []; }
  private async _handleUpdate(update: TelegramUpdate): Promise<void> { const msg = update.message ?? update.edited_message; if (!msg || !msg.text) return; const from = msg.from; if (!from) return; const userId = from.id; const chatId = msg.chat.id; if (!this.isAuthorized(userId)) return; const sessionId = `telegram-${chatId}`; try { resolveAnalystSessionId(sessionId); } catch (err) { console.error(`[telegram] Failed to create session for chat ${chatId}: ${redactTextForOutbound(err, 'telegram.diagnostic', { source: 'telegram-bot' })}`); return; } try { const response = await this.analystRuntime.submit(sessionId, { userContent: msg.text, actor: 'analyst', surface: 'telegram' }); const reply = [...readConversationMessages(this.projectRoot, response.sessionId).physicalRows].reverse().find((entry) => entry.role === 'assistant' && entry.kind === 'text')?.content ?? 'Done.'; await this.sendMessage(chatId, reply, { parseMode: 'Markdown' }); } catch (err) { console.error(`[telegram] Error handling message from ${userId}: ${redactTextForOutbound(err, 'telegram.diagnostic', { source: 'telegram-bot' })}`); try { await this.sendMessage(chatId, 'Sorry, something went wrong processing your request.'); } catch { void 0; } } }
  private async _telegramApi<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T | undefined> { const url = `${TELEGRAM_API_BASE}/bot${this.config.botToken}/${method}`; const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params), signal }); const data = (await response.json()) as TelegramApiResponse<T>; if (!data.ok) throw new Error(`Telegram API error (${method}): ${data.description ?? 'unknown'} (code ${data.error_code ?? 'N/A'})`); return data.result; }
  private async _telegramApiWithRetry<T>(method: string, params: Record<string, unknown>, signal: AbortSignal, stopReason: object): Promise<T | undefined> { let lastError: unknown; for (let attempt = 0; attempt < MAX_RETRIES; attempt++) { if (signal.aborted) throw signal.reason; try { return await this._telegramApi<T>(method, params, signal); } catch (err) { if (err === stopReason) throw err; if (signal.aborted) throw err; lastError = err; const retryError = err instanceof Error ? err : null; if (retryError?.message.includes('Telegram API error') && !retryError.message.includes('code 5') && !retryError.message.includes('code N/A')) throw err; const delay = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempt) + Math.random() * 500, MAX_BACKOFF_MS); console.warn(`[telegram] Retry ${attempt + 1}/${MAX_RETRIES} for ${method}: ${redactTextForOutbound(err, 'telegram.diagnostic', { source: 'telegram-bot' })} (waiting ${Math.round(delay)}ms)`); await sleepWithSignal(delay, signal); } } throw lastError ?? new Error('Max retries exceeded'); }
}
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
export function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> { return new Promise((resolve, reject) => { if (signal.aborted) { reject(signal.reason); return; } const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms); function onAbort() { clearTimeout(timer); reject(signal.reason); } signal.addEventListener('abort', onAbort, { once: true }); }); }
