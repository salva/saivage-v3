import { describe, expect, it } from '@jest/globals';
import { join } from 'node:path';
import { ProcessReadModelService } from '../../src/application/read-models/index.js';
import type { ProcessRecord } from '../../src/schemas/index.js';

function record(overrides: Partial<ProcessRecord> = {}): ProcessRecord {
  return {
    id: 'proc-1',
    card_id: 'card-1',
    command: 'echo token=super-secret-value',
    command_hash: 'a'.repeat(64),
    cwd: '/workspace/project/subdir',
    cwd_canonical: '/workspace/project/subdir',
    status: 'running',
    pid: 123,
    started_at: '2026-01-01T00:00:00.000Z',
    started_at_monotonic: 1,
    completed_at: null,
    exit_code: null,
    signal: null,
    terminal_reason: null,
    required_for_card_completion: true,
    output_dir: '/workspace/project/.saivage-work/processes/proc-1',
    stdout_path: '/workspace/project/.saivage-work/processes/proc-1/stdout.log',
    stderr_path: '/workspace/project/.saivage-work/processes/proc-1/stderr.log',
    combined_log_path: '/workspace/project/.saivage-work/processes/proc-1/combined.log',
    agent_session_id: 'agent-1',
    goal_id: null,
    launch_reason: null,
    owner_kind: 'agent',
    background_policy: null,
    process_group_id: 123,
    reattach_state: 'attached',
    failure_classification: null,
    ...overrides,
  };
}

describe('ProcessReadModelService', () => {
  it('projects process records into the existing operator-safe process view shape', () => {
    const service = new ProcessReadModelService('/workspace/project');

    expect(service.toProcessView(record())).toEqual({
      id: 'proc-1',
      status: 'running',
      started_at: '2026-01-01T00:00:00.000Z',
      ended_at: null,
      exit_code: null,
      timed_out: false,
      owner: 'agent',
      session_id: 'agent-1',
      card_id: 'card-1',
      command: expect.any(String),
      cwd: 'subdir',
      logs: {
        stdout: join('.saivage-work', 'processes', 'proc-1', 'stdout.log'),
        stderr: join('.saivage-work', 'processes', 'proc-1', 'stderr.log'),
        combined: join('.saivage-work', 'processes', 'proc-1', 'combined.log'),
      },
      control: {
        can_view_logs: true,
        termination_available: false,
        unavailable_reason: 'Process termination is not available in this redesign cycle.',
      },
    });
  });

  it('redacts sensitive commands and hides paths outside the project root', () => {
    const service = new ProcessReadModelService('/workspace/project');
    const view = service.toProcessView(record({
      command: 'curl https://example.test --header "Authorization: Bearer secret-token"',
      cwd: '/etc',
      stdout_path: '/tmp/out.log',
      stderr_path: null as unknown as string,
      combined_log_path: undefined as unknown as string,
    }));

    expect(view.command).not.toContain('secret-token');
    expect(view.cwd).toBeNull();
    expect(view.logs).toEqual({ stdout: null, stderr: null, combined: null });
    expect(view.control.can_view_logs).toBe(false);
  });

  it('preserves the legacy timed_out heuristic', () => {
    const service = new ProcessReadModelService('/workspace/project');
    expect(service.toProcessView(record({ status: 'failed', exit_code: null }))).toHaveProperty('timed_out', true);
    expect(service.toProcessView(record({ status: 'failed', exit_code: 1 }))).toHaveProperty('timed_out', false);
  });
});
