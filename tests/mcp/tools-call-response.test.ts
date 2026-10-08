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

  it('rejects a missing result', () => {
    expect(() => mapToolsCallResponse({}, 'server', 'tool')).toThrow(expect.objectContaining({ code: 'MCP_NO_RESULT', statusCode: 502 }));
  });

  it('retains a valid tool-declared error and rejects malformed native blocks', () => {
    const result = { isError: true, content: [{ type: 'text', text: 'failed' }] };
    expect(mapToolsCallResponse({ result }, 'server', 'tool')).toEqual(result);
    expect(() => mapToolsCallResponse({ result: { content: ['failed'] } }, 'server', 'tool')).toThrow(expect.objectContaining({ code: 'MCP_INVALID_RESULT' }));
  });

  it('returns the complete validated envelope', () => {
    const content = [{ type: 'text', text: 'ok' }];
    const result = { content, structuredContent: { ok: true } };
    expect(mapToolsCallResponse({ result }, 'server', 'tool')).toEqual(result);
  });
});
