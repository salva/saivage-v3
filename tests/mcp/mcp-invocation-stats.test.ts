import { describe, expect, it, jest } from '@jest/globals';
import { McpInvocationStatsRecorder } from '../../src/mcp/invocation-stats.js';

describe('McpInvocationStatsRecorder', () => {
  it('records success/error counts and emits event logger entries', () => {
    const appendEventPrepared = jest.fn();
    const recorder = new McpInvocationStatsRecorder({ appendEventPrepared } as any);

    recorder.record('srv', 'tool', true);
    recorder.record('srv', 'tool', false);
    const operationError = new Error('boom');
    recorder.publish('srv', 'tool', false, 42, operationError);

    expect(recorder.snapshot()).toEqual({
      'srv:tool': { total: 2, success: 1, error: 1, lastInvokedAt: expect.any(String) },
    });
    expect(appendEventPrepared).toHaveBeenCalledTimes(1);
    const [prepare] = appendEventPrepared.mock.calls[0] as unknown as [() => unknown];
    expect(prepare()).toEqual({ kind: 'mcp_tool_invocation', server: 'srv', tool: 'tool', success: false, duration_ms: 42, error: 'boom' });
    expect(appendEventPrepared.mock.calls[0]).toHaveLength(1);
  });
});
