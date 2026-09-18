import { canonicalJson } from '../schemas/index.js';
import { canonicalValueSha256 } from '../persistence/canonical-conversation-artifacts.js';
import {
  DISCOVERY_RESPONSE_MAX_BYTES,
  DISCOVERY_RESPONSE_MIN_BYTES,
} from '../contracts/builtin-tool-inputs.js';
import { projectDynamicForOutbound } from '../redaction/dynamic.js';
import { settledSuccessBytes } from './tool-result-settlement.js';

export { DISCOVERY_RESPONSE_MAX_BYTES, DISCOVERY_RESPONSE_MIN_BYTES };

const DISCOVERY_FAILURE_ERROR_MAX_BYTES = 512;
export const DISCOVERY_TEXT_PREVIEW_MAX_BYTES = 512;

export type TextSlice = Readonly<{
  content: string;
  utf8_bytes: number;
  offset_bytes: number;
  next_offset_bytes: number;
}>;

export type CollectionPosition = Readonly<{
  item_index: number;
  item_byte_offset: number;
}>;

type JsonSlice = Readonly<{
  content_hex: string;
  utf8_bytes: number;
  offset_bytes: number;
  next_offset_bytes: number;
  total_bytes: number;
}>;

export type CollectionPage = Readonly<{
  total: number;
  position: CollectionPosition;
  returned: number;
  next: CollectionPosition | null;
  items: readonly unknown[];
}>;

export class DiscoveryBudgetTooSmallError extends Error {
  constructor(readonly requestedBytes: number) {
    super(
      `Requested response_bytes budget ${requestedBytes} cannot hold the fixed discovery response envelope plus one progress unit; raise response_bytes toward the documented minimum of ${DISCOVERY_RESPONSE_MIN_BYTES}.`,
    );
    this.name = 'DiscoveryBudgetTooSmallError';
  }
}

