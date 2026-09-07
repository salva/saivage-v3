import { describe, expect, it } from '@jest/globals';

import {
  projectMcpToolCallArgumentsForOutbound,
} from '../../src/tools/mcp-invocation-outbound.js';

describe('MCP invocation outbound leaves', () => {
  it('preserves exact MCP identity and projects only opaque call arguments dynamically', () => {
    expect(projectMcpToolCallArgumentsForOutbound({
      serverName: 'ghu_server',
      toolName: 'tok_primary',
      args: {
        apiKey: 'synthetic-argument-secret',
        nested: { note: 'token=synthetic-nested-secret', identity: 'sk-model' },
      },
    })).toEqual({
      serverName: 'ghu_server',
      toolName: 'tok_primary',
      args: {
        apiKey: '[REDACTED]',
        nested: { note: 'token=[REDACTED]', identity: 'sk-[REDACTED]' },
      },
    });
  });
});
