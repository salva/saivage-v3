import { expect, it } from '@jest/globals';
import { ToolResultSchema, toolImageSucceeded, toolSucceeded, type ToolActionOutcome, providerItemImageDescriptors } from '../../src/contracts/index.js';
import { settleToolActionOutcome } from '../../src/tools/tool-result-settlement.js';

const image = { id: '11111111-1111-4111-8111-111111111111', mime_type: 'image/png' as const, width: 10, height: 5, byte_length: 100, sha256: 'a'.repeat(64) };

it('settles generic and explicitly undefined producer data with strict descriptors and branded authority', () => {
  for (const data of [{ caption: 'fixture' }, undefined]) {
    const settled = settleToolActionOutcome(toolImageSucceeded(data, image));
    expect(JSON.parse(settled.settledResultBytes)).toEqual({ success: true, ...(data === undefined ? {} : { data }), image });
  }
  expect(() => toolImageSucceeded({}, { ...image, width: 0 })).toThrow();
  expect(ToolResultSchema.safeParse({ success: false, error: 'failed', image }).success).toBe(false);
  expect(ToolResultSchema.safeParse({ success: true, image, extra: true }).success).toBe(false);
  expect(() => settleToolActionOutcome({ kind: 'succeeded', image } as ToolActionOutcome)).toThrow(/authority constructors/);
});

it('does not promote arbitrary MCP-style image-like data into attachments', () => {
  const settled = settleToolActionOutcome(toolSucceeded({ image, image_url: 'data:image/png;base64,aGVsbG8=' }));
  expect(JSON.parse(settled.settledResultBytes)).not.toHaveProperty('image');
  expect(providerItemImageDescriptors({ kind: 'tool_result', content: settled.settledResultBytes } as Parameters<typeof providerItemImageDescriptors>[0])).toEqual([]);
});
