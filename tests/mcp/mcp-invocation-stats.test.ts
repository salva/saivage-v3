import { describe, expect, it, jest } from '@jest/globals';
import { McpInvocationStatsRecorder } from '../../src/mcp/invocation-stats.js';

describe('McpInvocationStatsRecorder', () => {
  it('records success/error counts and emits event logger entries', () => {
    const appendEvent = jest.fn();
    const recorder = new McpInvocationStatsRecorder({ appendEvent } as any);

    recorder.record('srv', 'tool', true);
    recorder.record('srv', 'tool', false);
    recorder.log('srv', 'tool', false, 42, 'boom');

    expect(recorder.snapshot()).toEqual({
      'srv:tool': { total: 2, success: 1, error: 1, lastInvokedAt: expect.any(String) },
    });
    expect(appendEvent).toHaveBeenCalledTimes(1);
    expect(appendEvent).toHaveBeenCalledWith({ kind: 'mcp_tool_invocation', server: 'srv', tool: 'tool', success: false, duration_ms: 42, error: 'boom' });
  });
});
