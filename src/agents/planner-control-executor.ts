import { CardStore } from '../utils/card-store.js';
import { consumeChangedCardActivation } from '../utils/analyst-stage6.js';
import { PlannerToolError, PlannerToolsService, type PlannerToolsServiceOptions } from '../utils/planner-tools.js';
import { createDeferredActivationEnvelope } from '../schemas/validators.js';
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
          if (!target) {
            return toolMessage('tool_error', JSON.stringify({ success: false, error: `activate_card target '${targetId}' not found.` }), invocation.toolName, invocation.toolCallId);
          }
          const depFailures: Array<{ dep_id: string; status: string }> = [];
          for (const depId of (target.depends_on ?? [])) {
            const dep = this.context.cardStore.read(depId);
            if (!dep) { depFailures.push({ dep_id: depId, status: 'missing' }); continue; }
            if (dep.status === 'failed' || dep.status === 'blocked' || dep.status === 'cancelled') {
              depFailures.push({ dep_id: depId, status: dep.status });
            }
          }
          if (depFailures.length > 0) {
            const errorMessage = `Cannot activate '${targetId}': depends on ${depFailures.map((d) => `'${d.dep_id}' (status=${d.status})`).join(', ')}. Resolve the dependency first: use restart_card to retry a failed dep, cancel_card to drop '${targetId}' if no longer needed, or report_goal_blocked to escalate.`;
            return toolMessage('tool_error', JSON.stringify({ success: false, error: errorMessage, target_card_id: targetId, dep_failures: depFailures }), invocation.toolName, invocation.toolCallId);
          }
          const sessionId = invocation.sessionId ?? '';
          const parentCardId = (typeof invocation.parentCardId === 'string' && invocation.parentCardId.length > 0)
            ? invocation.parentCardId
            : sessionId.startsWith('planner:') && sessionId.length > 'planner:'.length
              ? sessionId.slice('planner:'.length)
              : null;
          if (!parentCardId) {
            return toolMessage('tool_error', JSON.stringify({ success: false, error: `activate_card target '${targetId}' has no deterministic parent card id for planner session '${sessionId}'.` }), invocation.toolName, invocation.toolCallId);
          }
          consumeChangedCardActivation(this.context.projectRoot, targetId);
          result = createDeferredActivationEnvelope({ parent_card_id: parentCardId, child_card_id: targetId, planner_session_id: sessionId, tool_call_id: invocation.toolCallId });
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
