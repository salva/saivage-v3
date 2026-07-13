import { describe, expect, it, jest } from '@jest/globals';
import { McpInvocationStatsRecorder } from '../../src/mcp/invocation-stats.js';
import { issueCompositionMutationAuthority } from '../../src/application/mutation-authority.js';

describe('McpInvocationStatsRecorder', () => {
  it('records success/error counts and emits event logger entries', () => {
    const recorder = new McpInvocationStatsRecorder();
    const appendEvent = jest.fn();
    recorder.setEventLogger({ appendEvent } as any);

    recorder.record('srv', 'tool', true);
    recorder.record('srv', 'tool', false);
    const authority = issueCompositionMutationAuthority();
    recorder.log(authority, 'srv', 'tool', false, 42, 'boom');

    expect(recorder.snapshot()['srv:tool']).toEqual(expect.objectContaining({ total: 2, success: 1, error: 1, lastInvokedAt: expect.any(String) }));
    expect(appendEvent).toHaveBeenCalledWith(authority, expect.objectContaining({ kind: 'mcp_tool_invocation', server: 'srv', tool: 'tool', success: false, duration_ms: 42, error: 'boom' }));
  });
});
