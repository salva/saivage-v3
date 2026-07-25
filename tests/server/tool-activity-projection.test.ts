import { describe, expect, it } from '@jest/globals';

import { projectAnalystToolInvocationActivity } from '../../src/server/tool-activity-projection.js';
import { serializeOutboundEnvelope } from '../../src/server/websocket.js';
import { OUTBOUND_IDENTITY, OUTBOUND_RAW_MARKER, OUTBOUND_TEXT_MARKER } from '../helpers/outbound-identity-fixtures.js';

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
    },'agent:analyst:global');

    expect((projected.result as { data: Record<string, unknown> }).data).toEqual(expect.objectContaining({ process_id: 'proc-1', stdout_url: 'work:///processes/proc-1/stdout.log', stderr_url: 'work:///processes/proc-1/stderr.log', stdout_bytes: 1, stderr_bytes: 0 }));
  });

  it('projects webfetch stash_url without stash_path', () => {
    const projected = projectAnalystToolInvocationActivity({
      tool: 'webfetch',
      params: { url: 'https://example.test' },
      result: { success: true, data: { redacted_url: 'https://example.test/', status: 200, headers: {}, bytes: 123, truncated: true, stash_url: 'work:///tmp/stash/webfetch.txt' } },
      ...IDENTITY,
    },'agent:analyst:global');

    expect((projected.result as { data: Record<string, unknown> }).data.stash_url).toBe('work:///tmp/stash/webfetch.txt');
    expect((projected.result as { data: Record<string, unknown> }).data).not.toHaveProperty('stash_path');
  });

  it.each([
    {
      label: 'valid run_command',
      invocation: { tool: 'run_command', params: { command: `TOKEN=${OUTBOUND_RAW_MARKER} npm test` }, result: { success: true as const, data: { process_id: OUTBOUND_IDENTITY, exit_code: 0, status: 'exited', stdout_url: `work:///processes/${OUTBOUND_IDENTITY}/stdout.log`, stderr_url: `work:///processes/${OUTBOUND_IDENTITY}/stderr.log`, stdout_bytes: 1, stderr_bytes: 2 } }, ...IDENTITY },
      expectedActivity: {
        event: 'tool_invocation',
        sessionId: 'agent:analyst:global',
        tool: 'run_command',
        params: { command: 'TOKEN=[REDACTED] npm test' },
        result: { success: true, data: { process_id: 'tok-[REDACTED]', exit_code: 0, status: 'exited', stdout_url: 'work:///processes/tok-[REDACTED]', stderr_url: 'work:///processes/tok-[REDACTED]', stdout_bytes: 1, stderr_bytes: 2 } },
      },
    },
    {
      label: 'unsupported tool',
      invocation: { tool: 'unsupported_tok_primary', params: { apiKey: OUTBOUND_RAW_MARKER, identity: 'ordinary' }, result: { success: false as const, error: OUTBOUND_TEXT_MARKER, data: { status: 'unsupported', token: OUTBOUND_RAW_MARKER, identity: 'ordinary' } }, ...IDENTITY },
      expectedActivity: {
        event: 'tool_invocation',
        sessionId: 'agent:analyst:global',
        tool: 'unsupported_tok_primary',
        params: { apiKey: '[REDACTED]', identity: 'ordinary' },
        result: { success: false, error: 'token=[REDACTED]', data: { status: 'unsupported' } },
      },
    },
    {
      label: 'schema-invalid known tool',
      invocation: { tool: 'webfetch', params: { url: 7, apiKey: OUTBOUND_RAW_MARKER }, result: { success: false as const, error: OUTBOUND_TEXT_MARKER }, ...IDENTITY },
      expectedActivity: {
        event: 'tool_invocation',
        sessionId: 'agent:analyst:global',
        tool: 'webfetch',
        params: { url: 7, apiKey: '[REDACTED]' },
        result: { success: false, error: 'token=[REDACTED]' },
      },
    },
  ])('projects exact $label activity and WebSocket envelope without raw secrets', ({ invocation, expectedActivity }) => {
    const activity = projectAnalystToolInvocationActivity(invocation, 'agent:analyst:global');
    expect(activity).toEqual(expectedActivity);

    const serialized = serializeOutboundEnvelope({ type: 'activity', content: activity });
    expect(JSON.parse(serialized)).toEqual({ type: 'activity', content: expectedActivity });
    expect(JSON.stringify(activity)).not.toContain(OUTBOUND_RAW_MARKER);
    expect(serialized).not.toContain(OUTBOUND_RAW_MARKER);
  });
});
