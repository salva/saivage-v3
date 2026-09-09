import { describe, expect, it } from '@jest/globals';

import { projectAnalystToolInvocationActivity } from '../../src/server/tool-activity-projection.js';
import { serializeOutboundEnvelope } from '../../src/server/websocket.js';
import { OUTBOUND_IDENTITY, OUTBOUND_RAW_MARKER, OUTBOUND_TEXT_MARKER } from '../helpers/outbound-identity-fixtures.js';
import { toolSucceeded } from '../../src/contracts/tool-result.js';
import { settleToolActionOutcome } from '../../src/tools/tool-result-settlement.js';

const IDENTITY = {
  sourceInputId: '11111111-1111-4111-8111-111111111111',
  toolCallId: 'call-tok_primary',
} as const;

describe('tool activity projection', () => {
  it('passes the complete settled result unchanged while outbound-projecting only parameters', () => {
    const settledResult = settleToolActionOutcome(toolSucceeded({
        process_id: 'proc-1',
        exit_code: 0,
        status: 'exited',
        stdout_url: 'work:///processes/proc-1/stdout.log',
        stderr_url: 'work:///processes/proc-1/stderr.log',
        stdout_bytes: 1,
        stderr_bytes: 0,
        formerly_narrowed_extension: { apiKey: OUTBOUND_RAW_MARKER, display: 'token=[REDACTED]' },
    })).providerResult;
    const projected = projectAnalystToolInvocationActivity({
      tool: 'run_command',
      params: { command: `TOKEN=${OUTBOUND_RAW_MARKER} npm test` },
      result: settledResult,
      ...IDENTITY,
    }, 'agent:analyst:global');

    expect(projected.params).toEqual({ command: 'TOKEN=[REDACTED] npm test' });
    expect(projected.result).toEqual(settledResult);
    expect(JSON.stringify(projected.result)).not.toContain(OUTBOUND_RAW_MARKER);
    expect((projected.result.data as { formerly_narrowed_extension: { apiKey: string; display: string } }).formerly_narrowed_extension).toEqual({ apiKey: '[REDACTED]', display: 'token=[REDACTED]' });
  });

  it('projects unified process fields without legacy output fields', () => {
    const projected = projectAnalystToolInvocationActivity({
      tool: 'run_command',
      params: { command: 'npm test' },
      result: { success: true, data: { process_id: 'proc-1', exit_code: null, status: 'running', stdout_url: 'work:///processes/proc-1/stdout.log', stderr_url: 'work:///processes/proc-1/stderr.log', stdout_bytes: 1, stderr_bytes: 0 } },
      ...IDENTITY,
    },'agent:analyst:global');

    expect((projected.result as { data: Record<string, unknown> }).data).toEqual(expect.objectContaining({ process_id: 'proc-1', stdout_url: 'work:///processes/proc-1/stdout.log', stderr_url: 'work:///processes/proc-1/stderr.log', stdout_bytes: 1, stderr_bytes: 0 }));
  });

  it('projects webfetch URL options and opaque result data through the generic invocation owner', () => {
    const projected = projectAnalystToolInvocationActivity({
      tool: 'webfetch',
      params: { url: `https://example.test/path?token=${OUTBOUND_RAW_MARKER}#fragment`, read_mode: 'text', max_bytes: 123 },
      result: { success: true, data: { kind: 'text', redacted_url: 'https://example.test/path?[REDACTED]', status: 200, headers: {}, head: 'safe head', head_utf8_bytes: 9, redacted_text_utf8_bytes: 123, fetched_text_utf8_bytes: 140, head_complete: false, fetch_truncated: true, content_url: 'work:///tmp/stash/webfetch-1-0123456789abcdef.txt', command: 'token=[REDACTED]' } },
      ...IDENTITY,
    },'agent:analyst:global');

    expect(projected.params).toEqual({ url: 'https://example.test/path?[REDACTED]', read_mode: 'text', max_bytes: 123 });
    expect((projected.result as { data: Record<string, unknown> }).data).toEqual(expect.objectContaining({
      head: 'safe head',
      head_utf8_bytes: 9,
      redacted_text_utf8_bytes: 123,
      fetched_text_utf8_bytes: 140,
      head_complete: false,
      fetch_truncated: true,
      content_url: 'work:///tmp/stash/webfetch-1-0123456789abcdef.txt',
      command: 'token=[REDACTED]',
    }));
    expect(JSON.stringify(projected)).not.toContain(OUTBOUND_RAW_MARKER);
  });

  it.each([
    {
      label: 'valid run_command',
       invocation: { tool: 'run_command', params: { command: `TOKEN=${OUTBOUND_RAW_MARKER} npm test` }, result: { success: true as const, data: { process_id: 'tok-[REDACTED]', exit_code: 0, status: 'exited', stdout_url: 'work:///processes/tok-[REDACTED]', stderr_url: 'work:///processes/tok-[REDACTED]', stdout_bytes: 1, stderr_bytes: 2 } }, ...IDENTITY },
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
       invocation: { tool: 'unsupported_tok_primary', params: { apiKey: OUTBOUND_RAW_MARKER, identity: 'ordinary' }, result: { success: false as const, error: 'token=[REDACTED]', data: { status: 'unsupported' } }, ...IDENTITY },
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
       invocation: { tool: 'webfetch', params: { url: 7, apiKey: OUTBOUND_RAW_MARKER }, result: { success: false as const, error: 'token=[REDACTED]' }, ...IDENTITY },
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
