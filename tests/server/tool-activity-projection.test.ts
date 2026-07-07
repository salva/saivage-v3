import { describe, expect, it } from '@jest/globals';

import { projectAnalystToolInvocationActivity } from '../../src/server/tool-activity-projection.js';

describe('tool activity projection', () => {
  it('projects unified process fields without legacy output fields', () => {
    const projected = projectAnalystToolInvocationActivity({
      tool: 'run_command',
      params: { command: 'npm test' },
      result: { success: true, data: { process_id: 'proc-1', exit_code: null, status: 'running', stdout_url: 'work:///processes/proc-1/stdout.log', stderr_url: 'work:///processes/proc-1/stderr.log', stdout_bytes: 1, stderr_bytes: 0, stdout_tail: 'ok', stderr_tail: '', tail_truncated: false, stdout: 'old', stderr: 'old', truncated: true, log_path: '.saivage-work/processes/proc-1/combined.log' } },
    });

    expect((projected.result as { data: Record<string, unknown> }).data).toEqual(expect.objectContaining({ process_id: 'proc-1', stdout_url: 'work:///processes/proc-1/stdout.log', stderr_url: 'work:///processes/proc-1/stderr.log', stdout_tail: 'ok', tail_truncated: false }));
    expect((projected.result as { data: Record<string, unknown> }).data).not.toHaveProperty('stdout');
    expect((projected.result as { data: Record<string, unknown> }).data).not.toHaveProperty('stderr');
    expect((projected.result as { data: Record<string, unknown> }).data).not.toHaveProperty('truncated');
    expect((projected.result as { data: Record<string, unknown> }).data).not.toHaveProperty('log_path');
  });

  it('projects webfetch stash_url without stash_path', () => {
    const projected = projectAnalystToolInvocationActivity({
      tool: 'webfetch',
      params: { url: 'https://example.test' },
      result: { success: true, data: { stash_url: 'work:///tmp/stash/webfetch.txt', stash_path: '.saivage-work/tmp/stash/webfetch.txt', bytes: 123 } },
    });

    expect((projected.result as { data: Record<string, unknown> }).data.stash_url).toBe('work:///tmp/stash/webfetch.txt');
    expect((projected.result as { data: Record<string, unknown> }).data).not.toHaveProperty('stash_path');
  });
});
