import type { AgentRole, ConversationSessionId } from '../../schemas/index.js';

export interface ToolInvocationIdentity {
  readonly sessionId: ConversationSessionId;
  readonly sourceInputId: string;
  readonly toolCallId: string;
  readonly toolName: string;
}

export interface StructuralChildRelationship extends ToolInvocationIdentity {
  readonly childCardId: string;
}

export type ExactWaitBarrier =
  | ({ readonly kind: 'external' } & ToolInvocationIdentity)
  | ({ readonly kind: 'process'; readonly processId: string } & ToolInvocationIdentity)
  | { readonly kind: 'child'; readonly relationship: StructuralChildRelationship };

export type ExecutingLlmActivity =
  | { readonly mode: 'active'; readonly barrier: null }
  | { readonly mode: 'waiting'; readonly barrier: ExactWaitBarrier };

export interface ExecutingLlmSnapshot {
  readonly sessionId: ConversationSessionId;
  readonly agentId: string;
  readonly role: Extract<AgentRole, 'planner' | 'reviewer' | 'executor' | 'analyst'>;
  readonly cardId: string | null;
  readonly activity: ExecutingLlmActivity;
}

export interface ToolWaitCallbacks {
  waitExternal<T>(promise: Promise<T>): Promise<T>;
  waitProcess<T>(processId: string, promise: Promise<T>): Promise<T>;
  waitChild<T>(relationship: StructuralChildRelationship, promise: Promise<T>): Promise<T>;
}

export interface LlmToolInvocationContext extends ToolInvocationIdentity {
  readonly waits: ToolWaitCallbacks;
}
