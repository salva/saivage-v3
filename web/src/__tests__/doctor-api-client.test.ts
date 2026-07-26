import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/auth', () => ({ getAuthToken: () => null }));

import { getDoctor } from '../api/client';

const ok = {
  status: 'ok',
  checks: [{ name: 'cards_loadable', passed: true, details: 'Cards loaded successfully.' }],
  issues: [],
} as const;
const issuesFound = {
  status: 'issues_found',
  checks: [{ name: 'cards_loadable', passed: false, details: 'Cards failed to load.' }],
  issues: [{ severity: 'error', message: 'Cards failed to load.' }],
} as const;

describe('Doctor API client contract', () => {
  const request = vi.fn();

  beforeEach(() => {
    request.mockReset();
    vi.stubGlobal('fetch', request);
  });

  it.each([ok, issuesFound])('accepts an exact $status projection', async (projection) => {
    request.mockResolvedValue(new Response(JSON.stringify(projection), { status: 200 }));
    await expect(getDoctor()).resolves.toEqual(projection);
  });

  it.each([
    { ...ok, unexpected: true },
    { ...ok, checks: issuesFound.checks },
    { ...ok, issues: issuesFound.issues },
    { ...issuesFound, issues: [] },
  ])('rejects an incoherent or inexact successful projection %#', async (projection) => {
    request.mockResolvedValue(new Response(JSON.stringify(projection), { status: 200 }));
    await expect(getDoctor()).rejects.toThrow();
  });
});
