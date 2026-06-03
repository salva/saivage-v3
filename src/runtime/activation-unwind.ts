import type { AgentMessage, ActivationCompletionOutcome, CardRecord } from '../schemas/index.js';
import type { RuntimeState } from '../schemas/index.js';
import { parseActivationCompletionEnvelope } from '../schemas/index.js';
import { parseToolCallMessage } from '../contracts/persisted-tool-call.js';

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
