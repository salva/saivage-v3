import type { LLMActorOutcome, ConversationLLMActor } from './llm-actor.js';
import type { SettledToolResultFacts } from './llm-delivery-log.js';
import { syntheticToolSettlement } from '../../tools/invocation.js';

export function settleReturnedToolCallWithoutEntry(
  llm: ConversationLLMActor,
  outcome: LLMActorOutcome,
  message: string,
): Promise<SettledToolResultFacts> | null {
  if (outcome.type !== 'tool_call') return null;
  return llm.settleToolResultWithoutContinuation(
    outcome.toolCallId,
    syntheticToolSettlement('rejected_before_execution', message),
  );
}
