import { describe, expect, it } from '@jest/globals';
import { ZodError } from 'zod';

import {
  projectMcpReconcileResultForOutbound,
  projectMcpToolCallArgumentsForOutbound,
  projectMcpToolCallResultForOutbound,
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

  it('projects opaque result data dynamically while preserving success and redacting settlement errors', () => {
    expect(projectMcpToolCallResultForOutbound({
      success: false,
      error: 'MCP settlement failed with token=synthetic-settlement-secret',
      data: {
        accessToken: 'synthetic-result-secret',
        identity: 'ghu_integration_payload',
      },
    })).toEqual({
      success: false,
      error: 'MCP settlement failed with token=[REDACTED]',
      data: {
        accessToken: '[REDACTED]',
        identity: 'ghu-[REDACTED]',
      },
    });

    expect(projectMcpToolCallResultForOutbound({
      success: true,
      data: { apiToken: 'synthetic-success-secret', count: 2 },
    })).toEqual({
      success: true,
      data: { apiToken: '[REDACTED]', count: 2 },
    });
    expect(projectMcpToolCallResultForOutbound({ success: true })).toEqual({ success: true });
  });

  it('uses the fixed direct reconcile result shape and redacts only its settlement error', () => {
    expect(projectMcpReconcileResultForOutbound({
      success: false,
      error: 'Reconcile unavailable: token=synthetic-reconcile-secret',
      data: { persisted: false, reconciled: false },
    })).toEqual({
      success: false,
      error: 'Reconcile unavailable: token=[REDACTED]',
      data: { persisted: false, reconciled: false },
    });
  });

  it('fails fast when a reconcile result does not have the fixed direct shape', () => {
    expect(() => projectMcpReconcileResultForOutbound({ success: true, data: { persisted: true, reconciled: true } }))
      .toThrow(ZodError);
    expect(() => projectMcpReconcileResultForOutbound({
      success: false,
      error: 'failed',
      data: { persisted: false, reconciled: false, extra: true },
    })).toThrow(ZodError);
  });
});
