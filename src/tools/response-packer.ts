import { createHash } from 'node:crypto';

import { canonicalJson } from '../schemas/index.js';
import { canonicalValueSha256 } from '../persistence/canonical-conversation-artifacts.js';
import {
  DISCOVERY_RESPONSE_MAX_BYTES,
  DISCOVERY_RESPONSE_MIN_BYTES,
} from '../contracts/builtin-tool-inputs.js';

export { DISCOVERY_RESPONSE_MAX_BYTES, DISCOVERY_RESPONSE_MIN_BYTES };

export const DISCOVERY_FAILURE_ERROR_MAX_BYTES = 512;
export const DISCOVERY_TEXT_PREVIEW_MAX_BYTES = 512;
export const DISCOVERY_RECORD_PREVIEW_MAX_BYTES = 2048;

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

export type CollectionPage = Readonly<{
  total: number;
  position: CollectionPosition;
  returned: number;
  next: CollectionPosition | null;
  items: readonly unknown[];
}>;

export type ItemSlice = Readonly<{
  content: string;
  utf8_bytes: number;
  offset_bytes: number;
  next_offset_bytes: number;
  total_bytes: number;
}>;

export type JsonSlice = Readonly<{
  content: string;
  utf8_bytes: number;
  offset_bytes: number;
  next_offset_bytes: number;
  total_bytes: number;
}>;

export class DiscoveryBudgetTooSmallError extends Error {
  constructor(readonly requestedBytes: number) {
    super(
      `Requested response_bytes budget ${requestedBytes} cannot hold the fixed discovery response envelope plus one progress unit; raise response_bytes toward the documented minimum of ${DISCOVERY_RESPONSE_MIN_BYTES}.`,
    );
    this.name = 'DiscoveryBudgetTooSmallError';
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

export function boundedToolError(message: string): string {
  return utf8SafeSlice(message, 0, DISCOVERY_FAILURE_ERROR_MAX_BYTES).content;
}

export function successEnvelopeBytes(data: unknown): number {
  return utf8ByteLength(canonicalJson({ success: true, data }));
}

export function observationSha256(value: unknown): string {
  return canonicalValueSha256(value);
}

export function sha256OfEmptyString(): string {
  return createHash('sha256').update('', 'utf8').digest('hex');
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

export interface PackedTextData {
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
  const fits = (slice: TextSlice): boolean => successEnvelopeBytes(input.render(slice)) <= input.cap;
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

export interface PackedCollectionData {
  readonly data: unknown;
  readonly page: CollectionPage;
}

export function packCollectionData(input: Readonly<{
  cap: number;
  total: number;
  position: CollectionPosition;
  item: (index: number) => unknown;
  render: (page: CollectionPage) => unknown;
}>): PackedCollectionData {
  type Emitted =
    | { kind: 'value'; index: number; value: unknown }
    | { kind: 'slice'; index: number; json: string; startOffset: number; bytes: number };
  const emitted: Emitted[] = [];

  const materialize = (entry: Emitted): unknown => {
    if (entry.kind === 'value') return entry.value;
    const cut = utf8SafeSlice(entry.json, entry.startOffset, entry.bytes);
    return Object.freeze({
      content: cut.content,
      utf8_bytes: cut.bytes,
      offset_bytes: entry.startOffset,
      next_offset_bytes: entry.startOffset + cut.bytes,
      total_bytes: utf8ByteLength(entry.json),
    });
  };
  const pageOf = (next: CollectionPosition | null): CollectionPage => ({
    total: input.total,
    position: input.position,
    returned: emitted.length,
    next,
    items: Object.freeze(emitted.map(materialize)),
  });
  const fits = (): boolean => successEnvelopeBytes(input.render(pageOf(null))) <= input.cap;

  if (input.position.item_index >= input.total) {
    const page = pageOf(null);
    return { data: input.render(page), page };
  }

  let index = input.position.item_index;
  let itemByteOffset = input.position.item_byte_offset;
  let next: CollectionPosition | null = null;

  while (index < input.total) {
    if (itemByteOffset === 0) {
      const value = input.item(index);
      emitted.push({ kind: 'value', index, value });
      if (fits()) {
        index += 1;
        continue;
      }
      emitted.pop();
      if (emitted.length > 0) {
        next = { item_index: index, item_byte_offset: 0 };
        break;
      }
    }
    const itemJson = canonicalJson(input.item(index));
    const itemTotalBytes = utf8ByteLength(itemJson);
    if (itemByteOffset >= itemTotalBytes) {
      index += 1;
      itemByteOffset = 0;
      continue;
    }
    const fitsSlice = (bytes: number): boolean => {
      emitted.push({ kind: 'slice', index, json: itemJson, startOffset: itemByteOffset, bytes });
      const ok = fits();
      emitted.pop();
      return ok;
    };
    if (!fitsSlice(0)) {
      if (emitted.length === 0) throw new DiscoveryBudgetTooSmallError(input.cap);
      next = { item_index: index, item_byte_offset: itemByteOffset };
      break;
    }
    let low = 0;
    let high = itemTotalBytes - itemByteOffset;
    while (low < high) {
      const mid = low + Math.ceil((high - low) / 2);
      if (fitsSlice(mid)) low = mid;
      else high = mid - 1;
    }
    if (low === 0) {
      if (emitted.length === 0) throw new DiscoveryBudgetTooSmallError(input.cap);
      next = { item_index: index, item_byte_offset: itemByteOffset };
      break;
    }
    const entry: Emitted = { kind: 'slice', index, json: itemJson, startOffset: itemByteOffset, bytes: low };
    emitted.push(entry);
    const cut = utf8SafeSlice(itemJson, itemByteOffset, low);
    if (itemByteOffset + cut.bytes < itemTotalBytes) {
      next = { item_index: index, item_byte_offset: itemByteOffset + cut.bytes };
      break;
    }
    index += 1;
    itemByteOffset = 0;
  }

  while (successEnvelopeBytes(input.render(pageOf(next))) > input.cap) {
    const last = emitted.at(-1);
    if (!last) throw new DiscoveryBudgetTooSmallError(input.cap);
    const overflow = successEnvelopeBytes(input.render(pageOf(next))) - input.cap;
    if (last.kind === 'value') {
      emitted.pop();
      next = { item_index: last.index, item_byte_offset: 0 };
      continue;
    }
    const shrunk = last.bytes - Math.max(1, overflow);
    emitted.pop();
    if (shrunk <= 0) {
      next = { item_index: last.index, item_byte_offset: last.startOffset };
      continue;
    }
    const shrunkCut = utf8SafeSlice(last.json, last.startOffset, shrunk);
    emitted.push({ kind: 'slice', index: last.index, json: last.json, startOffset: last.startOffset, bytes: shrunk });
    if (last.startOffset + shrunkCut.bytes < utf8ByteLength(last.json))
      next = { item_index: last.index, item_byte_offset: last.startOffset + shrunkCut.bytes };
  }

  const page = pageOf(next);
  return { data: input.render(page), page };
}
