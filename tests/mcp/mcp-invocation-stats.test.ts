import { describe, expect, it, jest } from '@jest/globals';
import { McpInvocationStatsRecorder, mcpInvocationStatsKey } from '../../src/mcp/invocation-stats.js';

describe('McpInvocationStatsRecorder', () => {
  it('keeps colliding delimiter pairs independent and snapshots detached', () => {
    const recorder = new McpInvocationStatsRecorder({ appendEventPrepared: jest.fn() } as any);
    const t1 = '2026-11-13T10:00:00.000Z';
    const t2 = '2026-11-13T10:01:00.000Z';
    const t3 = '2026-11-13T10:02:00.000Z';
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date(t1));
      recorder.record('a:b', 'c', true);
      jest.setSystemTime(new Date(t2));
      recorder.record('a', 'b:c', false);
      jest.setSystemTime(new Date(t3));
      recorder.record('a:b', 'c', true);
    } finally {
      jest.useRealTimers();
    }

    const expected = {
      [mcpInvocationStatsKey('a:b', 'c')]: { total: 2, success: 2, error: 0, lastInvokedAt: t3 },
      [mcpInvocationStatsKey('a', 'b:c')]: { total: 1, success: 0, error: 1, lastInvokedAt: t2 },
    };
    const snapshot = recorder.snapshot();
    expect(Object.keys(snapshot)).toHaveLength(2);
    expect(snapshot).toEqual(expected);
    snapshot[mcpInvocationStatsKey('a:b', 'c')]!.total = 99;
    delete snapshot[mcpInvocationStatsKey('a', 'b:c')];
    expect(recorder.snapshot()).toEqual(expected);
  });

  it('encodes quote and backslash identities as JSON string pairs', () => {
    const server = 'a"\\b';
    const tool = 'c\\"d';
    expect(mcpInvocationStatsKey(server, tool)).toBe(JSON.stringify([server, tool]));
    const recorder = new McpInvocationStatsRecorder({ appendEventPrepared: jest.fn() } as any);
    recorder.record(server, tool, true);
    recorder.record(tool, server, false);
    expect(recorder.snapshot()).toEqual({
      [mcpInvocationStatsKey(server, tool)]: { total: 1, success: 1, error: 0, lastInvokedAt: expect.any(String) },
      [mcpInvocationStatsKey(tool, server)]: { total: 1, success: 0, error: 1, lastInvokedAt: expect.any(String) },
    });
  });

  it('records success/error counts and emits event logger entries', () => {
    const appendEventPrepared = jest.fn();
    const recorder = new McpInvocationStatsRecorder({ appendEventPrepared } as any);

    recorder.record('srv', 'tool', true);
    recorder.record('srv', 'tool', false);
    const operationError = new Error('boom');
    recorder.publish('srv', 'tool', false, 42, operationError);

    expect(recorder.snapshot()).toEqual({
      [mcpInvocationStatsKey('srv', 'tool')]: { total: 2, success: 1, error: 1, lastInvokedAt: expect.any(String) },
    });
    expect(appendEventPrepared).toHaveBeenCalledTimes(1);
    const [prepare] = appendEventPrepared.mock.calls[0] as unknown as [() => unknown];
    expect(prepare()).toEqual({ kind: 'mcp_tool_invocation', server: 'srv', tool: 'tool', success: false, duration_ms: 42, error: 'boom' });
    expect(appendEventPrepared.mock.calls[0]).toHaveLength(1);
  });
});
