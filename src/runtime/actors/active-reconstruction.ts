import type { OperationalAgentRole } from '../../schemas/index.js';
import type { CardActivationCaller } from './card-actor.js';
import type { LlmInvocationInput } from './llm-invocation.js';

export type ActiveReconstructionRecord =
  | CardActiveReconstructionRecord
  | ProcessorActiveReconstructionRecord
  | LlmActiveReconstructionRecord;

export interface CardActiveReconstructionRecord {
  schema_version: 1;
  kind: 'card_activation';
  card_id: string;
  processor_actor_id: string;
  caller: CardActivationCaller;
  started_at: string;
}

export interface ProcessorActiveReconstructionRecord {
  schema_version: 1;
  kind: 'processor_activation';
  processor_kind: 'planning' | 'terminal';
  card_id: string;
  caller: CardActivationCaller;
  activation_counter: number;
  started_at: string;
}

export interface LlmActiveReconstructionRecord {
  schema_version: 1;
  kind: 'llm_turn';
  agent_id: string;
  role: OperationalAgentRole;
  card_id: string;
  input_id: string;
  input: LlmInvocationInput;
  provider_call_id: string | null;
  waiting_tool_call: {
    sourceInputId: string;
    toolCallId: string;
    toolName: string;
  } | null;
  delivered_tool_call_ids: string[];
  tool_delivery_counter: number;
  started_at: string;
}
