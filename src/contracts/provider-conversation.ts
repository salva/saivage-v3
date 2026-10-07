import type { AgentMessage, ConversationSessionId } from '../schemas/index.js';
import { canonicalJson } from '../schemas/index.js';
import type { MaterializedImage, ImageDescriptor } from './image.js';
import { ToolResultSchema } from './tool-result.js';

export type SyntheticProviderContextItem = Readonly<{
  kind: 'synthetic_context';
  role: 'system' | 'user' | 'assistant';
  content: string;
  origin:
    | 'dynamic'
    | 'context_boundary'
    | 'history_summary'
    | 'retained_instruction'
    | 'recovery_notice'
    | 'refusal_notice'
    | 'retry_notice'
    | 'summary_material';
  block_identity: string;
  images?: readonly MaterializedImage[];
}>;

export type ProviderConversationItem =
  | (AgentMessage & { readonly image?: MaterializedImage })
  | SyntheticProviderContextItem;

export type ProviderConversationProjection =
  | { sourceSessionId: ConversationSessionId; messages: ProviderConversationItem[] }
  | { sourceSessionId: null; messages: [] };

export function providerItemImageDescriptors(
  item: ProviderConversationItem,
): readonly ImageDescriptor[] {
  if (item.kind === 'synthetic_context') return item.images?.map((image) => image.descriptor) ?? [];
  if (item.kind !== 'tool_result') return [];
  const result = ToolResultSchema.parse(JSON.parse(item.content));
  return result.success && result.image ? [result.image] : [];
}

export function providerConversationRequiresImages(
  projection: ProviderConversationProjection,
): boolean {
  return projection.messages.some((item) => providerItemImageDescriptors(item).length > 0);
}

export function assertProviderItemImageMaterialized(item: ProviderConversationItem): void {
  if (item.kind === 'synthetic_context') {
    if (item.images?.length && item.role !== 'user')
      throw new Error('Summary images require user material.');
    return;
  }
  const selected = providerItemImageDescriptors(item)[0];
  if (selected && !item.image)
    throw new Error('Selected tool image must be materialized before serialization.');
  if (item.image && (!selected || canonicalJson(selected) !== canonicalJson(item.image.descriptor)))
    throw new Error('Materialized tool image does not match the selected result descriptor.');
}

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
