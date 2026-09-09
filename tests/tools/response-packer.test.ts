import { describe, expect, it } from '@jest/globals';

import { canonicalJson } from '../../src/schemas/index.js';
import {
  boundedToolError,
  DiscoveryBudgetTooSmallError,
  DiscoveryCollectionPositionError,
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
import { projectDynamicForOutbound } from '../../src/redaction/dynamic.js';
import { redactTextForOutbound } from '../../src/redaction/index.js';

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
    const slice = page.items[0] as { content_hex: string; utf8_bytes: number; offset_bytes: number; next_offset_bytes: number; total_bytes: number };
    expect(slice.offset_bytes).toBe(0);
    expect(slice.total_bytes).toBe(utf8ByteLength(canonicalJson(huge)));
    expect(slice.next_offset_bytes).toBeGreaterThan(0);
    expect(slice.content_hex).toMatch(/^(?:[0-9a-f]{2})+$/u);
    expect(Buffer.from(slice.content_hex, 'hex')).toHaveLength(slice.utf8_bytes);
    expect(page.next).toEqual({ item_index: 0, item_byte_offset: slice.next_offset_bytes });

    let offset = slice.next_offset_bytes;
    const chunks = [Buffer.from(slice.content_hex, 'hex')];
    while (offset < slice.total_bytes) {
      const resume = packCollectionData({
        cap: 700,
        total: 1,
        position: { item_index: 0, item_byte_offset: offset },
        item: () => huge,
        render: (candidate) => ({ versions: candidate }),
      });
      const resumeSlice = resume.page.items[0] as { content_hex: string; utf8_bytes: number; offset_bytes: number; next_offset_bytes: number; total_bytes: number };
      expect(resumeSlice.offset_bytes).toBe(offset);
      expect(Buffer.from(resumeSlice.content_hex, 'hex')).toHaveLength(resumeSlice.utf8_bytes);
      chunks.push(Buffer.from(resumeSlice.content_hex, 'hex'));
      offset = resumeSlice.next_offset_bytes;
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe(canonicalJson(huge));
  });

  it('hex-slices the explicit complete outbound projection across changing budgets without exposing contextual secrets', () => {
    const item = {
      benign: `ask-secret-tail art_secret_tail atok_secret_tail aghu_secret_tail ${'🚀 quoted " text \\ '.repeat(3000)}`,
      api_key: 'synthetic-secret-value',
      assignment: 'token=synthetic-token-value',
    };
    const explicitProjected = {
      benign: item.benign,
      api_key: '[REDACTED]',
      assignment: 'token=[REDACTED]',
    };
    expect(projectDynamicForOutbound(item)).toEqual(explicitProjected);
    const expected = canonicalJson(explicitProjected);
    let position = { item_index: 0, item_byte_offset: 0 };
    const chunks: Buffer[] = [];
    const caps = [DISCOVERY_RESPONSE_MIN_BYTES, 777, 1024, DISCOVERY_RESPONSE_MAX_BYTES];
    let pageNumber = 0;
    for (;;) {
      const cap = caps[pageNumber % caps.length]!;
      const packed = packCollectionData({
        cap,
        total: 1,
        position,
        item: () => item,
        render: (candidate) => ({ cards: candidate }),
      });
      expect(Buffer.byteLength(settledSuccessBytes(packed.data), 'utf8')).toBeLessThanOrEqual(cap);
      const slice = packed.page.items[0] as { content_hex: string; utf8_bytes: number; offset_bytes: number; next_offset_bytes: number; total_bytes: number };
      expect(slice.content_hex).toMatch(/^(?:[0-9a-f]{2})+$/u);
      const decoded = Buffer.from(slice.content_hex, 'hex');
      expect(decoded).toHaveLength(slice.utf8_bytes);
      expect(slice.next_offset_bytes - slice.offset_bytes).toBe(slice.utf8_bytes);
      expect(slice.total_bytes).toBe(Buffer.byteLength(expected, 'utf8'));
      expect(decoded).toEqual(Buffer.from(expected, 'utf8').subarray(slice.offset_bytes, slice.next_offset_bytes));
      chunks.push(decoded);
      if (packed.page.next === null) break;
      expect(packed.page.next.item_byte_offset).toBeGreaterThan(position.item_byte_offset);
      position = packed.page.next;
      pageNumber += 1;
    }
    const reconstructed = Buffer.concat(chunks).toString('utf8');
    expect(reconstructed).toBe(expected);
    expect(reconstructed).toContain('ask-secret-tail');
    expect(reconstructed).toContain('[REDACTED]');
    expect(reconstructed).not.toContain('synthetic-secret-value');
    expect(reconstructed).not.toContain('synthetic-token-value');
  });

  it('emits context-stable hex at plaintext-redaction-sensitive boundaries and uses the maximal proper UTF-8 prefix', () => {
    const contextItem = {
      value: `${'prefix🚀'.repeat(70)}ask-secret-tail ${'middle'.repeat(80)} token=synthetic-token-value ${'suffix'.repeat(120)}`,
      api_key: 'synthetic-api-value',
    };
    const contextProjected = { value: `${'prefix🚀'.repeat(70)}ask-secret-tail ${'middle'.repeat(80)} token=[REDACTED] ${'suffix'.repeat(120)}`, api_key: '[REDACTED]' };
    expect(projectDynamicForOutbound(contextItem)).toEqual(contextProjected);
    const contextBytes = Buffer.from(canonicalJson(contextProjected), 'utf8');
    let exposedCredentialBoundary: { packed: ReturnType<typeof packCollectionData>; bytes: Buffer; item: unknown } | null = null;
    for (let cap = 512; cap <= 3600; cap += 1) {
      const packed = packCollectionData({ cap, total: 1, position: { item_index: 0, item_byte_offset: 0 }, item: () => contextItem, render: (page) => ({ matches: page }) });
      if (packed.page.next === null) continue;
      const end = packed.page.next.item_byte_offset;
      const remaining = contextBytes.subarray(end).toString('utf8');
      if (remaining.startsWith('sk-secret-tail') && redactTextForOutbound(remaining) !== remaining) { exposedCredentialBoundary = { packed, bytes: contextBytes, item: contextItem }; break; }
    }

    const placeholderItem = { values: Array.from({ length: 180 }, () => 'token=synthetic-array-value'), suffix: 'x'.repeat(1000) };
    const placeholderProjected = { values: Array.from({ length: 180 }, () => 'token=[REDACTED]'), suffix: 'x'.repeat(1000) };
    expect(projectDynamicForOutbound(placeholderItem)).toEqual(placeholderProjected);
    const placeholderBytes = Buffer.from(canonicalJson(placeholderProjected), 'utf8');
    const marker = Buffer.from('[REDACTED]', 'utf8');
    let redactedPlaceholderBoundary: { packed: ReturnType<typeof packCollectionData>; bytes: Buffer; item: unknown } | null = null;
    for (let cap = 512; cap <= 8000; cap += 1) {
      const packed = packCollectionData({ cap, total: 1, position: { item_index: 0, item_byte_offset: 0 }, item: () => placeholderItem, render: (page) => ({ matches: page }) });
      if (packed.page.next === null) continue;
      const end = packed.page.next.item_byte_offset;
      for (let placeholder = placeholderBytes.indexOf(marker); placeholder >= 0; placeholder = placeholderBytes.indexOf(marker, placeholder + 1)) {
        if (end > placeholder && end < placeholder + marker.length) { redactedPlaceholderBoundary = { packed, bytes: placeholderBytes, item: placeholderItem }; break; }
      }
      if (redactedPlaceholderBoundary) break;
    }
    expect(exposedCredentialBoundary).not.toBeNull();
    expect(redactedPlaceholderBoundary).not.toBeNull();

    for (const fixture of [exposedCredentialBoundary!, redactedPlaceholderBoundary!]) {
      const { packed, bytes, item } = fixture;
      const slice = packed.page.items[0] as { content_hex: string; utf8_bytes: number; offset_bytes: number; next_offset_bytes: number; total_bytes: number };
      const decoded = Buffer.from(slice.content_hex, 'hex');
      expect(decoded).toEqual(bytes.subarray(slice.offset_bytes, slice.next_offset_bytes));
      expect(slice.content_hex).toMatch(/^(?:[0-9a-f]{2})+$/u);
      expect(slice.total_bytes).toBe(bytes.length);
      const nextCodePoint = bytes.subarray(slice.next_offset_bytes).toString('utf8')[Symbol.iterator]().next().value;
      if (nextCodePoint === undefined) throw new Error('Expected a proper-prefix slice.');
      const nextCodePointBytes = Buffer.from(nextCodePoint, 'utf8').length;
      const grownEnd = slice.next_offset_bytes + nextCodePointBytes;
      const grownSlice = { ...slice, content_hex: bytes.subarray(0, grownEnd).toString('hex'), utf8_bytes: grownEnd, next_offset_bytes: grownEnd };
      const grownPage = { ...packed.page, next: { item_index: 0, item_byte_offset: grownEnd }, items: [grownSlice] };
      expect(Buffer.byteLength(settledSuccessBytes({ matches: grownPage }), 'utf8')).toBeGreaterThan(Buffer.byteLength(settledSuccessBytes(packed.data), 'utf8'));
      const cap = Buffer.byteLength(settledSuccessBytes(packed.data), 'utf8');
      const exact = packCollectionData({ cap, total: 1, position: { item_index: 0, item_byte_offset: 0 }, item: () => item, render: (page) => ({ matches: page }) });
      expect(Buffer.byteLength(settledSuccessBytes(exact.data), 'utf8')).toBe(cap);
      expect((exact.page.items[0] as { next_offset_bytes: number }).next_offset_bytes).toBe(slice.next_offset_bytes);
      expect(Buffer.byteLength(settledSuccessBytes({ matches: grownPage }), 'utf8')).toBeGreaterThan(cap);
    }
  });

  it('uses a global maxItems window and returns its next global position', () => {
    const items = ['zero', 'one', 'two', 'three'];
    const requested: number[] = [];
    const { page } = packCollectionData({
      cap: DISCOVERY_RESPONSE_MAX_BYTES,
      total: items.length,
      position: { item_index: 1, item_byte_offset: 0 },
      maxItems: 2,
      item: (index) => { requested.push(index); return items[index]!; },
      render: (candidate) => ({ matches: candidate }),
    });
    expect(requested).toEqual([1, 2]);
    expect(page.items).toEqual(['one', 'two']);
    expect(page.returned).toBe(2);
    expect(page.next).toEqual({ item_index: 3, item_byte_offset: 0 });
  });

  it('advances a completed resumed slice to later items in the same page', () => {
    const items = [{ value: '🚀'.repeat(600) }, { value: 'after' }];
    const first = packCollectionData({
      cap: 600,
      total: items.length,
      position: { item_index: 0, item_byte_offset: 0 },
      maxItems: 2,
      item: (index) => items[index]!,
      render: (candidate) => ({ matches: candidate }),
    });
    expect(first.page.next?.item_index).toBe(0);
    const resumed = packCollectionData({
      cap: DISCOVERY_RESPONSE_MAX_BYTES,
      total: items.length,
      position: first.page.next!,
      maxItems: 2,
      item: (index) => items[index]!,
      render: (candidate) => ({ matches: candidate }),
    });
    const completedSlice = resumed.page.items[0] as { next_offset_bytes: number; total_bytes: number };
    expect(completedSlice.next_offset_bytes).toBe(completedSlice.total_bytes);
    expect(resumed.page.items[1]).toEqual(items[1]);
    expect(resumed.page.next).toBeNull();
  });

  it('uses actual continuation overhead when a first whole item fits only as a terminal page', () => {
    const items = [{ value: 'a'.repeat(280) }, { value: 'later' }];
    const terminalPage = { total: 2, position: { item_index: 0, item_byte_offset: 0 }, returned: 1, next: null, items: [items[0]] };
    const cap = Buffer.byteLength(settledSuccessBytes({ matches: terminalPage }), 'utf8');
    expect(Buffer.byteLength(settledSuccessBytes({ matches: { ...terminalPage, next: { item_index: 1, item_byte_offset: 0 } } }), 'utf8')).toBeGreaterThan(cap);
    const packed = packCollectionData({ cap, total: 2, position: { item_index: 0, item_byte_offset: 0 }, item: (index) => items[index]!, render: (page) => ({ matches: page }) });
    expect(Buffer.byteLength(settledSuccessBytes(packed.data), 'utf8')).toBeLessThanOrEqual(cap);
    expect(packed.page.items[0]).toEqual(expect.objectContaining({ content_hex: expect.any(String), offset_bytes: 0 }));
    expect(packed.page.next).toMatchObject({ item_index: 0, item_byte_offset: expect.any(Number) });
    expect(packed.page.next!.item_byte_offset).toBeGreaterThan(0);
  });

  it('rejects collection positions that are not strict consumed-item UTF-8 boundaries', () => {
    const item = { value: 'a🚀b' };
    const bytes = Buffer.from(canonicalJson(projectDynamicForOutbound(item)), 'utf8');
    const astralStart = bytes.indexOf(Buffer.from('🚀', 'utf8'));
    const packAt = (item_index: number, item_byte_offset: number) => packCollectionData({
      cap: 2048,
      total: 1,
      position: { item_index, item_byte_offset },
      item: () => item,
      render: (candidate) => ({ cards: candidate }),
    });

    expect(() => packAt(0, astralStart + 1)).toThrow(DiscoveryCollectionPositionError);
    expect(() => packAt(0, bytes.length)).toThrow(DiscoveryCollectionPositionError);
    expect(() => packAt(0, bytes.length + 1)).toThrow(DiscoveryCollectionPositionError);
    expect(() => packAt(1, 1)).toThrow(DiscoveryCollectionPositionError);
    expect(() => packCollectionData({ cap: 2048, total: 0, position: { item_index: 0, item_byte_offset: 1 }, item: () => item, render: (candidate) => ({ cards: candidate }) })).toThrow(DiscoveryCollectionPositionError);

    expect(packAt(0, astralStart).page.items).toHaveLength(1);
    expect(packAt(0, astralStart + Buffer.byteLength('🚀', 'utf8')).page.items).toHaveLength(1);
    expect(packAt(1, 0).page).toEqual({ total: 1, position: { item_index: 1, item_byte_offset: 0 }, returned: 0, next: null, items: [] });
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

  it('measures terminal empty collection envelopes and fails when their fixed data cannot fit', () => {
    expect(() => packCollectionData({
      cap: 100,
      total: 0,
      position: { item_index: 7, item_byte_offset: 0 },
      item: () => 'unused',
      render: (candidate) => ({ fixed: 'x'.repeat(200), cards: candidate }),
    })).toThrow(DiscoveryBudgetTooSmallError);
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
