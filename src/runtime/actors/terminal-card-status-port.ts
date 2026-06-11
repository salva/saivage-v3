import type { CardRecord } from '../../schemas/index.js';
import type { CardLifecycleState, DoneResult, FailureResult, SelfReport } from '../../schemas/lifecycle.js';
import type { TerminalCardStatusPort, TerminalOutcome } from './card-runner.js';

export interface TerminalCardStorePort {
  setStatus(id: string, status: 'running' | 'cancelled' | 'blocked' | 'needs_verification'): CardRecord;
  commitTerminalLifecyclePatch(id: string, changes: Partial<CardRecord>): CardRecord;
}

export function createTerminalCardStatusPort(store: TerminalCardStorePort, now: () => string = () => new Date().toISOString()): TerminalCardStatusPort {
  return {
    markRunning(cardId) {
      store.setStatus(cardId, 'running');
    },
    markCancelled(cardId) {
      store.setStatus(cardId, 'cancelled');
    },
    commitTerminalOutcome(cardId, outcome) {
      const stamp = now();
      const latestSelfReport = selfReport(outcome, stamp);
      const lifecycle = terminalLifecycle(outcome, stamp, latestSelfReport);
      store.commitTerminalLifecyclePatch(cardId, {
        status: outcome.status,
        lifecycle,
        status_text: outcome.statusText,
        status_text_updated_at: stamp,
        status_text_author_session_id: null,
        latest_self_report: { ...latestSelfReport },
      });
    },
  };
}

function selfReport(outcome: TerminalOutcome, stamp: string): SelfReport {
  return {
    result: outcome.status,
    outcome: outcome.status,
    summary: outcome.statusText,
    status_text: outcome.statusText,
    at: stamp,
  };
}

function terminalLifecycle(outcome: TerminalOutcome, stamp: string, latestSelfReport: SelfReport): CardLifecycleState {
  if (outcome.status === 'done') {
    const result: DoneResult = {
      kind: 'executor_success',
      executor: { result: outcome.result },
      generated_files: [],
      verified_at: stamp,
      latest_self_report: latestSelfReport,
      warnings: [],
    };
    return { status: 'done', result, error: null, completed_at: stamp };
  }
  if (outcome.status === 'failed') {
    const result: FailureResult = {
      kind: 'executor_failure',
      error: outcome.statusText,
      partial_result: { result: outcome.result },
      latest_self_report: latestSelfReport,
    };
    return { status: 'failed', result, error: outcome.statusText, completed_at: stamp };
  }
  if (outcome.status === 'blocked') {
    return {
      status: 'blocked',
      result: { kind: 'planner_blocked', blocked_reason: outcome.statusText, resume_reason: 'executor_blocked', blocker_cause: 'generic' },
      error: outcome.statusText,
      completed_at: null,
    };
  }
  if (outcome.status === 'needs_verification') {
    return {
      status: 'needs_verification',
      result: {
        kind: 'executor_needs_verification',
        reason: outcome.statusText,
        preserved_result: { result: outcome.result },
        fallback_reason: null,
        latest_self_report: latestSelfReport,
      },
      error: null,
      completed_at: null,
    };
  }
  return { status: 'cancelled', result: null, error: null, completed_at: stamp };
}
