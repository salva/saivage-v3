import { describe, expect, it } from '@jest/globals';

import {
  projectMcpToolCallArgumentsForOutbound,
} from '../../src/tools/mcp-invocation-outbound.js';

describe('MCP invocation outbound leaves', () => {
  it('preserves exact MCP identity and projects only opaque call arguments dynamically', () => {
    expect(projectMcpToolCallArgumentsForOutbound({
      serverName: 'ghu_server',
        bindingId: '11111111-1111-4111-8111-111111111111', catalogId: '22222222-2222-4222-8222-222222222222',
      toolName: 'tok_primary',
      max_dimension: 'original',
      args: {
        apiKey: 'synthetic-argument-secret',
        nested: { note: 'token=synthetic-nested-secret', identity: 'sk-model' },
      },
    })).toEqual({
      serverName: 'ghu_server',
      bindingId: '11111111-1111-4111-8111-111111111111', catalogId: '22222222-2222-4222-8222-222222222222',
      toolName: 'tok_primary',
      max_dimension: 'original',
      args: {
        apiKey: '[REDACTED]',
        nested: { note: 'token=[REDACTED]', identity: 'sk-[REDACTED]' },
      },
    });
  });
});
