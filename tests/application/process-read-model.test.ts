import { describe, expect, it } from '@jest/globals';

import { buildProcessView } from '../../src/application/read-models/process-view.js';
import type { ProcessView } from '../../src/contracts/operator-api.js';
import type { ProcessRecord } from '../../src/runtime/process-runner.js';

function record(overrides: Partial<ProcessRecord> = {}): ProcessRecord {
  return {
    id: 'proc-1',
    card_id: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    owner_id: 'agent-1',
    owner_kind: 'agent',
    agent_session_id: 'agent-1',
    command: 'echo token=super-secret-value',
    cwd: '/workspace/project/subdir',
    status: 'running',
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    exit_code: null,
    signal: null,
    stdout_path: '/workspace/project/.saivage/work/cards/card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa/processes/proc-1/stdout.log',
    stderr_path: '/workspace/project/.saivage/work/cards/card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa/processes/proc-1/stderr.log',
    ...overrides,
  };
}

async function processView(input: ProcessRecord): Promise<ProcessView> {
  return buildProcessView('/workspace/project', input);
}

describe('process operator view projection', () => {
  it('projects process records into the operator-safe process view shape', async () => {
    await expect(processView(record())).resolves.toEqual({
      id: 'proc-1',
      status: 'running',
      started_at: '2026-01-01T00:00:00.000Z',
      ended_at: null,
      exit_code: null,
      timed_out: false,
      owner_id: 'agent-1',
      owner_kind: 'agent',
      session_id: 'agent-1',
      card_id: 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      command: expect.any(String),
      cwd: 'subdir',
      logs: {
        stdout: 'work:///cards/card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa/processes/proc-1/stdout.log',
        stderr: 'work:///cards/card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa/processes/proc-1/stderr.log',
      },
    });
  });

  it('redacts sensitive commands and preserves missing log paths as null', async () => {
    const view = await processView(record({
      command: 'curl https://example.test --header "Authorization: Bearer secret-token"',
      cwd: '/workspace/project/subdir',
      stdout_path: null as unknown as string,
      stderr_path: null as unknown as string,
    }));

    expect(view.command).not.toContain('secret-token');
    expect(view.cwd).toBe('subdir');
    expect(view.logs).toEqual({ stdout: null, stderr: null });
  });

  it('preserves the timed_out heuristic used by operator routes', async () => {
    await expect(processView(record({ status: 'failed', exit_code: null }))).resolves.toHaveProperty('timed_out', true);
    await expect(processView(record({ status: 'failed', exit_code: 1 }))).resolves.toHaveProperty('timed_out', false);
  });
});
