import { describe, expect, it } from '@jest/globals';
import { InvalidArgumentsError } from '../../src/mcp/errors.js';
import { mapToolsCallResponse } from '../../src/mcp/tools-call-response.js';

describe('MCP tools/call response mapping', () => {
  it('maps invalid-argument JSON-RPC errors with their data', () => {
    const data = { field: 'count' };
    expect(() => mapToolsCallResponse({ error: { code: -32602, message: 'bad input', data } }, 'server', 'tool')).toThrow(InvalidArgumentsError);
    try { mapToolsCallResponse({ error: { code: -32602, message: 'bad input', data } }, 'server', 'tool'); }
    catch (error) { expect(error).toMatchObject({ code: 'INVALID_ARGUMENTS', statusCode: 400, data }); }
  });

  it('maps other JSON-RPC errors', () => {
    expect(() => mapToolsCallResponse({ error: { code: -32_001, message: 'failed' } }, 'server', 'tool')).toThrow(expect.objectContaining({
      message: "MCP server 'server' returned error for tool 'tool': failed (code -32001)",
      code: 'MCP_ERROR_-32001',
      statusCode: 502,
    }));
  });

  it.each([{}, { result: undefined }, { result: false }, { result: null }, { result: 0 }, { result: '' }])('rejects missing or falsy results as MCP_NO_RESULT: %p', (response) => {
    expect(() => mapToolsCallResponse(response, 'server', 'tool')).toThrow(expect.objectContaining({ code: 'MCP_NO_RESULT', statusCode: 502 }));
  });

  it.each([true, false, undefined])('retains the native error flag %p', (isError) => {
    const result = { ...(isError === undefined ? {} : { isError }), content: [{ type: 'text', text: 'message' }] };
    expect(mapToolsCallResponse({ result }, 'server', 'tool')).toEqual(result);
  });

  it.each([
    true, ['scalar'], {}, { content: 'text' }, { content: ['failed'] },
    { content: [{ type: 'unknown' }] },
    { content: [{ type: 'text', text: 1 }] },
    { content: [{ type: 'image', data: 1, mimeType: 'image/png' }] },
    { content: [{ type: 'image', data: 'YQ==', mimeType: 1 }] },
    { content: [{ type: 'resource', resource: { uri: 1, text: 'text' } }] },
    { content: [{ type: 'resource', resource: { uri: 'file:///x', text: 1 } }] },
    { content: [], isError: 'true' }, { content: [], structuredContent: [] },
  ])('rejects truthy malformed native results at protocol ingress: %p', (result) => {
    expect(() => mapToolsCallResponse({ result }, 'server', 'tool')).toThrow(expect.objectContaining({ code: 'MCP_INVALID_RESULT', statusCode: 502 }));
  });

  it('returns the complete validated envelope', () => {
    const content = [
      { type: 'text', text: 'ok', annotations: { audience: ['assistant'], priority: 0.5 }, extension: { nested: true } },
      { type: 'resource', resource: { uri: 'file:///text', text: 'resource text', extension: 'text metadata' } },
      { type: 'resource', resource: { uri: 'file:///blob', blob: 'YQ==', mimeType: 'application/octet-stream' } },
      { type: 'audio', data: 'YQ==', mimeType: 'audio/wav' },
      { type: 'resource_link', uri: 'https://example.test/x', name: 'link', size: 1 },
      { type: 'image', data: 'YQ==', mimeType: 'image/png' },
    ];
    const result = { content, structuredContent: { ok: true }, _meta: { producer: 'fixture' }, extension: ['retained'] };
    expect(mapToolsCallResponse({ result }, 'server', 'tool')).toEqual(result);
  });
});
