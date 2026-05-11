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
 * See 06-configuration.md § Telegram and 08-server-api.md § Telegram Channel.
 */

import { loadConfig, type SaivageConfig } from '../agents/config-schema.js';
import {
  AnalystHandler,
  getOrCreateAnalystSession,
} from '../agents/analyst-handler.js';

// ── Types ─────────────────────────────────────────────────────

export interface TelegramConfig {
  botToken?: string;
  allowedUserIds?: number[];
}

/** Shape of a Telegram Update from getUpdates. */
interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  from?: { id: number; is_bot: boolean; first_name: string };
  chat: { id: number };
  text?: string;
}

/** Response from Telegram API calls. */
interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

// ── Constants ─────────────────────────────────────────────────

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const DEFAULT_MAX_MESSAGE_LENGTH = 4096;
const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_SECONDS = 30; // long-polling timeout
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

/** Maximum time to wait for the poll loop to exit in stop(). */
const STOP_TIMEOUT_MS = 5_000;

// ── Markdown-to-HTML Conversion ────────────────────────────────

/**
 * Convert a Markdown string to Telegram HTML.
 *
 * Conversion table:
 * | Markdown           | HTML                         |
 * |--------------------|------------------------------|
 * | ` ```block``` `    | `<pre>block</pre>`           |
 * | `` `code` ``       | `<code>code</code>`          |
 * | `**bold**`         | `<b>bold</b>`                |
 * | `*italic*`         | `<i>italic</i>`              |
 * | `~~strike~~`       | `<s>strike</s>`              |
 * | `[text](url)`      | `<a href=\"url\">text</a>`    |
 * | `# Header`         | `<b>Header</b>`             |
 * | `- item`           | `• item`                     |
 *
 * Process order: code blocks first (to protect their content),
 * then inline code, then formatting, then links, then headings,
 * then list items.
 */
