import { NativeMcpResultSchema } from '../mcp/tool-api.js';
import {
  MAX_IMAGE_SOURCE_BYTES,
  toolContentSucceeded,
  toolFailed,
  toolSucceeded,
  type ToolActionOutcome,
  type ToolResultContentBlock,
} from '../contracts/index.js';
import type { ConversationSessionId } from '../schemas/index.js';
import { canonicalJson } from '../schemas/index.js';
import { projectDynamicForOutbound } from '../redaction/index.js';
import { publishConversationImage } from '../persistence/session-api.js';
import { normalizeImage } from './image-decode.js';
import { ImageInputError } from './image-input-error.js';

const NON_IMAGE_LIMIT = 1024 * 1024;
const NATIVE_TOOL_ERROR = 'MCP tool reported an error; effects may have occurred.';

export async function projectNativeMcpResult(
  value: unknown,
  projectRoot: string,
  sessionId: ConversationSessionId,
  signal: AbortSignal,
  maxDimension: number | 'original' = 1600,
): Promise<ToolActionOutcome> {
  signal.throwIfAborted();
  const parsed = NativeMcpResultSchema.safeParse(value);
  if (!parsed.success) throw new ImageInputError('Malformed native MCP tool result.');
  const { content, ...envelope } = parsed.data;
  const data: Record<string, unknown> = { result: projectDynamicForOutbound(envelope) };
  const metadata: unknown[] = [];
  const captures: unknown[] = [];
  const blocks: (
    | { type: 'text'; text: string }
    | { type: 'image'; selected: Awaited<ReturnType<typeof normalizeImage>> }
  )[] = [];
  let sourceBytes = 0;
  for (const [index, block] of content.entries()) {
    signal.throwIfAborted();
    if (block.type === 'image') {
      const { data: encoded, ...safeMetadata } = block;
      metadata.push({
        content_index: index,
        ...(projectDynamicForOutbound(safeMetadata) as object),
      });
      if (parsed.data.isError) continue;
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(block.mimeType))
        throw new ImageInputError('Unsupported native image MIME.');
      if (
        encoded.length > Math.ceil(MAX_IMAGE_SOURCE_BYTES / 3) * 4 ||
        encoded.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded) ||
        !encoded.length
      )
        throw new ImageInputError('Invalid or oversized native image base64.');
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded)
        throw new ImageInputError('Invalid native image base64.');
      sourceBytes += bytes.length;
      if (sourceBytes > MAX_IMAGE_SOURCE_BYTES)
        throw new ImageInputError('Native image sources exceed aggregate 32 MiB.');
      const selected = await normalizeImage(bytes, maxDimension, block.mimeType);
      signal.throwIfAborted();
      captures.push({ content_index: index, ...selected.data });
      blocks.push({ type: 'image', selected });
    } else if (block.type === 'text') {
      const { text, ...rest } = block;
      metadata.push({ content_index: index, ...(projectDynamicForOutbound(rest) as object) });
      blocks.push({ type: 'text', text: projectDynamicForOutbound(text) as string });
    } else {
      blocks.push({ type: 'text', text: canonicalJson(projectDynamicForOutbound(block)) });
    }
  }
  if (metadata.length) data.native_content = metadata;
  if (captures.length) data.images = captures;
  // Count the complete projected non-image representation, including JSON escaping.
  const text = blocks.filter((block) => block.type === 'text');
  // UUID/hash values have fixed ASCII lengths; sizing descriptors needs no publication.
  const measuredContent = blocks.map((block) =>
    block.type === 'text'
      ? block
      : {
          type: 'image',
          image: {
            id: '00000000-0000-4000-8000-000000000000',
            mime_type: 'image/png',
            ...block.selected.data.sent_dimensions,
            byte_length: block.selected.bytes.length,
            sha256: '0'.repeat(64),
          },
        },
  );
  const measuredResult = parsed.data.isError
    ? { success: false, error: NATIVE_TOOL_ERROR, data: { ...data, content: text } }
    : { success: true, data, ...(measuredContent.length ? { content: measuredContent } : {}) };
  if (Buffer.byteLength(canonicalJson(measuredResult), 'utf8') > NON_IMAGE_LIMIT)
    throw new ImageInputError('Complete native MCP text/JSON exceeds 1 MiB.');
  if (parsed.data.isError) {
    data.content = text;
    return toolFailed(NATIVE_TOOL_ERROR, data);
  }
  // No await or input conversion between this fence and the synchronous publications.
  signal.throwIfAborted();
  const selectedContent: ToolResultContentBlock[] = blocks.map((block) =>
    block.type === 'text'
      ? block
      : {
          type: 'image',
          image: publishConversationImage(
            projectRoot,
            sessionId,
            block.selected.bytes,
            block.selected.data.sent_dimensions,
          ),
        },
  );
  return selectedContent.length ? toolContentSucceeded(data, selectedContent) : toolSucceeded(data);
}
