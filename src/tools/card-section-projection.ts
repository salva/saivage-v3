import type { CardRecord } from '../schemas/index.js';
import { projectCardRecordForOutbound } from '../application/read-models/card-outbound.js';
import { cardParentId } from '../schemas/card-id.js';
import { redactTextForOutbound } from '../redaction/index.js';
import { ToolArgumentValidationError } from './invocation.js';
import { DISCOVERY_TEXT_PREVIEW_MAX_BYTES, utf8ByteLength, utf8SafePreview } from './response-packer.js';
import { settledSuccessBytes } from './tool-result-settlement.js';

export function projectBoundedCardSummary(input: { base: Record<string, unknown>; card: CardRecord; responseBytes: number }): Record<string, unknown> {
  const projected = projectCardRecordForOutbound(input.card);
  const data = { ...input.base, card: { id: projected.id, type: projected.type, status: projected.lifecycle.status, title: utf8SafePreview(redactTextForOutbound(input.card.title), DISCOVERY_TEXT_PREVIEW_MAX_BYTES), priority: projected.priority, urgency: projected.urgency, parent: cardParentId(projected.id), created_at: projected.created_at, updated_at: projected.updated_at, status_text: projected.status_text === null ? null : utf8SafePreview(projected.status_text, DISCOVERY_TEXT_PREVIEW_MAX_BYTES) } };
  if (utf8ByteLength(settledSuccessBytes(data)) > input.responseBytes) throw new ToolArgumentValidationError(`Section 'summary' does not fit the requested response_bytes budget of ${input.responseBytes}.`);
  return data;
}
