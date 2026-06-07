import { CardStore } from '../cards/store-api.js';
import { consumeChangedCardActivation } from '../runtime/synthetic-planner-notes.js';
import { PlannerToolError, PlannerToolsService, type PlannerToolsServiceOptions } from '../tools/index.js';
import { createActionableErrorEnvelope } from '../schemas/index.js';
import type { RuntimeActivationLedgerPort } from '../contracts/index.js';
import { resolveRecipient } from '../notifications/index.js';
import type { EventLogger } from '../observability/index.js';
import type { CardRecord } from '../schemas/index.js';
import { isUnresolvedRuntimeActivationStatus } from '../runtime/state.js';
import { emitLoggedEvent, type TypedEventEmitter } from '../events/index.js';
import { PLANNER_CONTROL_TOOL_NAMES } from './agent-tool-catalog.js';

export interface PlannerControlResult { success: boolean; data?: unknown; error?: string; }

export interface PlannerControlExecutionContext {
  cardStore: CardStore;
  projectRoot: string;
  saivageDir?: string;
  runtimeStateProvider?: PlannerToolsServiceOptions['runtimeStateProvider'];
  activationLedger?: RuntimeActivationLedgerPort;
  reviewer?: PlannerToolsServiceOptions['reviewer'];
  maxReviewRetries?: number;
  assessmentIdFactory?: PlannerToolsServiceOptions['assessmentIdFactory'];
  eventBus?: TypedEventEmitter;
  eventBusProvider?: () => TypedEventEmitter | undefined;
  eventLogger?: EventLogger;
}

export interface PlannerControlInvocation {
  sessionId?: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  parentCardId?: string;
}

function buildPlannerToolErrorResponse(error: unknown): { success: false; tool_error?: { kind: string; message: string; payload?: Record<string, unknown> }; error?: string } {
  if (error instanceof PlannerToolError) return { success: false, tool_error: { kind: error.kind, message: error.message, ...(error.payload ? { payload: error.payload } : {}) } };
  return { success: false, error: error instanceof Error ? error.message : String(error) };
}

const PLANNER_EDITABLE_FIELDS = new Set(['title', 'description', 'status', 'tags', 'priority', 'urgency', 'acceptance', 'depends_on', 'related']);

export class PlannerControlExecutor {
  constructor(private readonly context: PlannerControlExecutionContext) {}

  static handles(toolName: string): boolean { return PLANNER_CONTROL_TOOL_NAMES.has(toolName); }

  private createService(): PlannerToolsService {
    return new PlannerToolsService(this.context.cardStore, {
      projectRoot: this.context.projectRoot,
      runtimeStateProvider: this.context.runtimeStateProvider,
      reviewer: this.context.reviewer,
      maxReviewRetries: this.context.maxReviewRetries,
      assessmentIdFactory: this.context.assessmentIdFactory,
    });
  }

  private parentCardId(invocation: PlannerControlInvocation): string | null {
    const sessionId = invocation.sessionId ?? '';
    return (typeof invocation.parentCardId === 'string' && invocation.parentCardId.length > 0)
      ? invocation.parentCardId
      : sessionId.startsWith('planner:') && sessionId.length > 'planner:'.length
        ? sessionId.slice('planner:'.length)
        : null;
  }

  private directChildError(toolName: string, sessionId: string | undefined, parentCardId: string | null, target: CardRecord | null, targetId: string): PlannerControlResult | null {
    if (!target) return { success: false, data: { success: false, error: `Card '${targetId}' not found.` } };
    if (!parentCardId || target.parent !== parentCardId) {
      const error = createActionableErrorEnvelope({
        code: 'planner_direct_child_required',
        message: `Planner tool '${toolName}' can only operate on direct child cards of the active planner card.`,
        currentState: { parentCardId, targetCardId: targetId, actualParentId: target.parent ?? null },
        nextAction: 'Operate only on an immediate child, or let the child planner handle deeper descendants.',
        docsRef: 'docs/agents.md',
        parentCardId,
        childCardId: targetId,
        sessionId,
      });
      return { success: false, data: { success: false, error: error.message, actionable_error: error } };
    }
    return null;
  }

