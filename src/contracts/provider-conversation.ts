import type { AgentMessage, ConversationSessionId } from '../schemas/index.js';
import { canonicalJson } from '../schemas/index.js';
import type { MaterializedImage, ImageDescriptor } from './image.js';
import { ToolResultSchema, type ToolResultContentBlock } from './tool-result.js';

export type MaterializedContentBlock =
  | Readonly<{ type: 'text'; text: string }>
  | Readonly<{ type: 'image'; image: MaterializedImage }>;

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
  contentBlocks?: readonly MaterializedContentBlock[];
}>;

export type ProviderConversationItem =
  | (AgentMessage & { readonly images?: readonly MaterializedImage[] })
  | SyntheticProviderContextItem;

export type ProviderConversationProjection =
  | { sourceSessionId: ConversationSessionId; messages: ProviderConversationItem[] }
  | { sourceSessionId: null; messages: [] };

export function providerItemImageDescriptors(
  item: ProviderConversationItem,
): readonly ImageDescriptor[] {
  if (item.kind === 'synthetic_context')
    return (
      item.contentBlocks?.flatMap((block) =>
        block.type === 'image' ? [block.image.descriptor] : [],
      ) ?? []
    );
  if (item.kind !== 'tool_result') return [];
  const result = ToolResultSchema.parse(JSON.parse(item.content));
  return result.success
    ? (result.content?.flatMap((block) => (block.type === 'image' ? [block.image] : [])) ?? [])
    : [];
}

export function providerConversationRequiresImages(
  projection: ProviderConversationProjection,
): boolean {
  return projection.messages.some((item) => providerItemImageDescriptors(item).length > 0);
}

export function assertProviderItemImageMaterialized(item: ProviderConversationItem): void {
  if (item.kind === 'synthetic_context') {
    if (providerItemImageDescriptors(item).length && item.role !== 'user')
      throw new Error('Summary images require user material.');
    return;
  }
  const selected = providerItemImageDescriptors(item);
  if (selected.length !== (item.images?.length ?? 0))
    throw new Error('Selected tool image must be materialized before serialization.');
  if (
    selected.some(
      (descriptor, index) =>
        canonicalJson(descriptor) !== canonicalJson(item.images![index]!.descriptor),
    )
  )
    throw new Error('Materialized tool image does not match the selected result descriptor.');
}

/** Exact positional correspondence is checked before emitting any native provider parts. */
export function materializedToolContent(
  content: readonly ToolResultContentBlock[],
  images: readonly MaterializedImage[],
): readonly MaterializedContentBlock[] {
  let index = 0;
  const blocks = content.map((block): MaterializedContentBlock => {
    if (block.type === 'text') return block;
    const image = images[index++];
    if (!image || canonicalJson(block.image) !== canonicalJson(image.descriptor))
      throw new Error('Materialized tool image does not match the selected result descriptor.');
    return { type: 'image', image };
  });
  if (index !== images.length) throw new Error('Unexpected materialized tool images.');
  return blocks;
}

export function providerContentParts(
  blocks: readonly MaterializedContentBlock[],
  onImageEmitted?: (descriptor: ImageDescriptor) => void,
): Record<string, unknown>[] {
  return blocks.map((block) => {
    if (block.type === 'text') return { type: 'input_text', text: block.text };
    onImageEmitted?.(block.image.descriptor);
    return { type: 'input_image', image_url: block.image.dataUrl };
  });
}

export function providerToolResultOutput(
  item: AgentMessage & { readonly images?: readonly MaterializedImage[] },
  onImageEmitted?: (descriptor: ImageDescriptor) => void,
): string | Record<string, unknown>[] {
  const result = ToolResultSchema.parse(JSON.parse(item.content));
  if (!result.success || !result.content) return item.content;
  const { content, ...metadata } = result;
  return [
    { type: 'input_text', text: canonicalJson(metadata) },
    ...providerContentParts(materializedToolContent(content, item.images ?? []), onImageEmitted),
  ];
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
