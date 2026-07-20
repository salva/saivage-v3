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
});
