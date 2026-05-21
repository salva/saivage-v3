import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pauseRuntime, listCards } from '../api/client';
import { operatorRouteInventory, parseCoveredWsEnvelope, parseOperatorResponse } from '../api/contracts';

vi.mock('../api/auth', () => ({ getAuthToken: vi.fn(() => 'token') }));
vi.mock('../utils/auth-events', () => ({ dispatchApiAuthRequired: vi.fn() }));

const runtimeState = {
  status: 'paused',
  project_id: 'project',
  pid: 123,
  started_at: '2026-01-01T00:00:00.000Z',
  current_card_id: null,
  current_agent_session_id: null,
  paused: true,
  paused_at: '2026-01-01T00:00:02.000Z',
  queue: [],
  running_processes: [],
  updated_at: '2026-01-01T00:00:02.000Z',
};

describe('web API contract parser boundary', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses migrated runtime responses and rejects malformed JSON payloads', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify(runtimeState), { status: 200 }));
    await expect(pauseRuntime()).resolves.toEqual(runtimeState);

    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ status: 'paused' }), { status: 200 }));
    await expect(pauseRuntime()).rejects.toThrow();
  });

  it('parses migrated card list responses', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ cards: [], total: 0 }), { status: 200 }));
    await expect(listCards()).resolves.toEqual({ cards: [], total: 0 });
  });

  it('exposes a web-safe contract adapter without server-only runtime behavior', () => {
    expect(operatorRouteInventory().map((row) => row.operationId)).toContain('runtime.pause');
    expect(parseOperatorResponse('runtime.pause', runtimeState).paused).toBe(true);
    const health = { canonical: 'ok', compatibilitySnapshots: 'ok', lastCompatibilitySnapshotWarning: null, warnings: [] };
    expect(parseOperatorResponse('runtime.getState', { runtime: null, cardIndex: { total: 0, byStatus: {}, byType: {} }, cardStoreHealth: health }).cardStoreHealth).toEqual(health);
    expect(parseCoveredWsEnvelope({ type: 'status', content: { event: 'runtime-state', cardStoreHealth: health } })?.content.event).toBe('runtime-state');
    expect(parseCoveredWsEnvelope({ type: 'status', content: { event: 'runtime-paused' } })?.content.event).toBe('runtime-paused');
  });
});
