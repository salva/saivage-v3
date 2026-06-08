import type { PlannerResultEnvelope } from '../contracts/planner-envelope.js';
import type { PlannerEnvelope } from '../contracts/planner-contract.js';

export function synthesizeReportGoalEnvelope(
  toolName: string,
  goalId: string,
  status: string | undefined,
): { kind: 'result'; payload: PlannerResultEnvelope } | null {
  if (status === 'done') {
    return {
      kind: 'result',
      payload: { status: 'done', summary: `${toolName} accepted for goal ${goalId}.` },
    };
  }
  if (status === 'changed') {
    return {
      kind: 'result',
      payload: {
        status: 'continue',
        summary: `${toolName}: goal ${goalId} needs re-planning (review corrections exhausted); continuing.`,
      },
    };
  }
  if (status === 'blocked' || status === 'failed') {
    return {
      kind: 'result',
      payload: {
        status: 'blocked',
        blocked_reason: `${toolName} accepted with goal status ${String(status)}.`,
        summary: `${toolName} accepted for goal ${goalId}.`,
      },
    };
  }
  return null;
}

export class PlannerEnvelopeTracker {
  private pendingEnvelope: PlannerEnvelope | null = null;

  trackTerminalToolResult(toolName: string, goalId: string, resultContent: string): void {
    try {
      const body = JSON.parse(resultContent) as {
        accepted?: unknown;
        card?: { status?: unknown };
      };
      const status = body.card?.status;
      if (body.accepted === true) {
        this.pendingEnvelope = synthesizeReportGoalEnvelope(
          toolName,
          goalId,
          typeof status === 'string' ? status : undefined,
        ) ?? this.pendingEnvelope;
      }
    } catch {
      void 0;
    }
  }

  takeEnvelope<E>(): E | null {
    const envelope = this.pendingEnvelope;
    this.pendingEnvelope = null;
    return envelope as E | null;
  }
}
