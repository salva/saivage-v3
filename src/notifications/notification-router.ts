/**
 * Notification Filter and Channel Router
 *
 * Reads the `notifications` section from saivage.json, filters events
 * by severity and category, and routes them to registered channel
 * handlers (e.g. 'web' → WebSocket broadcast, 'telegram' → Telegram bot).
 *
 * See docs/design/configuration.md § Notifications and docs/design/server-api.md.
 */

import { loadConfig, type SaivageConfig } from '../agents/config-schema.js';
import type { TelegramBot } from '../telegram/bot.js';
import type { NotificationRecord } from '../schemas/types.js';
import { broadcast } from '../server/websocket.js';
import type { WsEnvelope } from '../server/websocket.js';

// ── Types ─────────────────────────────────────────────────────

/** Severity levels from lowest to highest priority. */
export type SeverityLevel = 'info' | 'warning' | 'error' | 'critical';

/**
 * Severity ordering: lower index = lower severity.
 * Comparisons use this array's indices so that 'info' < 'warning' < 'error' < 'critical'.
 */
export const SEVERITY_ORDER: SeverityLevel[] = [
  'info',
  'warning',
  'error',
  'critical',
];

/**
 * An event that may be dispatched to notification channels.
 *
 * Categories are open-ended strings; the spec lists examples such as
 * 'goal_completed', 'goal_failed', 'escalation', 'card_failed', 'review_complete'.
 */
export interface NotificationEvent {
  category: string;
  severity: SeverityLevel;
  title: string;
  details?: string;
  cardId?: string;
  attachments?: string[];
  timestamp?: string;
}

/** Per-channel filter configuration. */
export interface NotificationFilter {
  /** Minimum severity to allow through (inclusive). */
  min_severity?: SeverityLevel;
  /** If non-empty, only events whose category is in this list are allowed. */
  categories?: string[];
}

/** The top-level notifications section from saivage.json. */
export interface NotificationConfig {
  channels: string[];
  filters?: NotificationFilter;
}


export interface LegacyNotificationMapping {
  kind: NotificationRecord['kind'];
  severity: NotificationRecord['severity'];
  payload_summary: string;
  related_card_id?: string;
  created_at: string;
}

export function mapLegacySeverityToDurable(severity: SeverityLevel): NotificationRecord['severity'] {
  switch (severity) {
    case 'critical':
      return 'block';
    case 'warning':
    case 'error':
      return 'warn';
    case 'info':
    default:
      return 'info';
  }
}

export function mapLegacyCategoryToDurableKind(category: string): NotificationRecord['kind'] {
  switch (category) {
    case 'escalation':
    case 'review_complete':
    case 'goal_completed':
    case 'goal_failed':
    case 'card_failed':
    case 'plan_updated':
      return 'card_changed';
    case 'paused':
    case 'resumed':
      return 'runtime_state';
    case 'process_reconciled_dead':
    case 'process_reattach_rejected':
      return 'process_state';
    default:
      return 'config_changed';
  }
}

export function mapLegacyEventToDurableNotification(event: NotificationEvent): LegacyNotificationMapping {
  return {
    kind: mapLegacyCategoryToDurableKind(event.category),
    severity: mapLegacySeverityToDurable(event.severity),
    payload_summary: [event.title, event.details].filter(Boolean).join(': '),
    related_card_id: event.cardId,
    created_at: event.timestamp ?? new Date().toISOString(),
  };
}

// ── Filter Logic ──────────────────────────────────────────────

/**
 * Determine whether an event should be sent based on the configured filters.
 *
 * Rules (AND logic):
 * 1. If no filters are defined, all events pass.
 * 2. If `min_severity` is set, the event's severity must be >= that level
 *    (by index in SEVERITY_ORDER).
 * 3. If `categories` is set and non-empty, the event's category must be
 *    included in the list.
 *
 * All active conditions must be satisfied.
 */
export function shouldSend(
  event: NotificationEvent,
  filters?: NotificationFilter,
): boolean {
  // No filters → everything passes
  if (!filters) return true;

  // Check severity floor
  if (filters.min_severity) {
    const minIdx = SEVERITY_ORDER.indexOf(filters.min_severity);
    const evtIdx = SEVERITY_ORDER.indexOf(event.severity);
    if (evtIdx < 0) {
      // Unknown severity — treat as info (lowest)
      if (minIdx > 0) return false;
    } else if (evtIdx < minIdx) {
      return false;
    }
  }

  // Check category whitelist
  if (filters.categories && filters.categories.length > 0) {
    if (!filters.categories.includes(event.category)) {
      return false;
    }
  }

  return true;
}

// ── Web-channel helper ────────────────────────────────────────

/**
 * Create a WsEnvelope suitable for broadcasting a notification event
 * to WebSocket clients.
 *
 * Uses the same envelope conventions as `createRuntimeEnvelope()` in
 * websocket.ts, mapping event categories to envelope types.
 */
