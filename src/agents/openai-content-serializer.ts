import {
  ToolResultSchema,
  materializedToolContent,
  type MaterializedContentBlock,
  type MaterializedImage,
  type ImageDescriptor,
} from '../contracts/index.js';
import { canonicalJson, type AgentMessage } from '../schemas/index.js';

export function openAIContentParts(
  blocks: readonly MaterializedContentBlock[],
  onImageEmitted?: (descriptor: ImageDescriptor) => void,
): Record<string, unknown>[] {
  return blocks.map((block) => {
    if (block.type === 'text') return { type: 'input_text', text: block.text };
    onImageEmitted?.(block.image.descriptor);
    return { type: 'input_image', image_url: block.image.dataUrl };
  });
}

export function openAIToolResultOutput(
  item: AgentMessage & { readonly images?: readonly MaterializedImage[] },
  onImageEmitted?: (descriptor: ImageDescriptor) => void,
): string | Record<string, unknown>[] {
  const result = ToolResultSchema.parse(JSON.parse(item.content));
  if (!result.success || !result.content) return item.content;
  const { content, ...metadata } = result;
  return [
    { type: 'input_text', text: canonicalJson(metadata) },
    ...openAIContentParts(materializedToolContent(content, item.images ?? []), onImageEmitted),
  ];
}
