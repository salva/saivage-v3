import { describe, expect, it, jest } from '@jest/globals';

import { projectAnalystToolInvocationActivity } from '../../src/server/tool-activity-projection.js';
import { projectToolInvocation } from '../../src/tools/tool-invocation-outbound.js';
import { serializeOutboundEnvelope } from '../../src/server/websocket.js';

const IDENTITY = {
  sourceInputId: '11111111-1111-4111-8111-111111111111',
  toolCallId: 'call-tok_primary',
} as const;

describe('tool activity projection', () => {
  it('projects unified process fields without legacy output fields', () => {
    const projected = projectAnalystToolInvocationActivity({
      tool: 'run_command',
      params: { command: 'npm test' },
      result: { success: true, data: { process_id: 'proc-1', exit_code: null, status: 'running', stdout_url: 'work:///processes/proc-1/stdout.log', stderr_url: 'work:///processes/proc-1/stderr.log', stdout_bytes: 1, stderr_bytes: 0 } },
      ...IDENTITY,
    });

    expect((projected.result as { data: Record<string, unknown> }).data).toEqual(expect.objectContaining({ process_id: 'proc-1', stdout_url: 'work:///processes/proc-1/stdout.log', stderr_url: 'work:///processes/proc-1/stderr.log', stdout_bytes: 1, stderr_bytes: 0 }));
  });

  it('projects webfetch stash_url without stash_path', () => {
    const projected = projectAnalystToolInvocationActivity({
      tool: 'webfetch',
      params: { url: 'https://example.test' },
      result: { success: true, data: { redacted_url: 'https://example.test/', status: 200, headers: {}, bytes: 123, truncated: true, stash_url: 'work:///tmp/stash/webfetch.txt' } },
      ...IDENTITY,
    });

    expect((projected.result as { data: Record<string, unknown> }).data.stash_url).toBe('work:///tmp/stash/webfetch.txt');
    expect((projected.result as { data: Record<string, unknown> }).data).not.toHaveProperty('stash_path');
  });

  it.each([
    {
      label: 'settled valid',
      invocation: { tool: 'run_command', params: { command: 'TOKEN=synthetic-live-marker npm test' }, result: { success: true as const, data: { process_id: 'tok_primary', exit_code: 0, status: 'exited', stdout_url: 'work:///processes/tok_primary/stdout.log', stderr_url: 'work:///processes/tok_primary/stderr.log', stdout_bytes: 1, stderr_bytes: 2 } }, ...IDENTITY },
    },
    {
      label: 'unsupported tool',
      invocation: { tool: 'unsupported_tok_primary', params: { apiKey: 'sk-synthetic-live-marker', identity: 'ordinary' }, result: { success: false as const, error: 'failed sk-synthetic-live-marker', data: { token: 'sk-synthetic-live-marker', identity: 'ordinary' } }, ...IDENTITY },
    },
    {
      label: 'schema-invalid known tool',
      invocation: { tool: 'webfetch', params: { url: 7, apiKey: 'sk-synthetic-live-marker' }, result: { success: false as const, error: 'failed sk-synthetic-live-marker' }, ...IDENTITY },
    },
  ])('projects $label once and final WebSocket serialization copies identical classified activity', ({ invocation }) => {
    const projector = jest.fn(projectToolInvocation);
    const activity = projectAnalystToolInvocationActivity(invocation, projector);
    expect(projector).toHaveBeenCalledTimes(1);

    const complete = projectToolInvocation({
      shape: 'complete',
      identity: { sessionId: 'analyst:global', sourceInputId: invocation.sourceInputId, toolCallId: invocation.toolCallId, toolName: invocation.tool },
      arguments: invocation.params,
      result: invocation.result,
    });
    if (complete.shape !== 'complete') throw new Error('Expected complete fixture projection.');
    expect(activity.params).toEqual(complete.arguments);
    expect(activity.result).toEqual(expect.objectContaining({ success: complete.result.success }));

    const serialized = serializeOutboundEnvelope({ type: 'activity', content: activity });
    expect(JSON.parse(serialized)).toEqual({ type: 'activity', content: activity });
    expect(projector).toHaveBeenCalledTimes(1);
    expect(serialized).not.toContain('sk-synthetic-live-marker');
    expect(activity.tool).toBe(invocation.tool);
  });
});