  async execute(invocation: PlannerControlInvocation): Promise<PlannerControlResult> {
    const args = invocation.args;
    const plannerTools = this.createService();
    try {
      let result: unknown;
      switch (invocation.toolName) {
        case 'activate_card': {
          const targetId = String(args.cardId ?? '');
          const target = this.context.cardStore.read(targetId);
          const sessionId = invocation.sessionId ?? '';
          const parentCardId = this.parentCardId(invocation);
          const state = this.context.activationLedger?.readState() ?? this.context.runtimeStateProvider?.() ?? null;
          const activeParentRuns = parentCardId
            ? (state?.runtime_runs ?? [])
              .filter((run) => run.card_id === parentCardId && run.phase === 'planner' && run.runtime_status === 'running' && !run.finished_at)
            : [];
          const parentRun = activeParentRuns.find((run) => Boolean(sessionId) && run.session_id === sessionId)
            ?? activeParentRuns.find((run) => !sessionId && !run.session_id);
          const parentRunCandidates = activeParentRuns.map((run) => ({
            run_id: run.run_id,
            card_id: run.card_id,
            phase: run.phase,
            runtime_status: run.runtime_status,
            session_id: run.session_id ?? null,
            parent_run_id: run.parent_run_id ?? null,
            finished_at: run.finished_at ?? null,
          }));
          const actionable = (code: string, message: string, nextAction: string, extra: Record<string, unknown> = {}) => createActionableErrorEnvelope({ code, message, currentState: { parentCardId, childCardId: targetId, sessionId, parentRunId: parentRun?.run_id ?? null, parentRunCandidates, ...extra }, nextAction, docsRef: 'docs/v3-planner-control-mcp-contract.md', parentCardId: parentCardId ?? null, childCardId: targetId || null, sessionId });
          if (!target) {
            const error = actionable('activate_card_child_missing', `activate_card target '${targetId}' not found.`, 'Inspect the planning tree and retry activate_card with an existing child card id.');
            return { success: false, data: { success: false, error: error.message, actionable_error: error } };
          }
          if (!parentCardId || !parentRun) {
            const error = actionable('activate_card_parent_not_active', `Cannot activate '${targetId}': no active parent planner runtime run owns this tool call.`, 'Only call activate_card from the currently running parent planner turn after the runtime has started that parent run.');
            return { success: false, data: { success: false, error: error.message, actionable_error: error } };
          }
          if (target.parent !== parentCardId) {
            const error = actionable('activate_card_not_direct_child', `Cannot activate '${targetId}': it is not a direct child of active parent planner '${parentCardId}'.`, 'Only call activate_card for immediate child cards of the currently running parent planner card.', { actualParentId: target.parent ?? null });
            return { success: false, data: { success: false, error: error.message, actionable_error: error } };
          }
          const depFailures: Array<{ dep_id: string; planner_state: string }> = [];
          for (const depId of (target.depends_on ?? [])) {
            const dep = this.context.cardStore.read(depId);
            if (!dep) { depFailures.push({ dep_id: depId, planner_state: 'missing' }); continue; }
            if (dep.status !== 'done') depFailures.push({ dep_id: depId, planner_state: dep.status });
          }
          if (depFailures.length > 0) {
            const error = actionable('activate_card_dependencies_blocked', `Cannot activate '${targetId}': dependencies are not complete.`, 'Complete or explicitly resolve blocked dependencies before retrying activate_card.', { dependencyFailures: depFailures });
            return { success: false, data: { success: false, error: error.message, actionable_error: error, dep_failures: depFailures } };
          }
          const idempotencyKey = `${parentRun.run_id}:${sessionId}:${invocation.toolCallId}:${targetId}`;
          const existingActivation = (this.context.activationLedger?.readState()?.runtime_activations ?? this.context.runtimeStateProvider?.()?.runtime_activations ?? [])
            .find((activation) => activation.idempotency_key === idempotencyKey && isUnresolvedRuntimeActivationStatus(activation.status));
          if (existingActivation) {
            result = { success: true, activation: existingActivation };
            break;
          }
          if (!this.context.activationLedger) throw new Error('runtime_activation_ledger_missing: activate_card requires RuntimeActivationLedgerPort.');
          const parentSessionId = sessionId || parentRun.session_id;
          if (!parentSessionId) throw new Error(`activate_card parent planner run '${parentRun.run_id}' has no session identity.`);
          const activation = this.context.activationLedger!.upsertActivation({ idempotency_key: idempotencyKey, parent_card_id: parentCardId, parent_run_id: parentRun.run_id, parent_session_id: parentSessionId, parent_tool_call_id: invocation.toolCallId, child_card_id: targetId, status: 'pending', precondition: 'accepted', runtime_run_id: null, error: null });
          const run = this.context.activationLedger!.appendRun({ kind: 'child', card_id: targetId, ownership: { kind: 'activation', activation_id: activation.activation_id, parent_run_id: parentRun.run_id, parent_card_id: parentCardId, parent_session_id: parentSessionId, parent_tool_call_id: invocation.toolCallId }, parent_run_id: parentRun.run_id, command_id: null, activation_id: activation.activation_id, phase: 'pending', runtime_status: 'running', session_id: null });
          const linkedActivation = this.context.activationLedger!.upsertActivation({ ...activation, runtime_run_id: run.run_id });
          const runEvent = this.context.eventLogger?.appendEvent({ kind: 'runtime_run', run });
          const eventBus = this.context.eventBus ?? this.context.eventBusProvider?.();
          if (runEvent && eventBus) emitLoggedEvent(eventBus, runEvent);
          const activationEvent = this.context.eventLogger?.appendEvent({ kind: 'runtime_activation', activation: linkedActivation });
          if (activationEvent && eventBus) emitLoggedEvent(eventBus, activationEvent);
          consumeChangedCardActivation(this.context.projectRoot, targetId);
          result = { success: true, activation: linkedActivation };
          break;
        }
        case 'create_card': {
          const parentCardId = this.parentCardId(invocation);
          if (!parentCardId) throw new Error('create_card requires an active planner parent card.');
          if (!this.context.cardStore.read(parentCardId)) throw new Error(`Parent planner card '${parentCardId}' not found.`);
          const card = this.context.cardStore.create({
            type: String(args.type ?? '') as CardRecord['type'],
            parent: parentCardId,
            depth: 0,
            title: String(args.title ?? ''),
            description: String(args.description ?? ''),
            status: typeof args.status === 'string' ? args.status as CardRecord['status'] : 'backlog',
            tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
            priority: typeof args.priority === 'number' ? args.priority : 0,
            urgency: typeof args.urgency === 'string' ? args.urgency as CardRecord['urgency'] : 'normal',
            created_by: 'planner',
            acceptance: typeof args.acceptance === 'string' ? args.acceptance : '',
            depends_on: Array.isArray(args.depends_on) ? args.depends_on.map(String) : [],
            related: Array.isArray(args.related) ? args.related.map(String) : [],
            artifacts: [],
            attachments: [],
            retries: 0,
          });
          result = { success: true, data: card };
          break;
        }
        case 'edit_card': {
          const targetId = String(args.id ?? '');
          const error = this.directChildError(invocation.toolName, invocation.sessionId, this.parentCardId(invocation), this.context.cardStore.read(targetId), targetId);
          if (error) return error;
          const changes: Partial<CardRecord> = {};
          const rejected: string[] = [];
          for (const [key, value] of Object.entries(args)) {
            if (key === 'id') continue;
            if (PLANNER_EDITABLE_FIELDS.has(key)) (changes as Record<string, unknown>)[key] = value;
            else rejected.push(key);
          }
          if (Object.keys(changes).length === 0) throw new Error(`edit_card failed: no allowed fields to update. Rejected fields: ${rejected.join(', ') || '(none)'}.`);
          result = { success: true, data: this.context.cardStore.mutateCard(targetId, changes, { actor: 'planner', surface: 'runtime', reason: 'planner edit_card' }) };
          break;
        }
        case 'cancel_card': {
          const targetId = String(args.cardId ?? '');
          const error = this.directChildError(invocation.toolName, invocation.sessionId, this.parentCardId(invocation), this.context.cardStore.read(targetId), targetId);
          if (error) return error;
          result = { success: true, card: plannerTools.cancelCard(targetId) };
          break;
        }
        case 'delete_card': {
          const targetId = String(args.cardId ?? '');
          const error = this.directChildError(invocation.toolName, invocation.sessionId, this.parentCardId(invocation), this.context.cardStore.read(targetId), targetId);
          if (error) return error;
          plannerTools.deleteCard(targetId);
          result = { success: true, deleted: true, cardId: targetId };
          break;
        }
        case 'restart_card': {
          const targetId = String(args.cardId ?? '');
          const error = this.directChildError(invocation.toolName, invocation.sessionId, this.parentCardId(invocation), this.context.cardStore.read(targetId), targetId);
          if (error) return error;
          result = { success: true, card: plannerTools.restartCard(targetId) };
          break;
        }
        case 'reorder_child': {
          const parentCardId = this.parentCardId(invocation);
          if (!parentCardId) throw new Error('reorder_child requires an active planner parent card.');
          const r = plannerTools.reorderChildren(parentCardId, Array.isArray(args.orderedChildIds) ? args.orderedChildIds.map((v) => String(v)) : [], { actor: 'planner', surface: 'runtime', toolCallId: invocation.toolCallId, sessionId: invocation.sessionId });
          result = r;
          break;
        }
        case 'queue_notification': {
          const recipient = String(args.recipient ?? '');
          const resolved = resolveRecipient(this.context.projectRoot, this.context.cardStore, recipient);
          if (resolved === null) {
            result = { success: false, data: { reason: 'unknown_recipient', recipient } };
            break;
          }
          result = plannerTools.queueNotification(resolved, String(args.kind ?? ''), String(args.body ?? ''), { actor: 'planner', surface: 'runtime', toolCallId: invocation.toolCallId, sessionId: invocation.sessionId });
          break;
        }
        case 'report_goal_done':
        case 'report_goal_failed':
        case 'report_goal_blocked':
          result = await plannerTools.reportGoalAsync(invocation.toolName, this.parentCardId(invocation) ?? '', {
            status_text: String(args.status_text ?? ''),
            summary: typeof args.summary === 'string' ? args.summary : undefined,
            evidence_card_ids: Array.isArray(args.evidence_card_ids) ? args.evidence_card_ids.map((value) => String(value)) : undefined,
            report: typeof args.report === 'object' && args.report !== null ? args.report as Record<string, unknown> : undefined,
          }, invocation.sessionId);
          break;
        default:
          result = null;
      }
      return { success: true, data: result };
    } catch (err) {
      return { success: false, data: buildPlannerToolErrorResponse(err) };
    }
  }
}
