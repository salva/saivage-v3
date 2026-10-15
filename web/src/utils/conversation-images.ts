import { ToolResultSchema } from '../../../src/contracts/tool-result';
import { ViewImageDataSchema } from '../../../src/contracts/view-image';
import { ImageNormalizationFactsSchema, type ImageNormalizationFacts } from '../../../src/contracts/image-normalization';
import type { ConversationImageLocator } from '../api/contracts';
import type { AgentConversationEntry } from '../api/types';

export type ImageContext = Pick<ConversationImageLocator, 'session_id' | 'segment_version' | 'segment_id'>;
export interface ImageSelection {
  locator: ConversationImageLocator;
  width: number;
  height: number;
  metadata: string;
}
export type PreviewSelection = { kind: 'conversation'; image: ImageSelection } | { kind: 'file'; path: string };
function normalizationLabel(label: string, facts: ImageNormalizationFacts): string {
  return `${label} · Source ${facts.source_dimensions.width} × ${facts.source_dimensions.height} · Orientation-adjusted ${facts.oriented_dimensions.width} × ${facts.oriented_dimensions.height} · Sent ${facts.sent_dimensions.width} × ${facts.sent_dimensions.height} · ${facts.resized ? 'Resized' : 'Not resized'}`;
}
export function conversationImages(entry: AgentConversationEntry | null | undefined, context: ImageContext | undefined, tool: string): ImageSelection[] {
  if (!entry || entry.kind !== 'tool_result' || !context) return [];
  let value: unknown;
  try { value = JSON.parse(entry.content); } catch { return []; }
  const result = ToolResultSchema.safeParse(value);
  if (!result.success || !result.data.success) return [];
  const data = result.data.data;
  return (result.data.content ?? []).flatMap((part, index) => {
    if (part.type !== 'image') return [];
    let metadata = 'Original dimensions not recorded';
    // Optional producer metadata enriches labels; it never admits or hides images.
    if (tool === 'view_image') {
      const parsed = ViewImageDataSchema.safeParse(data);
      if (parsed.success && parsed.data.sent_dimensions.width === part.image.width && parsed.data.sent_dimensions.height === part.image.height)
        metadata = normalizationLabel(parsed.data.source_path, parsed.data);
    } else if (tool === 'mcp_tool_call' && data && typeof data === 'object' && 'images' in data && Array.isArray(data.images)) {
      const candidate = data.images.find((capture: unknown) => capture && typeof capture === 'object' && 'content_index' in capture && capture.content_index === index);
      const capture = candidate && typeof candidate === 'object'
        ? Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== 'content_index')) : undefined;
      const parsed = ImageNormalizationFactsSchema.safeParse(capture);
      if (parsed.success && parsed.data.sent_dimensions.width === part.image.width && parsed.data.sent_dimensions.height === part.image.height)
        metadata = normalizationLabel('Native MCP capture', parsed.data);
    }
    return [{ locator: { ...context, message_id: entry.id, content_index: index, image_id: part.image.id }, width: part.image.width, height: part.image.height, metadata }];
  });
}
