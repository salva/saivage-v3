import type { AgentMessage, AgentSession, ActivationCompletionOutcome, CardLifecycleState, CardRecord, ReviewAssessment } from '../schemas/index.js';
import type { RuntimeState } from '../schemas/index.js';
import { createActivationCompletionEnvelope, parseActivationCompletionEnvelope } from '../schemas/index.js';
import { parseToolCallMessage } from '../contracts/persisted-tool-call.js';
import type { RoundStamp, RuntimeAppendRecorder, SessionStamper } from '../contracts/session-stamper.js';
import type { RuntimeStateMutationPort } from './mutations.js';
import { TERMINAL_STATUSES } from '../permissions/index.js';
import { activeRunFromActivationState, plannerActivationStateFromGoal } from './activation-reducer.js';
import { isUnresolvedRuntimeActivationStatus } from './state.js';

export interface UnresolvedActivateCardCall {
  session_id: string;
  tool_call_id: string;
  card_id: string;
}

export interface ActivationUnwindCallerSessionPort {
  findPlannerSessionForCard(parentCardId: string): { id: string } | null | undefined;
  findUniqueUnresolvedActivateCardToolCall(sessionId: string, childCardId: string): { tool_call_id: string } | null | undefined;
}

export interface ActivationUnwindSessionPort {
  findPlannerSessionForCard(parentCardId: string): Pick<AgentSession, 'id'> | null | undefined;
  findUniqueUnresolvedActivateCardToolCall(sessionId: string, childCardId: string): { tool_call_id: string } | null | undefined;
  appendActivateCardToolResultOnce(
    sessionId: string,
    toolCallId: string,
    content: string,
    stamp: RoundStamp,
    appendRecorder?: RuntimeAppendRecorder,
  ): AgentMessage;
  listSessions(): string[];
  getSession(sessionId: string): Pick<AgentSession, 'role'> | null;
  getSessionMessages(sessionId: string): AgentMessage[];
}

export interface ActivationUnwindCardPort {
  getParent(childCardId: string): string | null | undefined;
}

export interface ActivationCallerEdge {
  parentCardId: string;
  callerSessionId: string;
  callerToolCallId: string;
}

export interface ChildActivationCompletionEffectsPort {
  markActivationComplete(childCardId: string, outcome: ActivationCompletionOutcome): void;
  findCallerEdge(childCardId: string): ActivationCallerEdge | null;
  buildActivationOutcome(childCardId: string, outcome: ActivationCompletionOutcome, summary: string): string;
  appendParentToolResultOnce(edge: ActivationCallerEdge, content: string): void;
}

export function completeChildActivationForParent(input: {
  childCardId: string;
  outcome: ActivationCompletionOutcome;
  summary: string;
  effects: ChildActivationCompletionEffectsPort;
}): void {
  input.effects.markActivationComplete(input.childCardId, input.outcome);
  const edge = input.effects.findCallerEdge(input.childCardId);
  if (!edge) return;
  input.effects.appendParentToolResultOnce(
    edge,
    input.effects.buildActivationOutcome(input.childCardId, input.outcome, input.summary),
  );
}

export function findActivationCallerEdge(input: {
  childCardId: string;
  cardPort: ActivationUnwindCardPort;
  sessionPort: ActivationUnwindCallerSessionPort;
}): ActivationCallerEdge | null {
  const parentCardId = input.cardPort.getParent(input.childCardId);
  if (!parentCardId) return null;
  const parentSession = input.sessionPort.findPlannerSessionForCard(parentCardId);
  const callerSessionId = parentSession?.id ?? `planner:${parentCardId}`;
  const call = input.sessionPort.findUniqueUnresolvedActivateCardToolCall(callerSessionId, input.childCardId);
  if (!call) return null;
  return { parentCardId, callerSessionId, callerToolCallId: call.tool_call_id };
}

