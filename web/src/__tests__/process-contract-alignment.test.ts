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
      logs: { stdout: null, stderr: null, combined: 'logs/proc-1.log' },
      control: {
        can_view_logs: true,
        termination_available: false,
        unavailable_reason: 'Process termination is not exposed by the operator API.',
      },
    });

    const processView: ProcessView = parsed;
    const listResponse: ProcessListResponse = { processes: [processView] };
    const detailResponse: ProcessDetailResponse = { process: processView };

    expect(listResponse.processes[0]).toEqual(detailResponse.process);
    expect(detailResponse.process.control.termination_available).toBe(false);
  });
});
