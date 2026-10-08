import { expect, it } from '@jest/globals';
import { ToolResultSchema, toolContentSucceeded, toolSucceeded, type ToolActionOutcome, providerItemImageDescriptors } from '../../src/contracts/index.js';
import { settleToolActionOutcome } from '../../src/tools/tool-result-settlement.js';

const image = { id: '11111111-1111-4111-8111-111111111111', mime_type: 'image/png' as const, width: 10, height: 5, byte_length: 100, sha256: 'a'.repeat(64) };

it('settles generic and explicitly undefined producer data with strict descriptors and branded authority', () => {
  for (const data of [{ caption: 'fixture' }, undefined]) {
    const settled = settleToolActionOutcome(toolContentSucceeded(data, [{ type: 'image', image }]));
    expect(JSON.parse(settled.settledResultBytes)).toEqual({ success: true, ...(data === undefined ? {} : { data }), content: [{ type: 'image', image }] });
  }
  expect(() => toolContentSucceeded({}, [{ type: 'image', image: { ...image, width: 0 } }])).toThrow();
  expect(ToolResultSchema.safeParse({ success: false, error: 'failed', content: [{ type: 'image', image }] }).success).toBe(false);
  expect(ToolResultSchema.safeParse({ success: true, image }).success).toBe(false);
  expect(ToolResultSchema.safeParse({ success: true, content: [] }).success).toBe(false);
  expect(() => settleToolActionOutcome({ kind: 'succeeded', content: [{ type: 'image', image }] } as unknown as ToolActionOutcome)).toThrow(/authority constructors/);
});

it('does not promote arbitrary MCP-style image-like data into attachments', () => {
  const settled = settleToolActionOutcome(toolSucceeded({ image, image_url: 'data:image/png;base64,aGVsbG8=' }));
  expect(JSON.parse(settled.settledResultBytes)).not.toHaveProperty('image');
  expect(providerItemImageDescriptors({ kind: 'tool_result', content: settled.settledResultBytes } as Parameters<typeof providerItemImageDescriptors>[0])).toEqual([]);
});

it('keeps ordered text/images strictly typed and validates every materialized occurrence', async () => {
  const { assertProviderItemImageMaterialized, materializedToolContent } = await import('../../src/contracts/index.js');
  const blocks = [{ type: 'text' as const, text: '{"type":"image"}' }, { type: 'image' as const, image }, { type: 'text' as const, text: 'between' }, { type: 'image' as const, image }];
  const settled = settleToolActionOutcome(toolContentSucceeded({ image }, blocks));
  const row = { kind: 'tool_result', content: settled.settledResultBytes } as Parameters<typeof providerItemImageDescriptors>[0];
  if (row.kind === 'synthetic_context') throw new Error('Expected source result.');
  expect(providerItemImageDescriptors(row)).toEqual([image, image]);
  const materialized = { descriptor: image, dataUrl: 'data:image/png;base64,fixture' };
  expect(() => assertProviderItemImageMaterialized({ ...row, images: [materialized] })).toThrow(/materialized/);
  expect(() => assertProviderItemImageMaterialized({ ...row, images: [materialized, { ...materialized, descriptor: { ...image, sha256: 'f'.repeat(64) } }] })).toThrow(/match/);
  expect(materializedToolContent(blocks, [materialized, materialized]).map(block => block.type)).toEqual(['text', 'image', 'text', 'image']);
  expect(() => materializedToolContent(blocks, [materialized, materialized, materialized])).toThrow(/Unexpected/);
  for (const content of [[{ type: 'text', text: 'safe', extra: true }], [{ type: 'image', image: { ...image, height: 0 } }], [{ type: 'audio', data: 'unknown' }]])
    expect(ToolResultSchema.safeParse({ success: true, content }).success).toBe(false);
});
