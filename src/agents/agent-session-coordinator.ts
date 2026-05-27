import type { EventEmitter } from 'node:events';
import type { AgentRole, HandoffSummary } from '../schemas/index.js';
import type { NotificationCenter, NotificationQueueEntry } from '../notifications/index.js';
import type { EventLogger } from '../observability/index.js';
import { getSession, getSessionMessages, listSessions } from './session-persistence.js';

export type SessionCreatedHook = (sessionId: string) => void | Promise<void>;

export interface AgentSessionCoordinatorConfig {
  saivageDir: string;
  notificationCenter: NotificationCenter;
  eventBus?: EventEmitter;
  eventLogger?: EventLogger;
}

export interface SessionStartEventInput {
  sessionId: string;
  role: AgentRole;
  goalId: string;
  cardId: string;
}

export class AgentSessionCoordinator {
  private readonly saivageDir: string;
  private readonly notificationCenter: NotificationCenter;
  private eventBus?: EventEmitter;
  private readonly eventLogger?: EventLogger;
  private readonly abortControllers: Map<string, AbortController> = new Map();
  private readonly cancelledSessions: Set<string> = new Set();
  private afterSessionCreatedHook: SessionCreatedHook | null = null;

  constructor(config: AgentSessionCoordinatorConfig) {
    this.saivageDir = config.saivageDir;
    this.notificationCenter = config.notificationCenter;
    this.eventBus = config.eventBus;
    this.eventLogger = config.eventLogger;
  }

  setEventBus(eventBus: EventEmitter): void { this.eventBus = eventBus; }
  setAfterSessionCreatedHook(hook: SessionCreatedHook | null): void { this.afterSessionCreatedHook = hook; }
  async notifySessionCreated(sessionId: string): Promise<void> { await this.afterSessionCreatedHook?.(sessionId); }

  publishSessionStarted(input: SessionStartEventInput): void {
    this.eventLogger?.appendEvent({ kind: 'session_started', session_id: input.sessionId, role: input.role, goal_id: input.goalId, card_id: input.cardId });
    this.eventBus?.emit('session_started', { session_id: input.sessionId, role: input.role, goal_id: input.goalId, card_id: input.cardId });
  }

  trackAbortController(sessionId: string, abortController: AbortController): void { this.abortControllers.set(sessionId, abortController); }
  clearAbortController(sessionId: string): void { this.abortControllers.delete(sessionId); }
  isCancelled(sessionId: string): boolean { return this.cancelledSessions.has(sessionId); }
  clearCancellation(sessionId: string): void { this.cancelledSessions.delete(sessionId); }

  cancelSession(sessionId: string): boolean {
    const controller = this.abortControllers.get(sessionId);
    if (!controller) return false;
    controller.abort();
    this.abortControllers.delete(sessionId);
    this.cancelledSessions.add(sessionId);
    this.eventLogger?.appendEvent({ kind: 'session_cancelled', session_id: sessionId });
    this.eventBus?.emit('session_cancelled', { session_id: sessionId });
    return true;
  }

  forceCancelSession(sessionId: string): boolean {
    const controller = this.abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(sessionId);
    }
    this.cancelledSessions.add(sessionId);
    this.eventLogger?.appendEvent({ kind: 'session_force_cancelled', session_id: sessionId });
    this.eventBus?.emit('session_force_cancelled', { session_id: sessionId });
    return controller !== undefined;
  }

  getHandoffSummary(sessionId: string): HandoffSummary | null {
    try {
      const session = getSession(this.saivageDir, sessionId);
      if (!session || (session.status !== 'active' && session.status !== 'waiting')) return null;
      const messages = getSessionMessages(this.saivageDir, sessionId);
      const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
      const lastAssistantMsg = [...messages].reverse().find((m) => m.role === 'assistant');
      return {
        session_id: sessionId,
        role: session.role as HandoffSummary['role'],
        last_action: lastAssistantMsg ? `Produced response: ${lastAssistantMsg.content.substring(0, 200)}` : 'Session started',
        next_action: lastUserMsg ? `Processing: ${lastUserMsg.content.substring(0, 200)}` : 'Awaiting user input',
        context_summary: `Goal: ${session.goal_card_id ?? 'N/A'}, Card: ${session.card_id ?? 'N/A'}`,
      };
    } catch { return null; }
  }

  getActiveSessionHandoffs(): HandoffSummary[] {
    try {
      const ids = listSessions(this.saivageDir);
      const summaries: HandoffSummary[] = [];
      for (const id of ids) {
        const summary = this.getHandoffSummary(id);
        if (summary) summaries.push(summary);
      }
      return summaries;
    } catch { return []; }
  }

  formatNotificationGuidance(notification: NotificationQueueEntry): string { return `- [${notification.kind}] ${notification.body}`; }

  buildNotificationInjectionMessage(notifications: NotificationQueueEntry[], sessionId: string) {
    const lines = ['## Queued notifications', '', ...notifications.map((notification) => this.formatNotificationGuidance(notification))];
    return { id: `msg-${sessionId}-notification-injection`, session_id: sessionId, role: 'user' as const, kind: 'text' as const, content: lines.join('\\n'), round_id: `r-user-1`, message_index: 0, block_index: 0, timestamp: new Date().toISOString() };
  }

  buildModelMessages(sessionId: string) {
    const pending = this.notificationCenter.drainPendingForSession(sessionId);
    const baseMessages = getSessionMessages(this.saivageDir, sessionId);
    if (pending.length === 0) return baseMessages;
    return [this.buildNotificationInjectionMessage(pending, sessionId), ...baseMessages];
  }

  publishCancelledRetryStop(sessionId: string, role: AgentRole): void {
    this.eventLogger?.appendEvent({ kind: 'session_cancelled', session_id: sessionId, role, note: 'Stopped retry loop due to session cancellation' });
  }
}