export class DiscoveryCollectionPositionError extends Error {
  constructor() {
    super('Collection position must identify an existing item and a UTF-8 boundary strictly inside its complete outbound-projected canonical JSON bytes.');
    this.name = 'DiscoveryCollectionPositionError';
  }
}

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function utf8SafeSlice(text: string, offsetBytes: number, maxBytes: number): { content: string; bytes: number } {
  const buffer = Buffer.from(text, 'utf8');
  if (offsetBytes < 0 || offsetBytes > buffer.length) throw new Error('UTF-8 slice offset is outside the observed byte range.');
  let end = Math.min(buffer.length, offsetBytes + maxBytes);
  while (end > offsetBytes && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return { content: buffer.subarray(offsetBytes, end).toString('utf8'), bytes: end - offsetBytes };
}

export function utf8SafePreview(text: string, maxBytes: number): string {
  return utf8SafeSlice(text, 0, maxBytes).content;
}

export function certifiedPrefixEndpoints(
  stable: Readonly<{
    text: string;
    maxPrefixEnd: number;
    indivisibleSpans: readonly Readonly<{ start: number; end: number }>[];
  }>,
  maximumEnd: number,
  maximumBytes: number,
): number[] {
  const endpoints = [0];
  let end = 0;
  let bytes = 0;
  let spanIndex = 0;
  for (const character of stable.text) {
    end += character.length;
    bytes += Buffer.byteLength(character, 'utf8');
    while (stable.indivisibleSpans[spanIndex] && stable.indivisibleSpans[spanIndex]!.end <= end) spanIndex += 1;
    const span = stable.indivisibleSpans[spanIndex];
    const insideSpan = span !== undefined && span.start < end && end < span.end;
    if (end <= stable.maxPrefixEnd && end <= maximumEnd && bytes <= maximumBytes && !insideSpan) endpoints.push(end);
  }
  return endpoints;
}

export function boundedToolError(message: string): string {
  return utf8SafeSlice(message, 0, DISCOVERY_FAILURE_ERROR_MAX_BYTES).content;
}

export function observationSha256(value: unknown): string {
  return canonicalValueSha256(value);
}

function makeTextSlice(text: string, offsetBytes: number, maxBytes: number): TextSlice {
  const cut = utf8SafeSlice(text, offsetBytes, maxBytes);
  return Object.freeze({
    content: cut.content,
    utf8_bytes: cut.bytes,
    offset_bytes: offsetBytes,
    next_offset_bytes: offsetBytes + cut.bytes,
  });
}

interface PackedTextData {
  readonly data: unknown;
  readonly slice: TextSlice;
}

export function packTextSliceData(input: Readonly<{
  text: string;
  byteOffset: number;
  cap: number;
  render: (slice: TextSlice) => unknown;
}>): PackedTextData {
  const total = utf8ByteLength(input.text);
  const offset = Math.min(input.byteOffset, total);
  const make = (maxBytes: number): TextSlice => makeTextSlice(input.text, offset, maxBytes);
  const fits = (slice: TextSlice): boolean => utf8ByteLength(settledSuccessBytes(input.render(slice))) <= input.cap;
  if (!fits(make(0))) throw new DiscoveryBudgetTooSmallError(input.cap);
  let low = 0;
  let high = total - offset;
  while (low < high) {
    const mid = low + Math.ceil((high - low) / 2);
    if (fits(make(mid))) low = mid;
    else high = mid - 1;
  }
  const slice = make(low);
  return { data: input.render(slice), slice };
}

interface PackedCollectionData {
  readonly data: unknown;
  readonly page: CollectionPage;
}

export function packCollectionData(input: Readonly<{
  cap: number;
  total: number;
  position: CollectionPosition;
  maxItems?: number;
  item: (index: number) => unknown;
  render: (page: CollectionPage) => unknown;
}>): PackedCollectionData {
  if (input.maxItems !== undefined && (!Number.isSafeInteger(input.maxItems) || input.maxItems < 1)) {
    throw new RangeError('maxItems must be a positive safe integer.');
  }

  const emitted: unknown[] = [];
  const pageOf = (items: readonly unknown[], next: CollectionPosition | null): CollectionPage => ({
    total: input.total,
    position: input.position,
    returned: items.length,
    next,
    items: Object.freeze([...items]),
  });
  const renderPage = (items: readonly unknown[], next: CollectionPosition | null): PackedCollectionData => {
    const page = pageOf(items, next);
    const data = input.render(page);
    if (utf8ByteLength(settledSuccessBytes(data)) > input.cap) throw new DiscoveryBudgetTooSmallError(input.cap);
    return { data, page };
  };
  const fits = (items: readonly unknown[], next: CollectionPosition | null): boolean =>
    utf8ByteLength(settledSuccessBytes(input.render(pageOf(items, next)))) <= input.cap;

  const invalidPosition = (): never => { throw new DiscoveryCollectionPositionError(); };

  if (input.position.item_index >= input.total) {
    if (input.position.item_byte_offset !== 0) invalidPosition();
    return renderPage([], null);
  }

  const windowEnd = Math.min(input.total, input.position.item_index + (input.maxItems ?? input.total));
  let index = input.position.item_index;
  let itemByteOffset = input.position.item_byte_offset;

  const continuationAfter = (completedIndex: number): CollectionPosition | null =>
    completedIndex + 1 < input.total ? { item_index: completedIndex + 1, item_byte_offset: 0 } : null;
  const sliceOf = (bytes: Buffer, start: number, end: number): JsonSlice => Object.freeze({
    content_hex: bytes.subarray(start, end).toString('hex'),
    utf8_bytes: end - start,
    offset_bytes: start,
    next_offset_bytes: end,
    total_bytes: bytes.length,
  });
  const boundaryAtOrBefore = (bytes: Buffer, start: number, requestedEnd: number): number => {
    let end = requestedEnd;
    while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    return end;
  };

  while (index < windowEnd) {
    const value = input.item(index);
    const itemBytes = Buffer.from(canonicalJson(projectDynamicForOutbound(value)), 'utf8');
    if (itemByteOffset !== 0 && (
      itemByteOffset < 0
      || itemByteOffset >= itemBytes.length
      || (itemBytes[itemByteOffset]! & 0xc0) === 0x80
    )) invalidPosition();

    const completedNext = continuationAfter(index);
    if (itemByteOffset === 0 && fits([...emitted, value], completedNext)) {
      emitted.push(value);
      index += 1;
      if (index === windowEnd) return renderPage(emitted, index < input.total ? { item_index: index, item_byte_offset: 0 } : null);
      continue;
    }
    if (itemByteOffset === 0 && emitted.length > 0) {
      return renderPage(emitted, { item_index: index, item_byte_offset: 0 });
    }

    const completeSlice = sliceOf(itemBytes, itemByteOffset, itemBytes.length);
    if (fits([...emitted, completeSlice], completedNext)) {
      emitted.push(completeSlice);
      index += 1;
      itemByteOffset = 0;
      if (index === windowEnd) return renderPage(emitted, index < input.total ? { item_index: index, item_byte_offset: 0 } : null);
      continue;
    }

    let firstEnd = itemByteOffset + 1;
    while (firstEnd < itemBytes.length && (itemBytes[firstEnd]! & 0xc0) === 0x80) firstEnd += 1;
    if (firstEnd >= itemBytes.length) throw new DiscoveryBudgetTooSmallError(input.cap);
    const firstSlice = sliceOf(itemBytes, itemByteOffset, firstEnd);
    if (!fits([...emitted, firstSlice], { item_index: index, item_byte_offset: firstEnd })) {
      throw new DiscoveryBudgetTooSmallError(input.cap);
    }

    let low = firstEnd;
    let high = itemBytes.length - 1;
    while (low < high) {
      const requestedEnd = low + Math.ceil((high - low) / 2);
      const end = boundaryAtOrBefore(itemBytes, itemByteOffset, requestedEnd);
      const candidate = sliceOf(itemBytes, itemByteOffset, end);
      if (fits([...emitted, candidate], { item_index: index, item_byte_offset: end })) low = requestedEnd;
      else high = requestedEnd - 1;
    }
    const end = boundaryAtOrBefore(itemBytes, itemByteOffset, low);
    emitted.push(sliceOf(itemBytes, itemByteOffset, end));
    return renderPage(emitted, { item_index: index, item_byte_offset: end });
  }

  throw new Error('Collection packer reached an impossible nonterminal state.');
}
