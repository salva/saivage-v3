/**
 * Telegram module — re-exports TelegramBot, its configuration types,
 * and utility functions for Markdown-to-HTML conversion and message splitting.
 */

export { TelegramBot, convertMarkdownToHtml, splitLongMessage } from './bot.js';
export type { TelegramConfig } from './bot.js';
