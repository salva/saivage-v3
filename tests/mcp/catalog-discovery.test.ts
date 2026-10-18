import { describe, expect, it } from '@jest/globals';
import { decodeMcpListPage } from '../../src/mcp/catalog-discovery.js';

const tool = { name: 'one', inputSchema: { type: 'object' } };
const page = (result: unknown) => ({ jsonrpc: '2.0', id: 1, result });
describe('shared startup/refresh consumed catalog decoder', () => {
  it('preserves exact schema extensions and boolean subschemas without eager dialect compilation, and accepts a valid empty list', () => {
    const exact = { ...tool, inputSchema: { type: 'object', $schema: 'unsupported-at-invocation', properties: { enabled: true, disabled: false }, 'x-extension': { original: true } }, annotations: { readOnlyHint: true }, _meta: { original: 'data' } };
    expect(decodeMcpListPage('one', page({ tools: [exact], nextCursor: 'next' }), new Set())).toEqual({ tools: [exact], nextCursor: 'next' });
    expect(decodeMcpListPage('one', page({ tools: [] }), new Set())).toEqual({ tools: [], nextCursor: undefined });
  });
  it.each([
    undefined, {}, { tools: null }, { tools: {} }, { tools: [null] },
    { tools: [{ name: '', inputSchema: { type: 'object' } }] },
    { tools: [{ name: 'missing-schema' }] },
    { tools: [{ ...tool, inputSchema: true }] },
    { tools: [{ ...tool, inputSchema: { type: 'array' } }] },
    { tools: [{ ...tool, description: 42 }] },
    { tools: [{ ...tool, title: false }] },
    { tools: [{ ...tool, outputSchema: false }] },
    { tools: [{ ...tool, annotations: { readOnlyHint: 'yes' } }] },
    { tools: [{ ...tool, _meta: [] }] },
    { tools: [], nextCursor: 12 }, { tools: [], _meta: [] },
  ])('rejects malformed complete discovery result %j rather than publishing an empty catalog', result => {
    expect(() => decodeMcpListPage('one', page(result), new Set())).toThrow('malformed catalog');
  });
  it('rejects cross-page duplicates and redacts explicit protocol error text', () => {
    const names = new Set<string>();
    decodeMcpListPage('one', page({ tools: [tool], nextCursor: 'next' }), names);
    expect(() => decodeMcpListPage('one', page({ tools: [tool] }), names)).toThrow('malformed catalog');
    const response = { jsonrpc: '2.0', id: 2, error: { code: -32001, message: 'credential-bearing remote text' } };
    try { decodeMcpListPage('one', response, new Set()); throw new Error('Expected protocol rejection'); }
    catch (error) {
      expect((error as Error).message).toContain('tools/list rejected (code -32001)');
      expect((error as Error).message).not.toContain('credential-bearing');
    }
  });
});