export function findUnresolvedActivateCardCalls(
  sessionId: string,
  messages: readonly AgentMessage[],
): UnresolvedActivateCardCall[] {
  const activateCardToolCallIds = new Set<string>();
  const parsedCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || message.kind !== 'tool_call') continue;
    let raw: unknown;
    try {
      raw = JSON.parse(message.content);
    } catch {
      continue;
    }
    const call = parseToolCallMessage(raw);
    parsedCalls.push(call);
    if (call.name === 'activate_card') activateCardToolCallIds.add(call.id);
  }
  const resolved = new Set(
    messages
      .filter((message) => {
        if (typeof message.tool_call_id !== 'string' || !activateCardToolCallIds.has(message.tool_call_id)) return false;
        if (message.kind === 'tool_error') return true;
        return message.kind === 'tool_result' && Boolean(parseActivationCompletionEnvelope(message.content));
      })
      .map((message) => message.tool_call_id as string),
  );
  const calls: UnresolvedActivateCardCall[] = [];
  for (const call of parsedCalls) {
    if (call.name !== 'activate_card' || resolved.has(call.id)) continue;
    const cardId = call.args.cardId;
    if (typeof cardId === 'string') calls.push({ session_id: sessionId, tool_call_id: call.id, card_id: cardId });
  }
  return calls;
}

export function repairOrphanActivateCardToolCalls(input: {
  sessionPort: Pick<ActivationUnwindSessionPort, 'listSessions' | 'getSession' | 'getSessionMessages'>;
  synthesizeTerminalActivationResult(sessionId: string, toolCallId: string, cardId: string): boolean;
}): void {
  for (const sessionId of input.sessionPort.listSessions()) {
    const session = input.sessionPort.getSession(sessionId);
    if (!session || session.role !== 'planner') continue;
    for (const call of findUnresolvedActivateCardCalls(sessionId, input.sessionPort.getSessionMessages(sessionId))) {
      input.synthesizeTerminalActivationResult(call.session_id, call.tool_call_id, call.card_id);
    }
  }
}

export function selectPendingActivationChildCardIds(state: RuntimeState | null, parentCardId: string): string[] {
  return (state?.runtime_activations ?? [])
    .filter(
      (activation) =>
        activation.parent_card_id === parentCardId &&
        isUnresolvedRuntimeActivationStatus(activation.status),
    )
    .sort((a, b) => a.requested_at.localeCompare(b.requested_at))
    .map((activation) => activation.child_card_id);
}

export function selectChildGoalActivationOutcome(card: Pick<CardRecord, 'status'> | null | undefined): ActivationCompletionOutcome {
  if (card?.status === 'done') return 'done';
  if (card?.status === 'blocked') return 'blocked';
  if (card?.status === 'cancelled') return 'cancelled';
  if (card?.status === 'needs_verification') return 'needs_verification';
  return 'failed';
}

function activationCompletionOutcomeFromLifecycle(lifecycle: CardLifecycleState): ActivationCompletionOutcome {
  switch (lifecycle.status) {
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    case 'blocked':
      return 'blocked';
    case 'cancelled':
      return 'cancelled';
    case 'needs_verification':
      return 'needs_verification';
    default:
      return 'failed';
  }
}

export function selectTerminalActivationSynthesis(input: {
  childCardId: string;
  card: Pick<CardRecord, 'status'> | null | undefined;
}): { outcome: ActivationCompletionOutcome; summary: string } | null {
  if (!input.card || !TERMINAL_STATUSES.has(input.card.status)) return null;
  const outcome = input.card.status === 'done' ? 'done' : input.card.status === 'cancelled' ? 'cancelled' : 'failed';
  return {
    outcome,
    summary: `Restart repair delivered terminal status '${input.card.status}' for card ${input.childCardId}.`,
  };
}

export interface ActivationUnwindRunnerCards {
  read(cardId: string): CardRecord | null;
  getDescendantIds(cardId: string): string[];
  getParent(childCardId: string): string | null | undefined;
}

export class ActivationUnwindRunner {
  constructor(
    private readonly deps: {
      cards: ActivationUnwindRunnerCards;
      sessionPort: ActivationUnwindSessionPort;
      sessionStamper: SessionStamper;
      mutations: RuntimeStateMutationPort;
      now(): string;
    },
  ) {}

  findCallerEdge(childCardId: string): ActivationCallerEdge | null {
    return findActivationCallerEdge({
      childCardId,
      cardPort: { getParent: (cardId) => this.deps.cards.getParent(cardId) },
      sessionPort: this.deps.sessionPort,
    });
  }

