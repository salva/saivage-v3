import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/auth', () => ({ getAuthToken: () => 'transport-token' }));

import { restartServer } from '../api/client';

describe('web runtime-control transport', () => {
  const request = vi.fn();

  beforeEach(() => {
    request.mockReset();
    vi.stubGlobal('fetch', request);
  });

  it('sends Restart with the exact JSON confirmation and content type', async () => {
    request.mockResolvedValue(new Response(JSON.stringify({ status: 'restart_scheduled' }), { status: 200 }));
    await expect(restartServer()).resolves.toEqual({ status: 'restart_scheduled' });

    const [, init] = request.mock.calls[0]!;
    expect(init.body).toBe('{"confirmation":"RESTART SERVER"}');
    expect(init.headers).toEqual({ Authorization: 'Bearer transport-token', 'Content-Type': 'application/json' });
  });
});
