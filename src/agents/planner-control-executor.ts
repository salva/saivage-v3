import { CardStore } from '../utils/card-store.js';
import { consumeChangedCardActivation } from '../utils/analyst-stage6.js';
import { PlannerToolError, PlannerToolsService, type PlannerToolsServiceOptions } from '../utils/planner-tools.js';
import { createActionableErrorEnvelope, createDeferredActivationEnvelope } from '../schemas/validators.js';
import { appendRuntimeRun, readRuntimeState, upsertRuntimeActivation } from '../runtime/state.js';
export interface AgentToolMessage { role: 'tool'; kind: 'tool_result' | 'tool_error'; content: string; tool: string; tool_call_id: string; }

export interface PlannerControlExecutionContext {
  cardStore: CardStore;
  projectRoot: string;
  saivageDir?: string;
  runtimeStateProvider?: PlannerToolsServiceOptions['runtimeStateProvider'];
  reviewer?: PlannerToolsServiceOptions['reviewer'];
  maxReviewRetries?: number;
  assessmentIdFactory?: PlannerToolsServiceOptions['assessmentIdFactory'];
}

export interface PlannerControlInvocation {
  sessionId?: string;
  toolCallId: string;
  toolName: string;
  argumentsJson: string;
  parentCardId?: string;
}

function buildPlannerToolErrorResponse(error: unknown): { success: false; tool_error?: { kind: string; message: string; payload?: Record<string, unknown> }; error?: string } {
  if (error instanceof PlannerToolError) return { success: false, tool_error: { kind: error.kind, message: error.message, ...(error.payload ? { payload: error.payload } : {}) } };
  return { success: false, error: error instanceof Error ? error.message : String(error) };
}

function parseArguments(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsJson);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function toolMessage(kind: 'tool_result' | 'tool_error', content: string, tool: string, toolCallId: string): AgentToolMessage {
  return { role: 'tool', kind, content, tool, tool_call_id: toolCallId };
}

export class PlannerControlExecutor {
  constructor(private readonly context: PlannerControlExecutionContext) {}

  private createService(): PlannerToolsService {
    return new PlannerToolsService(this.context.cardStore, {
      projectRoot: this.context.projectRoot,
      runtimeStateProvider: this.context.runtimeStateProvider,
      reviewer: this.context.reviewer,
      maxReviewRetries: this.context.maxReviewRetries,
      assessmentIdFactory: this.context.assessmentIdFactory,
    });
  }

