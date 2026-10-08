import { ToolResultSchema } from '../../../src/contracts/tool-result';
import { ViewImageDataSchema } from '../../../src/contracts/view-image';
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
    const candidate = tool === 'view_image' ? data : tool === 'mcp_tool_call' && data && typeof data === 'object' && 'images' in data && Array.isArray(data.images)
      ? data.images.find((capture: unknown) => capture && typeof capture === 'object' && 'content_index' in capture && capture.content_index === index) : undefined;
    // Optional producer metadata enriches labels; it never admits or hides images.
    const capture = candidate && typeof candidate === 'object' && 'content_index' in candidate
      ? Object.fromEntries(Object.entries(candidate).filter(([key]) => key !== 'content_index')) : candidate;
    const parsed = ViewImageDataSchema.safeParse(tool === 'mcp_tool_call' && capture && typeof capture === 'object' ? { ...capture, source_path: 'Native MCP capture' } : capture);
    if (parsed.success && parsed.data.sent_dimensions.width === part.image.width && parsed.data.sent_dimensions.height === part.image.height) {
      const m = parsed.data;
      metadata = `${m.source_path} · Source ${m.source_dimensions.width} × ${m.source_dimensions.height} · Orientation-adjusted ${m.oriented_dimensions.width} × ${m.oriented_dimensions.height} · Sent ${m.sent_dimensions.width} × ${m.sent_dimensions.height} · ${m.resized ? 'Resized' : 'Not resized'}`;
    }
    return [{ locator: { ...context, message_id: entry.id, content_index: index, image_id: part.image.id }, width: part.image.width, height: part.image.height, metadata }];
  });
}
