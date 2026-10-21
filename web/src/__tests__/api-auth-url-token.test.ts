import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAuthToken } from '../api/auth';
import { issueWebSocketTicket } from '../api/client';

describe('API auth URL token handling', () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, '', '/?token=arch004-test-token');
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('ignores URL query tokens and never persists them', () => {
    expect(getAuthToken()).not.toBe('arch004-test-token');
    expect(getAuthToken()).toBeNull();
    expect(localStorage.getItem('saivage_api_token')).toBeNull();
  });

  it('still returns operator-set localStorage tokens for bearer deployments', () => {
    localStorage.setItem('saivage_api_token', 'arch004-stored-token');
    expect(getAuthToken()).toBe('arch004-stored-token');
  });

  it('keeps exact nonempty local values ahead of build fallback and removal does not disable fallback', async () => {
    vi.stubEnv('VITE_SAIVAGE_API_TOKEN', 'dummy-build');
    for (const value of ['dummy-local', '   ']) {
      localStorage.setItem('saivage_api_token', value);
      expect(getAuthToken()).toBe(value);
    }
    localStorage.setItem('saivage_api_token', '');
    expect(getAuthToken()).toBe('dummy-build');
    localStorage.removeItem('saivage_api_token');
    expect(getAuthToken()).toBe('dummy-build');
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ticket: 'dummy-ticket', expiresAt: '2026-10-21T00:00:00.000Z' }) });
    vi.stubGlobal('fetch', fetch);
    await issueWebSocketTicket();
    expect(fetch).toHaveBeenCalledWith(new URL('/api/auth/ws-ticket', window.location.origin).toString(), expect.objectContaining({ method: 'POST', headers: expect.objectContaining({ Authorization: 'Bearer dummy-build' }) }));
    vi.stubEnv('VITE_SAIVAGE_API_TOKEN', '');
    expect(getAuthToken()).toBeNull();
    await issueWebSocketTicket();
    expect(fetch.mock.calls[1]![1].headers).not.toHaveProperty('Authorization');
  });
});