export function notificationToEnvelope(event: NotificationEvent): WsEnvelope {
  // Map notification categories to the same envelope types used by
  // wireRuntimeEvents / createRuntimeEnvelope.
  let type: WsEnvelope['type'] = 'status';
  switch (event.category) {
    case 'goal_failed':
    case 'card_failed':
      type = 'error';
      break;
    case 'plan_updated':
    case 'review_complete':
    case 'escalation':
    case 'goal_completed':
      type = 'status';
      break;
    default:
      type = 'status';
  }

  return {
    type,
    content: {
      event: event.category,
      severity: event.severity,
      title: event.title,
      details: event.details,
      cardId: event.cardId,
      attachments: event.attachments,
      timestamp: event.timestamp ?? new Date().toISOString(),
    },
  };
}

// ── NotificationRouter ────────────────────────────────────────

/** Signature for a channel handler function. */
export type ChannelHandler = (event: NotificationEvent) => Promise<void>;

export class NotificationRouter {
  private projectRoot: string;
  private config: NotificationConfig;
  /** Map of channel name → handler function. */
  private handlers: Map<string, ChannelHandler> = new Map();

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.config = this._loadConfig();
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Register a channel handler.
   *
   * @param name  Channel name (e.g. 'web', 'telegram').
   * @param handler  Async function that processes and delivers the event.
   */
  registerChannel(name: string, handler: ChannelHandler): void {
    this.handlers.set(name, handler);
  }

  /**
   * Publish a notification event.
   *
   * Applies the configured filters. If the event passes, it is routed
   * to every channel listed in `channels` that has a registered handler.
   *
   * Errors from individual channel handlers are caught and logged;
   * they do not prevent other channels from receiving the event.
   */
  async publish(event: NotificationEvent): Promise<void> {
    // Apply filters
    if (!shouldSend(event, this.config.filters)) {
      return;
    }

    // Route to configured channels
    const promises: Promise<void>[] = [];
    for (const channelName of this.config.channels) {
      const handler = this.handlers.get(channelName);
      if (handler) {
        promises.push(
          handler(event).catch((err) => {
            console.error(
              `[notifications] Channel '${channelName}' handler failed for event '${event.category}': ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }),
        );
      }
    }

    // Wait for all channel handlers to finish (best-effort)
    await Promise.allSettled(promises);
  }

  /**
   * Reload the notification configuration from disk.
   *
   * Channel handler registrations are preserved; only the filter and
   * channel list are refreshed.
   */
  reload(): void {
    this.config = this._loadConfig();
  }

  /**
   * Return the current (possibly in-memory) notification configuration.
   */
  getConfig(): NotificationConfig {
    return this.config;
  }

  // ── Private ─────────────────────────────────────────────────

  private _loadConfig(): NotificationConfig {
    try {
      const { config } = loadConfig(this.projectRoot);
      return this._normalize(config);
    } catch {
      // If config file is missing or invalid, use safe defaults
      return { channels: ['web'] };
    }
  }

  private _normalize(config: SaivageConfig): NotificationConfig {
    const raw = config.notifications;

    // Defaults per docs/design/configuration.md
    const channels = raw?.channels ?? ['web'];

    const filters: NotificationFilter | undefined = raw?.filters
      ? {
          min_severity: (raw.filters.min_severity as SeverityLevel) ?? 'info',
          categories: raw.filters.categories,
        }
      : undefined;

    return { channels, filters };
  }
}

// ── Factory ───────────────────────────────────────────────────

/**
 * Create a fully wired NotificationRouter.
 *
 * - Loads the notifications section from saivage.json.
 * - Registers the 'web' channel to broadcast via WebSocket.
 * - If `telegramBot` is provided, registers the 'telegram' channel
 *   with the given chat IDs.
 *
 * @param projectRoot     Project root directory containing .saivage/saivage.json.
 * @param telegramBot     Optional TelegramBot instance for 'telegram' channel.
 * @param telegramChatIds Optional list of chat IDs to notify via Telegram.
 */
export function createNotificationRouter(
  projectRoot: string,
  telegramBot?: TelegramBot,
  telegramChatIds?: number[],
): NotificationRouter {
  const router = new NotificationRouter(projectRoot);

  // Register the 'web' channel — broadcasts to all connected WebSocket clients
  router.registerChannel('web', async (event: NotificationEvent) => {
    const envelope = notificationToEnvelope(event);
    broadcast(envelope);
  });

  // Register the 'telegram' channel if a bot is provided
  if (telegramBot && telegramChatIds && telegramChatIds.length > 0) {
    router.registerChannel('telegram', async (event: NotificationEvent) => {
      const durableMapping = mapLegacyEventToDurableNotification(event);
      for (const chatId of telegramChatIds) {
        try {
          await telegramBot.sendDurableNotification(chatId, {
            id: `legacy-${event.category}-${durableMapping.created_at}`,
            session_id: null,
            kind: durableMapping.kind,
            severity: durableMapping.severity,
            payload_summary: durableMapping.payload_summary,
            related_card_id: durableMapping.related_card_id,
            source_actor: 'runtime',
            source_surface: 'rest',
            created_at: durableMapping.created_at,
            delivered_at: null,
            acknowledged_at: null,
          }, {
            title: event.title,
            attachments: event.attachments,
          });
        } catch (err) {
          console.error(
            `[notifications] Telegram send failed for chat ${chatId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    });
  }

  return router;
}