  async execute(invocation: PlannerControlInvocation): Promise<AgentToolMessage> {
    const args = parseArguments(invocation.argumentsJson);
    const plannerTools = this.createService();
    try {
      let result: unknown;
      switch (invocation.toolName) {
        case 'activate_card': {
          const targetId = String(args.cardId ?? '');
          const target = this.context.cardStore.read(targetId);
          const sessionId = invocation.sessionId ?? '';
          const parentCardId = (typeof invocation.parentCardId === 'string' && invocation.parentCardId.length > 0)
            ? invocation.parentCardId
            : sessionId.startsWith('planner:') && sessionId.length > 'planner:'.length
              ? sessionId.slice('planner:'.length)
              : null;
          const state = readRuntimeState(this.context.projectRoot);
          const parentRun = parentCardId ? state?.runtime_runs?.find((run) => run.card_id === parentCardId && run.phase === 'planner' && run.runtime_status === 'running' && !run.finished_at) : undefined;
          const parentSessionMatches = parentRun && (!parentRun.session_id || !sessionId || parentRun.session_id === sessionId || sessionId === `planner:${parentCardId}`);
          const actionable = (code: string, message: string, nextAction: string, extra: Record<string, unknown> = {}) => createActionableErrorEnvelope({ code, message, currentState: { parentCardId, childCardId: targetId, sessionId, parentRunId: parentRun?.run_id ?? null, ...extra }, nextAction, docsRef: 'docs/v3-planner-control-mcp-contract.md', parentCardId: parentCardId ?? null, childCardId: targetId || null, sessionId });
          if (!target) {
            const error = actionable('activate_card_child_missing', `activate_card target '${targetId}' not found.`, 'Inspect the planning tree and retry activate_card with an existing child card id.');
            return toolMessage('tool_error', JSON.stringify({ success: false, error: error.message, actionable_error: error }), invocation.toolName, invocation.toolCallId);
          }
          if (!parentCardId || !parentRun || !parentSessionMatches) {
            const error = actionable('activate_card_parent_not_active', `Cannot activate '${targetId}': no active parent planner runtime run owns this tool call.`, 'Only call activate_card from the currently running parent planner turn after the runtime has started that parent run.');
            return toolMessage('tool_error', JSON.stringify({ success: false, error: error.message, actionable_error: error }), invocation.toolName, invocation.toolCallId);
          }
          const depFailures: Array<{ dep_id: string; planner_state: string }> = [];
          for (const depId of (target.depends_on ?? [])) {
            const dep = this.context.cardStore.read(depId);
            if (!dep) { depFailures.push({ dep_id: depId, planner_state: 'missing' }); continue; }
            if (dep.status !== 'done') depFailures.push({ dep_id: depId, planner_state: dep.status });
          }
          if (depFailures.length > 0) {
            const error = actionable('activate_card_dependencies_blocked', `Cannot activate '${targetId}': dependencies are not complete.`, 'Complete or explicitly resolve blocked dependencies before retrying activate_card.', { dependencyFailures: depFailures });
            return toolMessage('tool_error', JSON.stringify({ success: false, error: error.message, actionable_error: error, dep_failures: depFailures }), invocation.toolName, invocation.toolCallId);
          }
          const idempotencyKey = `${parentRun.run_id}:${sessionId}:${invocation.toolCallId}:${targetId}`;
          const run = appendRuntimeRun(this.context.projectRoot, { kind: 'child', card_id: targetId, parent_run_id: parentRun.run_id, command_id: null, activation_id: null, phase: 'pending', runtime_status: 'running', session_id: null, result: null });
          const activation = upsertRuntimeActivation(this.context.projectRoot, { idempotency_key: idempotencyKey, parent_card_id: parentCardId, parent_run_id: parentRun.run_id, parent_session_id: sessionId || parentRun.session_id || `planner:${parentCardId}`, parent_tool_call_id: invocation.toolCallId, child_card_id: targetId, status: 'pending', precondition: 'accepted', runtime_run_id: run.run_id, error: null });
          consumeChangedCardActivation(this.context.projectRoot, targetId);
          result = { success: true, activation, deferred: createDeferredActivationEnvelope({ parent_card_id: parentCardId, child_card_id: targetId, planner_session_id: sessionId || activation.parent_session_id, tool_call_id: invocation.toolCallId, requested_at: activation.requested_at }) };
          break;
        }
        case 'cancel_card':
          result = { success: true, card: plannerTools.cancelCard(String(args.cardId ?? '')) };
          break;
        case 'delete_card':
          plannerTools.deleteCard(String(args.cardId ?? ''));
          result = { success: true, deleted: true, cardId: String(args.cardId ?? '') };
          break;
        case 'restart_card':
          result = { success: true, card: plannerTools.restartCard(String(args.cardId ?? '')) };
          break;
        case 'report_goal_done':
        case 'report_goal_failed':
        case 'report_goal_blocked':
          result = await plannerTools.reportGoalAsync(invocation.toolName, String(args.goalId ?? invocation.parentCardId ?? ''), {
            status_text: String(args.status_text ?? ''),
            summary: typeof args.summary === 'string' ? args.summary : undefined,
            evidence_card_ids: Array.isArray(args.evidence_card_ids) ? args.evidence_card_ids.map((value) => String(value)) : undefined,
            report: typeof args.report === 'object' && args.report !== null ? args.report as Record<string, unknown> : undefined,
          }, invocation.sessionId);
          break;
        default:
          result = null;
      }
      return toolMessage('tool_result', typeof result === 'string' ? result : JSON.stringify(result), invocation.toolName, invocation.toolCallId);
    } catch (err) {
      return toolMessage('tool_error', JSON.stringify(buildPlannerToolErrorResponse(err)), invocation.toolName, invocation.toolCallId);
    }
  }
}
