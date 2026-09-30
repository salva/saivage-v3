import type { AgentMessage, ConversationSessionId } from '../schemas/index.js';

export type SyntheticProviderContextItem = Readonly<{
  kind: 'synthetic_context';
  role: 'system' | 'user' | 'assistant';
  content: string;
  origin: 'dynamic' | 'context_boundary' | 'history_summary' | 'retained_instruction' | 'recovery_notice' | 'refusal_notice' | 'retry_notice' | 'summary_material';
  block_identity: string;
}>;

export type ProviderConversationItem = AgentMessage | SyntheticProviderContextItem;

export type ProviderConversationProjection =
  | { sourceSessionId: ConversationSessionId; messages: ProviderConversationItem[] }
  | { sourceSessionId: null; messages: [] };

export function assertProviderConversationSourceRows(
  providerConversation: ProviderConversationProjection,
): void {
  if (providerConversation.sourceSessionId === null) return;
  const wrongSession = providerConversation.messages.find(
    (message): message is AgentMessage =>
      message.kind !== 'synthetic_context' &&
      message.session_id !== providerConversation.sourceSessionId,
  );
  if (wrongSession)
    throw new Error(
      `Provider conversation row '${wrongSession.id}' belongs to session '${wrongSession.session_id}', not source session '${providerConversation.sourceSessionId}'.`,
    );
}
