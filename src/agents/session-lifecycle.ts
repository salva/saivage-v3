import type { EventEmitter } from 'node:events';
import type { AgentSession, AgentRole } from '../schemas/index.js';
import type { HandoffSummary } from '../schemas/types.js';
import {
  completeSession,
  createSession,
  markSessionWaiting,
  setSessionStatus,
} from './session-persistence.js';
import { AgentSessionCoordinator, type SessionCreatedHook } from './agent-session-coordinator.js';

export class AgentSessionLifecycle {
  constructor(
    private readonly saivageDir: string,
    private readonly coordinator: AgentSessionCoordinator,
  ) {}

  setEventBus(eventBus: EventEmitter): void {
    this.coordinator.setEventBus(eventBus);
  }

  setAfterSessionCreatedHook(hook: SessionCreatedHook | null): void {
    this.coordinator.setAfterSessionCreatedHook(hook);
  }

  create(role: AgentRole, goalId: string, cardId: string, requestedSessionId?: string, assessmentId?: string | null): AgentSession {
    return createSession(this.saivageDir, role, goalId, cardId, undefined, requestedSessionId, assessmentId);
  }

  async notifyCreated(sessionId: string): Promise<void> {
    await this.coordinator.notifySessionCreated(sessionId);
  }

  publishStarted(sessionId: string, role: AgentRole, goalId: string, cardId: string): void {
    this.coordinator.publishSessionStarted({ sessionId, role, goalId, cardId });
  }

  markWaiting(sessionId: string): void {
    markSessionWaiting(this.saivageDir, sessionId);
  }

  markActive(sessionId: string): void {
    setSessionStatus(this.saivageDir, sessionId, 'active');
  }

  complete(sessionId: string, outcome: 'done' | 'blocked' | 'failed'): AgentSession {
    return completeSession(this.saivageDir, sessionId, outcome);
  }

  cancel(sessionId: string): boolean {
    return this.coordinator.cancelSession(sessionId);
  }

  forceCancel(sessionId: string): boolean {
    return this.coordinator.forceCancelSession(sessionId);
  }

  getHandoffSummary(sessionId: string): HandoffSummary | null {
    return this.coordinator.getHandoffSummary(sessionId);
  }

  getActiveSessionHandoffs(): HandoffSummary[] {
    return this.coordinator.getActiveSessionHandoffs();
  }

  isCancelled(sessionId: string): boolean {
    return this.coordinator.isCancelled(sessionId);
  }

  trackAbortController(sessionId: string, controller: AbortController): void {
    this.coordinator.trackAbortController(sessionId, controller);
  }

  clearAbortController(sessionId: string): void {
    this.coordinator.clearAbortController(sessionId);
  }

  clearCancellation(sessionId: string): void {
    this.coordinator.clearCancellation(sessionId);
  }

  publishCancelledRetryStop(sessionId: string, role: AgentRole): void {
    this.coordinator.publishCancelledRetryStop(sessionId, role);
  }
}
