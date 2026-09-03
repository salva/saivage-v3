import { describe, expect, it } from '@jest/globals';

import { canonicalJson } from '../../src/schemas/index.js';
import {
  boundedToolError,
  DiscoveryBudgetTooSmallError,
  DISCOVERY_RESPONSE_MAX_BYTES,
  DISCOVERY_RESPONSE_MIN_BYTES,
  observationSha256,
  packCollectionData,
  packTextSliceData,
  utf8ByteLength,
  utf8SafePreview,
  utf8SafeSlice,
} from '../../src/tools/response-packer.js';
import { settledSuccessBytes } from '../../src/tools/tool-result-settlement.js';

const envelope = (data: unknown): number => Buffer.byteLength(canonicalJson({ success: true, data }), 'utf8');

describe('response packer primitives', () => {
  it('slices text on UTF-8 boundaries and never splits a code point', () => {
    const text = 'héllo wörld 🚀 éè';
    for (let max = 1; max <= utf8ByteLength(text); max += 1) {
      const cut = utf8SafeSlice(text, 0, max);
      expect(Buffer.byteLength(cut.content, 'utf8')).toBe(cut.bytes);
      expect(text.startsWith(cut.content)).toBe(true);
    }
    expect(utf8SafeSlice(text, 2, 100).bytes).toBe(utf8ByteLength(text) - 2);
    expect(() => utf8SafeSlice(text, utf8ByteLength(text) + 1, 1)).toThrow(/outside the observed byte range/u);
  });

  it('bounds failure error text byte-safely', () => {
    const long = `x`.repeat(5000);
    expect(Buffer.byteLength(boundedToolError(long), 'utf8')).toBeLessThanOrEqual(512);
    expect(boundedToolError('short')).toBe('short');
  });

  it('packs the maximal text slice that keeps the exact envelope within the cap', () => {
    const text = 'ä'.repeat(4000);
    const { data, slice } = packTextSliceData({
      text,
      byteOffset: 0,
      cap: 900,
      render: (candidate) => ({ total_bytes: utf8ByteLength(text), content: candidate }),
    });
    expect(envelope(data)).toBeLessThanOrEqual(900);
    expect(slice.utf8_bytes % 2).toBe(0);
    expect(slice.next_offset_bytes).toBe(slice.utf8_bytes);
    const grew = packTextSliceData({ text, byteOffset: 0, cap: 901, render: (candidate) => ({ total_bytes: utf8ByteLength(text), content: candidate }) });
    expect(grew.slice.utf8_bytes).toBeGreaterThanOrEqual(slice.utf8_bytes);
  });

  it('rejects a cap that cannot hold the fixed text envelope', () => {
    expect(() => packTextSliceData({ text: 'abc', byteOffset: 0, cap: 60, render: (candidate) => ({ prefix: 'x'.repeat(80), content: candidate }) })).toThrow(DiscoveryBudgetTooSmallError);
  });

  it('emits an empty terminal slice for exhausted text', () => {
    const { slice } = packTextSliceData({ text: 'abc', byteOffset: 3, cap: DISCOVERY_RESPONSE_MIN_BYTES, render: (candidate) => ({ content: candidate }) });
    expect(slice).toEqual({ content: '', utf8_bytes: 0, offset_bytes: 3, next_offset_bytes: 3 });
  });

  it('packs whole collection items greedily until the cap stops the page', () => {
    const items = Array.from({ length: 500 }, (_, index) => ({ id: `card-${index}`, title: `Ünïcödé title ${index}` }));
    const { page, data } = packCollectionData({
      cap: 2048,
      total: items.length,
      position: { item_index: 0, item_byte_offset: 0 },
      item: (index) => items[index]!,
      render: (candidate) => ({ observation: 'fixed', cards: candidate }),
    });
    expect(envelope(data)).toBeLessThanOrEqual(2048);
    expect(page.position).toEqual({ item_index: 0, item_byte_offset: 0 });
    expect(page.returned).toBeGreaterThan(0);
    expect(page.returned).toBeLessThan(items.length);
    expect(page.next).toEqual({ item_index: page.returned, item_byte_offset: 0 });
    expect(page.items[0]).toEqual(items[0]);

    const next = packCollectionData({
      cap: 2048,
      total: items.length,
      position: page.next!,
      item: (index) => items[index]!,
      render: (candidate) => ({ observation: 'fixed', cards: candidate }),
    });
    expect(next.page.position).toEqual(page.next);
    expect(next.page.items[0]).toEqual(items[page.returned]);
  });

  it('slices an oversized single item and resumes the same item at its byte offset', () => {
    const huge = { id: 'card-huge', change: 'ß'.repeat(5000) };
    const { page, data } = packCollectionData({
      cap: 700,
      total: 1,
      position: { item_index: 0, item_byte_offset: 0 },
      item: () => huge,
      render: (candidate) => ({ versions: candidate }),
    });
    expect(envelope(data)).toBeLessThanOrEqual(700);
    expect(page.items).toHaveLength(1);
    const slice = page.items[0] as { content: string; utf8_bytes: number; offset_bytes: number; next_offset_bytes: number; total_bytes: number };
    expect(slice.offset_bytes).toBe(0);
    expect(slice.total_bytes).toBe(utf8ByteLength(canonicalJson(huge)));
    expect(slice.next_offset_bytes).toBeGreaterThan(0);
    expect(page.next).toEqual({ item_index: 0, item_byte_offset: slice.next_offset_bytes });

    let offset = slice.next_offset_bytes;
    const chunks = [slice.content];
    while (offset < slice.total_bytes) {
      const resume = packCollectionData({
        cap: 700,
        total: 1,
        position: { item_index: 0, item_byte_offset: offset },
        item: () => huge,
        render: (candidate) => ({ versions: candidate }),
      });
      const resumeSlice = resume.page.items[0] as { content: string; utf8_bytes: number; offset_bytes: number; next_offset_bytes: number };
      expect(resumeSlice.offset_bytes).toBe(offset);
      chunks.push(resumeSlice.content);
      offset = resumeSlice.next_offset_bytes;
    }
    expect(chunks.join('')).toBe(canonicalJson(huge));
  });

  it('rejects a collection cap that cannot emit one progress unit', () => {
    expect(() => packCollectionData({
      cap: 80,
      total: 1,
      position: { item_index: 0, item_byte_offset: 0 },
      item: () => ({ id: 'card-a' }),
      render: (candidate) => ({ prefix: 'x'.repeat(90), cards: candidate }),
    })).toThrow(DiscoveryBudgetTooSmallError);
  });

  it('observes a shrunk collection as an empty terminal page', () => {
    const { page, data } = packCollectionData({
      cap: DISCOVERY_RESPONSE_MIN_BYTES,
      total: 0,
      position: { item_index: 5, item_byte_offset: 0 },
      item: () => ({ id: 'gone' }),
      render: (candidate) => ({ cards: candidate }),
    });
    expect(page).toEqual({ total: 0, position: { item_index: 5, item_byte_offset: 0 }, returned: 0, next: null, items: [] });
    expect(envelope(data)).toBeLessThanOrEqual(DISCOVERY_RESPONSE_MIN_BYTES);
  });

  it('exposes the exact discovery byte constants and deterministic observation hashing', () => {
    expect(DISCOVERY_RESPONSE_MAX_BYTES).toBe(32768);
    expect(DISCOVERY_RESPONSE_MIN_BYTES).toBe(512);
    expect(observationSha256({ b: 1, a: 2 })).toBe(observationSha256({ a: 2, b: 1 }));
    expect(observationSha256({ a: 1 })).not.toBe(observationSha256({ a: 2 }));
    expect(Buffer.byteLength(settledSuccessBytes({ x: 1 }), 'utf8')).toBe(envelope({ x: 1 }));
    expect(utf8SafePreview('tïtle'.repeat(200), 8)).toBe('tïtlet');
    expect(Buffer.byteLength(utf8SafePreview('tïtle'.repeat(200), 8), 'utf8')).toBeLessThanOrEqual(8);
  });
});
