import { describe, expect, it } from '@jest/globals';

import type { ProcessToolResult, ProcessView } from '../../src/contracts/operator-api-processes.js';
import { redactForOutbound } from '../../src/redaction/index.js';

describe('process outbound owner', () => {
  it('preserves process-view structure while redacting command prose', () => {
    const rawSecret = 'synthetic-process-command-secret';
    const process: ProcessView = {
      id: 'tok_process',
      status: 'sk-status',
      started_at: 'tok_started_at',
      ended_at: 'sk-ended-at',
      exit_code: 23,
      timed_out: false,
      owner_id: 'tok_primary',
      owner_kind: 'agent',
      session_id: 'sk-session',
      card_id: 'card-token',
      command: `curl -H "Authorization: Bearer ${rawSecret}" https://example.test`,
      cwd: 'tok_primary',
      logs: {
        stdout: 'work:///cards/card-token/processes/tok_process/stdout.log',
        stderr: 'work:///cards/card-token/processes/tok_process/stderr.log',
      },
    };

    const projected = redactForOutbound({ source: 'process-view', value: process });

    expect(projected).toEqual({ ...process, command: expect.stringContaining('[REDACTED]') });
    expect(projected.command).not.toContain(rawSecret);
  });

  it('validates and preserves process-provider result identities, exit state, bytes, and work URLs', () => {
    const result: ProcessToolResult = {
      process_id: 'tok_process',
      exit_code: 17,
      status: 'failed',
      stdout_url: 'work:///processes/tok_process/stdout.log',
      stderr_url: 'work:///processes/tok_process/stderr.log',
      stdout_bytes: 123,
      stderr_bytes: 456,
    };

    expect(redactForOutbound({ source: 'process-view', value: result })).toEqual(result);
  });
});
