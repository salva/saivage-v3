import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/auth', () => ({ getAuthToken: () => 'process-transport-token' }));

import { listProcesses } from '../api/client';

describe('web process-list transport', () => {
  const request = vi.fn();

  beforeEach(() => {
    request.mockReset();
    vi.stubGlobal('fetch', request);
  });

  it('uses the shared bearer header without putting the token in the URL', async () => {
    request.mockResolvedValue(new Response(JSON.stringify({ processes: [] }), { status: 200 }));

    await expect(listProcesses()).resolves.toEqual({ processes: [] });

    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe('http://localhost:3000/api/processes');
    expect(url).not.toContain('process-transport-token');
    expect(init.headers).toEqual({ Authorization: 'Bearer process-transport-token' });
  });

  const process = {
    id: 'proc-1', started_at: '2026-01-01T00:00:00.000Z', ended_at: null, exit_code: null,
    timed_out: false, owner_id: 'runtime', owner_kind: 'runtime', session_id: null, card_id: null,
    command: 'echo ok', cwd: null, logs: { stdout: null, stderr: null },
  };

  it.each(['running', 'exited', 'failed', 'killed'])('accepts transported process status %s', async (status) => {
    request.mockResolvedValue(new Response(JSON.stringify({ processes: [{ ...process, status }] }), { status: 200 }));
    await expect(listProcesses()).resolves.toEqual({ processes: [{ ...process, status }] });
  });

  it.each([
    { ...process, status: 'unknown' },
    { ...process, status: 'running', unexpected: true },
  ])('rejects malformed transported process view %#', async (malformed) => {
    request.mockResolvedValue(new Response(JSON.stringify({ processes: [malformed] }), { status: 200 }));
    await expect(listProcesses()).rejects.toThrow();
  });
});
