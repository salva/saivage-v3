import { describe, expect, it } from 'vitest';
import { ProcessViewSchema } from '../api/contracts';
import type { ProcessDetailResponse, ProcessListResponse, ProcessView } from '../api/types';

describe('process contract alignment', () => {
  it('uses the shared process contract shape for web process DTOs', () => {
    const parsed = ProcessViewSchema.parse({
      id: 'proc-1',
      status: 'exited',
      owner_id: 'session-1',
      started_at: '2026-01-01T00:00:00.000Z',
      ended_at: '2026-01-01T00:00:01.000Z',
      exit_code: 0,
      timed_out: false,
      owner: 'agent',
      session_id: 'session-1',
      card_id: 'card-1',
      command: 'echo ok',
      cwd: '/work/project',
      logs: { stdout: 'work:///processes/proc-1/stdout.log', stderr: null },
    });

    const processView: ProcessView = parsed;
    const listResponse: ProcessListResponse = { processes: [processView] };
    const detailResponse: ProcessDetailResponse = { process: processView };

    expect(listResponse.processes[0]).toEqual(detailResponse.process);
    expect(detailResponse.process.logs.stdout).toBe('work:///processes/proc-1/stdout.log');
  });
});