export function convertMarkdownToHtml(markdown: string): string {
  if (!markdown) return '';

  let result = markdown;

  // 1. Fenced code blocks: ``` ... ``` → <pre>...</pre>
  result = result.replace(/```([\s\S]*?)```/g, (_match, content: string) => {
    // Trim leading and trailing newlines inside the block
    const trimmed = content.replace(/^\n/, '').replace(/\n$/, '');
    return `<pre>${escapeHtmlEntities(trimmed)}</pre>`;
  });

  // 2. Inline code: `code` → <code>code</code>
  result = result.replace(/`([^`]+)`/g, (_match, content: string) => {
    return `<code>${escapeHtmlEntities(content)}</code>`;
  });

  // 3. Bold: **text** → <b>text</b>
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

  // 4. Italic: *text* → <i>text</i>  (but not inside words to avoid false positives)
  result = result.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, '<i>$1</i>');

  // 5. Strikethrough: ~~text~~ → <s>text</s>
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // 6. Links: [text](url) → <a href="url">text</a>
  //    Escape both link text and URL to prevent HTML injection.
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_match, text: string, url: string) => {
      return `<a href="${escapeHtmlEntities(url)}">${escapeHtmlEntities(text)}</a>`;
    },
  );

  // 7. Headings: # Header at start of line → <b>Header</b>
  result = result.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // 8. Unordered list items: "- item" at start of line → "• item"
  result = result.replace(/^(\s*)-(\s+)/gm, '$1•$2');

  return result;
}

/**
 * Escape characters with special meaning in HTML.
 */
function escapeHtmlEntities(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Message Splitting ──────────────────────────────────────────

/**
 * Split a long message into chunks that fit within Telegram's message
 * limit (default 4096 characters).
 *
 * Strategy:
 * 1. If the entire text fits under maxLength, return it as a single chunk.
 * 2. Split at paragraph boundaries (double newlines) when possible.
 * 3. If a single paragraph exceeds maxLength, split at sentence boundaries
 *    (`. `, `! `, `? `) or word boundaries.
 */
export function splitLongMessage(
  text: string,
  maxLength: number = DEFAULT_MAX_MESSAGE_LENGTH,
): string[] {
  if (!text) return [];

  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];

  // Split into paragraphs
  const paragraphs = text.split(/\n\n+/);

  let currentChunk = '';

  for (const paragraph of paragraphs) {
    const candidate = currentChunk
      ? `${currentChunk}\n\n${paragraph}`
      : paragraph;

    if (candidate.length <= maxLength) {
      currentChunk = candidate;
    } else if (currentChunk) {
      // Current chunk + this paragraph is too long.
      // Push the current chunk and start a new one with this paragraph.
      chunks.push(currentChunk.trimEnd());
      currentChunk = '';

      // If the paragraph itself is too long, split it further
      if (paragraph.length > maxLength) {
        chunks.push(...splitSingleParagraph(paragraph, maxLength));
      } else {
        currentChunk = paragraph;
      }
    } else {
      // No current chunk and paragraph is too long — split it
      chunks.push(...splitSingleParagraph(paragraph, maxLength));
    }
  }

  // Push any remaining chunk
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trimEnd());
  }

  // Handle edge case: if no chunks were produced (shouldn't happen), return original
  if (chunks.length === 0) {
    return [text.slice(0, maxLength)];
  }

  return chunks;
}

/**
 * Split a single paragraph that exceeds maxLength into smaller pieces.
 * Tries sentence boundaries first, then word boundaries.
 */
function splitSingleParagraph(paragraph: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = paragraph;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining.trim());
      break;
    }

    // Try to split at sentence boundary within maxLength
    const slice = remaining.slice(0, maxLength);
    const sentenceBreak = findLastMatch(slice, /[.!?]\s+/);

    if (sentenceBreak && sentenceBreak > 0) {
      chunks.push(remaining.slice(0, sentenceBreak + 1).trim());
      remaining = remaining.slice(sentenceBreak + 1).trimStart();
    } else {
      // Fall back to word boundary
      const wordBreak = findLastMatch(slice, /\s+/);
      if (wordBreak && wordBreak > 0) {
        chunks.push(remaining.slice(0, wordBreak).trim());
        remaining = remaining.slice(wordBreak).trimStart();
      } else {
        // Hard split — no good boundary found
        chunks.push(slice.trim());
        remaining = remaining.slice(maxLength).trimStart();
      }
    }
  }

  return chunks;
}

/**
 * Find the last regex match in a string within its bounds.
 * Returns the index of the end of the match, or null.
 */
function findLastMatch(text: string, regex: RegExp): number | null {
  const matches = text.match(new RegExp(regex.source, 'g' + regex.flags.replace('g', '')));
  if (!matches || matches.length === 0) return null;

  let lastIndex = -1;
  let searchPos = 0;

  for (const m of matches) {
    const idx = text.indexOf(m, searchPos);
    if (idx === -1) break;
    lastIndex = idx + m.length - 1;
    searchPos = idx + m.length;
  }

  return lastIndex >= 0 ? lastIndex : null;
}

// ── TelegramBot ────────────────────────────────────────────────

export class TelegramBot {
  private projectRoot: string;
  private config: TelegramConfig;
  private analystHandler: AnalystHandler;
  private running = false;
  private pollAbortController: AbortController | null = null;
  private pollPromise: Promise<void> | null = null;
  private lastUpdateId = 0;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;

    // Load config from saivage.json
    let saivageConfig: SaivageConfig;
    try {
      const { config } = loadConfig(projectRoot);
      saivageConfig = config;
    } catch {
      saivageConfig = {} as SaivageConfig;
    }

    this.config = {
      botToken: saivageConfig.telegram?.botToken,
      allowedUserIds: saivageConfig.telegram?.allowedUserIds,
    };

    // Initialize analyst handler for per-chat sessions
    this.analystHandler = new AnalystHandler(projectRoot);
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Start the bot polling loop.
   * Does nothing if already running or if no bot token is configured.
   */
  async start(): Promise<void> {
    if (this.running) return;

    if (!this.config.botToken) {
      // No token configured — silently do not start
      return;
    }

    // Ensure analyst session directory is ready for all chat IDs
    // (the getOrCreateAnalystSession call in handleUpdate will create them on demand)

    this.running = true;
    this.pollAbortController = new AbortController();
    this.pollPromise = this._pollLoop(this.pollAbortController.signal);
  }

  /**
   * Stop the bot polling loop and clean up.
   *
   * Sets running flag, aborts the AbortController (which cancels any
   * in-flight sleep and causes the poll loop to check signal.aborted),
   * and awaits the pollPromise with a hard timeout so callers are never
   * stuck waiting on a blocked fetch.
   */
  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;

    if (this.pollAbortController) {
      this.pollAbortController.abort();
      this.pollAbortController = null;
    }

    if (this.pollPromise) {
      try {
        // Race the pollPromise against a timeout so stop() always resolves
        // promptly. If a fetch is in-flight and the signal propagation takes
        // time (or the network is slow), we don't want stop() to hang.
        //
        // We use raceWithTimeout so the timer is cleared when the pollPromise
        // resolves first — this avoids leaving a dangling timer handle.
        await raceWithTimeout(this.pollPromise, STOP_TIMEOUT_MS, 'Poll shutdown timeout');
      } catch {
        // Ignore errors during shutdown — the poll loop may have been
        // stuck in a slow API call, but the process is shutting down.
      }
      this.pollPromise = null;
    }
  }

  /**
   * Send a text message to a Telegram chat.
   *
   * Handles:
   * - Markdown-to-HTML conversion (if parseMode is 'Markdown' — input is
   *   Markdown, output is sent as Telegram HTML)
   * - HTML entity escaping (if parseMode is 'HTML' — input is escaped so
   *   Telegram does not interpret unintended HTML tags)
   * - Message splitting for long messages
   * - Sending chunks sequentially with minimal delay
   */
  async sendMessage(
    chatId: number,
    text: string,
    options?: { parseMode?: 'Markdown' | 'HTML' },
  ): Promise<void> {
    if (!this.config.botToken) return;

    let parseMode: string | undefined;
    let processedText = text;

    // Convert Markdown to HTML
    if (options?.parseMode === 'Markdown') {
      processedText = convertMarkdownToHtml(text);
      parseMode = 'HTML';
    } else if (options?.parseMode === 'HTML') {
      parseMode = 'HTML';
      // Escape HTML entities in user-supplied text so Telegram doesn't
      // interpret unintended HTML tags when using parse_mode=HTML.
      processedText = escapeHtmlEntities(text);
    }

    // Split long messages
    const chunks = splitLongMessage(processedText, DEFAULT_MAX_MESSAGE_LENGTH);

    // Send each chunk sequentially with minimal delay
    for (const chunk of chunks) {
      await this._telegramApi('sendMessage', {
        chat_id: chatId,
        text: chunk,
        ...(parseMode ? { parse_mode: parseMode } : {}),
      });
      // Minimal delay between chunks to preserve order
      if (chunks.length > 1) {
        await sleep(50);
      }
    }
  }

  /**
   * Send a notification about a card event.
   *
   * Format: "<b>Notification</b>: [title] — cardId: cardId — attachments: names..."
   * Attachments are mentioned by name only, never rendered inline.
   * Not split — kept as a single message under 4096 chars.
   *
   * All user-controlled fields (title, cardId, attachment names, details) are
   * HTML-escaped to prevent injection when using Telegram's HTML parse mode.
   */
  async sendNotification(
    chatId: number,
    notification: {
      title: string;
      cardId?: string;
      attachments?: string[];
      details?: string;
    },
  ): Promise<void> {
    if (!this.config.botToken) return;

    let text = `<b>Notification</b>: ${escapeHtmlEntities(notification.title)}`;

    if (notification.cardId) {
      text += ` — cardId: ${escapeHtmlEntities(notification.cardId)}`;
    }

    if (notification.attachments && notification.attachments.length > 0) {
      text += ` — attachments: ${notification.attachments.map(a => escapeHtmlEntities(a)).join(', ')}`;
    }

    if (notification.details) {
      text += `\n${escapeHtmlEntities(notification.details)}`;
    }

    // Ensure single message under 4096
    if (text.length > DEFAULT_MAX_MESSAGE_LENGTH) {
      text = text.slice(0, DEFAULT_MAX_MESSAGE_LENGTH - 3) + '...';
    }

    await this._telegramApi('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    });
  }

  /**
   * Check if a user ID is authorized to interact with the bot.
   */
  isAuthorized(userId: number): boolean {
    if (!this.config.allowedUserIds || this.config.allowedUserIds.length === 0) {
      // No allowlist configured means no one is authorized
      return false;
    }
    return this.config.allowedUserIds.includes(userId);
  }

  /**
   * Check if the bot is currently running (polling).
   */
  isRunning(): boolean {
    return this.running;
  }

  // ── Private: Polling Loop ───────────────────────────────────

  private async _pollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const updates = await this._getUpdates(signal);

        for (const update of updates) {
          if (signal.aborted) break;
          await this._handleUpdate(update);
          // Update the lastUpdateId to acknowledge this update
          this.lastUpdateId = Math.max(this.lastUpdateId, update.update_id);
        }
      } catch (err) {
        if (signal.aborted) break;

        // Log the error but continue polling
        console.error(
          `[telegram] Poll error: ${err instanceof Error ? err.message : String(err)}`,
        );
        // Wait before retrying
        await sleepWithSignal(POLL_INTERVAL_MS, signal);
      }
    }
  }

  /**
   * Fetch updates from Telegram with long polling.
   */
  private async _getUpdates(signal: AbortSignal): Promise<TelegramUpdate[]> {
    const params: Record<string, unknown> = {
      offset: this.lastUpdateId + 1,
      timeout: POLL_TIMEOUT_SECONDS,
      allowed_updates: ['message'],
    };

    const response = await this._telegramApiWithRetry<TelegramUpdate[]>(
      'getUpdates',
      params,
      signal,
    );

    return response ?? [];
  }

  /**
   * Handle a single Telegram update.
   *
   * - Checks authorization
   * - Routes authorized messages to the analyst handler
   * - Sends response back via sendMessage
   */
  private async _handleUpdate(update: TelegramUpdate): Promise<void> {
    const msg = update.message ?? update.edited_message;
    if (!msg || !msg.text) return;

    const from = msg.from;
    if (!from) return;

    const userId = from.id;
    const chatId = msg.chat.id;

    // Silently ignore unauthorized users
    if (!this.isAuthorized(userId)) {
      return;
    }

    // Per-chat analyst session: 'telegram-<chatId>'
    const sessionId = `telegram-${chatId}`;

    // Ensure session exists
    try {
      getOrCreateAnalystSession(this.projectRoot, sessionId);
    } catch (err) {
      console.error(
        `[telegram] Failed to create session for chat ${chatId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    // Process the message through the analyst handler
    try {
      const response = await this.analystHandler.handleMessage(
        sessionId,
        msg.text,
      );

      // Send the response back — convert Markdown to HTML for Telegram
      await this.sendMessage(chatId, response.message.content, {
        parseMode: 'Markdown',
      });
    } catch (err) {
      console.error(
        `[telegram] Error handling message from ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Send a generic error back to the user
      try {
        await this.sendMessage(
          chatId,
          'Sorry, something went wrong processing your request.',
        );
      } catch {
        // Best effort — if sending error fails, just log
      }
    }
  }

  // ── Private: API Helpers ────────────────────────────────────

  /**
   * Call a Telegram Bot API method.
   *
   * Accepts an optional AbortSignal. When the signal fires, the in-flight
   * fetch is cancelled, allowing stop() to tear down the poll loop without
   * waiting for the HTTP request to complete.
   */
  private async _telegramApi<T>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    const url = `${TELEGRAM_API_BASE}/bot${this.config.botToken}/${method}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal,
    });

    const data = (await response.json()) as TelegramApiResponse<T>;

    if (!data.ok) {
      throw new Error(
        `Telegram API error (${method}): ${data.description ?? 'unknown'} (code ${data.error_code ?? 'N/A'})`,
      );
    }

    return data.result;
  }

  /**
   * Call a Telegram Bot API method with automatic retries on network errors.
   *
   * Passes the AbortSignal through to _telegramApi → fetch so that aborting
   * the controller cancels in-flight HTTP requests, not just the retry loop.
   */
  private async _telegramApiWithRetry<T>(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<T | undefined> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (signal.aborted) {
        throw new Error('Aborted');
      }

      try {
        return await this._telegramApi<T>(method, params, signal);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Don't retry if aborted
        if (signal.aborted) break;

        // Don't retry on Telegram API errors (non-5xx, non-network)
        if (
          lastError.message.includes('Telegram API error') &&
          !lastError.message.includes('code 5') &&
          !lastError.message.includes('code N/A')
        ) {
          throw lastError;
        }

        // Exponential backoff with jitter
        const delay = Math.min(
          BASE_BACKOFF_MS * Math.pow(2, attempt) + Math.random() * 500,
          MAX_BACKOFF_MS,
        );

        console.warn(
          `[telegram] Retry ${attempt + 1}/${MAX_RETRIES} for ${method}: ${lastError.message} (waiting ${Math.round(delay)}ms)`,
        );

        await sleepWithSignal(delay, signal);
      }
    }

    throw lastError ?? new Error('Max retries exceeded');
  }
}

// ── Internal Helpers ──────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    }

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Race a promise against a timeout. If the promise settles first, the
 * timeout is cleared (no dangling timer handle). If the timeout fires
 * first, the returned promise is rejected with an Error carrying the
 * given message.
 */
function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timer = undefined;
      reject(new Error(message));
    }, timeoutMs);
  });

  return Promise.race([
    promise.then(
      (value) => {
        if (timer !== undefined) clearTimeout(timer);
        return value;
      },
      (err) => {
        if (timer !== undefined) clearTimeout(timer);
        throw err;
      },
    ),
    timeoutPromise,
  ]);
}
