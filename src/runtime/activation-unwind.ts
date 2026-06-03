import { join } from 'node:path';
import type { AgentMessage, ActivationCompletionOutcome, CardRecord, ReviewAssessment } from '../schemas/index.js';
import type { RuntimeState } from '../schemas/index.js';
import { createActivationCompletionEnvelope, parseActivationCompletionEnvelope } from '../schemas/index.js';
import { parseToolCallMessage } from '../contracts/persisted-tool-call.js';
import {
  appendActivateCardToolResultOnce,
  findPlannerSessionForCard,
  findUniqueUnresolvedActivateCardToolCall,
  getSession,
  getSessionMessages,
  listSessions,
} from './session-persistence.js';
import { readRuntimeState, saveRuntimeState } from './state.js';
import { reduceActivationCompletion } from './runtime-core.js';
import type { RuntimeStampSource } from './runtime-config.js';

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled']);

export interface UnresolvedActivateCardCall {
  session_id: string;
  tool_call_id: string;
  card_id: string;
}

export interface ActivationUnwindSessionPort {
  findPlannerSessionForCard(parentCardId: string): { id: string } | null | undefined;
  findUniqueUnresolvedActivateCardToolCall(sessionId: string, childCardId: string): { tool_call_id: string } | null | undefined;
}

export interface ActivationUnwindCardPort {
  getParent(childCardId: string): string | null | undefined;
}

export interface ActivationCallerEdge {
  parentCardId: string;
  callerSessionId: string;
  callerToolCallId: string;
}

export function findActivationCallerEdge(input: {
  childCardId: string;
  cardPort: ActivationUnwindCardPort;
  sessionPort: ActivationUnwindSessionPort;
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

export function selectPendingActivationChildCardIds(state: RuntimeState | null, parentCardId: string): string[] {
  return (state?.runtime_activations ?? [])
    .filter(
      (activation) =>
        activation.parent_card_id === parentCardId &&
        ['pending', 'claimed', 'running'].includes(activation.status),
    )
    .sort((a, b) => a.requested_at.localeCompare(b.requested_at))
    .map((activation) => activation.child_card_id);
}

export function selectChildGoalActivationOutcome(card: Pick<CardRecord, 'status'> | null | undefined): ActivationCompletionOutcome {
  if (card?.status === 'done') return 'done';
  if (card?.status === 'blocked') return 'blocked';
  if (card?.status === 'cancelled') return 'cancelled';
  return 'failed';
}

export interface ActivationUnwindRunnerCards {
  read(cardId: string): CardRecord | null;
  getDescendantIds(cardId: string): string[];
  getParent(childCardId: string): string | null | undefined;
}

export class ActivationUnwindRunner {
  constructor(
    private readonly deps: {
      projectRoot: string;
      cards: ActivationUnwindRunnerCards;
      sessionStamper: RuntimeStampSource;
      now(): string;
    },
  ) {}

  findCallerEdge(childCardId: string): ActivationCallerEdge | null {
    const saivageDir = join(this.deps.projectRoot, '.saivage');
    return findActivationCallerEdge({
      childCardId,
      cardPort: { getParent: (cardId) => this.deps.cards.getParent(cardId) },
      sessionPort: {
        findPlannerSessionForCard: (parentCardId) => findPlannerSessionForCard(saivageDir, parentCardId),
        findUniqueUnresolvedActivateCardToolCall: (sessionId, cardId) => findUniqueUnresolvedActivateCardToolCall(saivageDir, sessionId, cardId),
      },
    });
  }

  appendChildUnwindToolResult(
    childCardId: string,
    outcome: ActivationCompletionOutcome,
    summary: string,
  ): void {
    this.markActivationComplete(childCardId, outcome);
    const edge = this.findCallerEdge(childCardId);
    if (!edge) return;
    appendActivateCardToolResultOnce(
      join(this.deps.projectRoot, '.saivage'),
      edge.callerSessionId,
      edge.callerToolCallId,
      this.buildCardActivationOutcome(childCardId, outcome, summary),
      this.deps.sessionStamper.stampDiagnosticInCurrentRound(edge.callerSessionId),
      this.deps.sessionStamper,
    );
  }

  synthesizeTerminalActivationResult(
    sessionId: string,
    toolCallId: string,
    childCardId: string,
  ): boolean {
    const child = this.deps.cards.read(childCardId);
    if (!child || !TERMINAL_STATUSES.has(child.status)) return false;
    const outcome =
      child.status === 'done' ? 'done' : child.status === 'cancelled' ? 'cancelled' : 'failed';
    appendActivateCardToolResultOnce(
      join(this.deps.projectRoot, '.saivage'),
      sessionId,
      toolCallId,
      this.buildCardActivationOutcome(
        childCardId,
        outcome,
        `Restart repair delivered terminal status '${child.status}' for card ${childCardId}.`,
      ),
      this.deps.sessionStamper.stampDiagnosticInCurrentRound(sessionId),
      this.deps.sessionStamper,
    );
    return true;
  }

  repairOrphanActivateCardToolCalls(): void {
    for (const sessionId of listSessions(join(this.deps.projectRoot, '.saivage'))) {
      const session = getSession(join(this.deps.projectRoot, '.saivage'), sessionId);
      if (!session || session.role !== 'planner') continue;
      for (const call of this.findUnresolvedActivateCards(sessionId))
        this.synthesizeTerminalActivationResult(call.session_id, call.tool_call_id, call.card_id);
    }
  }

  parentPlannerRunFor(childCardId: string): RuntimeState['active_card_run'] {
    const parentCardId = this.deps.cards.getParent(childCardId);
    if (!parentCardId) return null;
    const parent = this.deps.cards.read(parentCardId);
    if (!parent) return null;
    const stamp = this.deps.now();
    return {
      card_id: parentCardId,
      card_type: parent.type,
      runtime_status: 'running',
      phase: 'planner',
      caller_session_id: null,
      caller_tool_call_id: null,
      planner_session_id: `planner:${parentCardId}`,
      correction_attempts: 0,
      started_at: stamp,
      last_turn_at: stamp,
    };
  }

  private markActivationComplete(childCardId: string, outcome: ActivationCompletionOutcome): void {
    const state = readRuntimeState(this.deps.projectRoot);
    const next = reduceActivationCompletion(state, childCardId, outcome, this.deps.now());
    if (!next) return;
    saveRuntimeState(this.deps.projectRoot, next);
  }

  private buildCardActivationOutcome(
    childCardId: string,
    outcome: ActivationCompletionOutcome,
    summary: string,
  ): string {
    const child = this.deps.cards.read(childCardId);
    const failureKind =
      child?.result &&
      typeof child.result === 'object' &&
      typeof (child.result as { failure_kind?: unknown }).failure_kind === 'string'
        ? (child.result as { failure_kind: string }).failure_kind
        : undefined;
    return JSON.stringify(
      createActivationCompletionEnvelope({
        child_card_id: childCardId,
        outcome,
        summary,
        result: child?.result ?? null,
        review: (child?.result?.review as ReviewAssessment | null | undefined) ?? null,
        artifacts: child?.artifacts ?? [],
        attachments: child?.attachments ?? [],
        evidence_card_ids: child
          ? [child.id, ...this.deps.cards.getDescendantIds(child.id)]
          : [childCardId],
        error: child?.error ?? null,
        failure_kind: failureKind,
      }),
    );
  }

  private findUnresolvedActivateCards(sessionId: string): UnresolvedActivateCardCall[] {
    return findUnresolvedActivateCardCalls(
      sessionId,
      getSessionMessages(join(this.deps.projectRoot, '.saivage'), sessionId),
    );
  }
}