  appendChildUnwindToolResult(
    childCardId: string,
    outcome: ActivationCompletionOutcome,
    summary: string,
  ): void {
    completeChildActivationForParent({
      childCardId,
      outcome,
      summary,
      effects: {
        markActivationComplete: (cardId, completionOutcome) => this.markActivationComplete(cardId, completionOutcome),
        findCallerEdge: (cardId) => this.findCallerEdge(cardId),
        buildActivationOutcome: (cardId, completionOutcome, completionSummary) =>
          this.buildCardActivationOutcome(cardId, completionOutcome, completionSummary),
        appendParentToolResultOnce: (edge, content) => {
          this.deps.sessionPort.appendActivateCardToolResultOnce(
            edge.callerSessionId,
            edge.callerToolCallId,
            content,
            this.deps.sessionStamper.stampDiagnosticInCurrentRound(edge.callerSessionId),
            this.deps.sessionStamper,
          );
        },
      },
    });
  }

  recordChildActivationLifecycle(childCardId: string, lifecycle: CardLifecycleState): void {
    this.markActivationComplete(childCardId, activationCompletionOutcomeFromLifecycle(lifecycle), lifecycle);
  }

  synthesizeTerminalActivationResult(
    sessionId: string,
    toolCallId: string,
    childCardId: string,
  ): boolean {
    const child = this.deps.cards.read(childCardId);
    const decision = selectTerminalActivationSynthesis({ childCardId, card: child });
    if (!decision) return false;
    this.deps.sessionPort.appendActivateCardToolResultOnce(
      sessionId,
      toolCallId,
      this.buildCardActivationOutcome(
        childCardId,
        decision.outcome,
        decision.summary,
      ),
      this.deps.sessionStamper.stampDiagnosticInCurrentRound(sessionId),
      this.deps.sessionStamper,
    );
    return true;
  }

  repairOrphanActivateCardToolCalls(): void {
    repairOrphanActivateCardToolCalls({
      sessionPort: this.deps.sessionPort,
      synthesizeTerminalActivationResult: (sessionId, toolCallId, cardId) =>
        this.synthesizeTerminalActivationResult(sessionId, toolCallId, cardId),
    });
  }

  parentPlannerRunFor(childCardId: string): RuntimeState['active_card_run'] {
    const parentCardId = this.deps.cards.getParent(childCardId);
    if (!parentCardId) return null;
    const parent = this.deps.cards.read(parentCardId);
    if (!parent) return null;
    return activeRunFromActivationState(
      plannerActivationStateFromGoal({ goal: { id: parentCardId, type: parent.type }, plannerSessionId: `planner:${parentCardId}` }),
      this.deps.now(),
    );
  }

  private markActivationComplete(childCardId: string, outcome: ActivationCompletionOutcome, lifecycle?: CardLifecycleState | null): void {
    const child = this.deps.cards.read(childCardId);
    this.deps.mutations.apply({
      kind: 'completeActivation',
      childCardId,
      outcome,
      completedAt: this.deps.now(),
      lifecycle: lifecycle ?? child?.lifecycle ?? null,
    });
  }

  private buildCardActivationOutcome(
    childCardId: string,
    outcome: ActivationCompletionOutcome,
    summary: string,
  ): string {
    const child = this.deps.cards.read(childCardId);
    const failureKind = (child?.lifecycle.result?.kind === 'executor_failure' || child?.lifecycle.result?.kind === 'planner_failure') ? (child.lifecycle.result as { error: string }).error : undefined;
    return JSON.stringify(
      createActivationCompletionEnvelope({
        child_card_id: childCardId,
        outcome,
        summary,
        result: child?.lifecycle.result ?? null,
        review: child?.lifecycle.result?.kind === 'reviewer_pass' ? ({ result: 'pass', summary: child.lifecycle.result.review_summary, achieved: [], issues: [], evidence_card_ids: [], assessment_id: child.lifecycle.result.assessment_id, at: child.lifecycle.completed_at ?? new Date().toISOString() } as ReviewAssessment) : null,
        artifacts: child?.artifacts ?? [],
        attachments: child?.attachments ?? [],
        evidence_card_ids: child
          ? [child.id, ...this.deps.cards.getDescendantIds(child.id)]
          : [childCardId],
        error: child?.lifecycle.error ?? null,
        failure_kind: failureKind,
      }),
    );
  }
}
