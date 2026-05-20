import { describe, expect, it } from '@jest/globals';
import { createRuntimeEnvelope } from '../../src/server/websocket.js';
import { operatorApiContracts, operatorRouteInventory, parseOperatorResponse } from '../../src/contracts/operator-api.js';
import { parseCoveredWsEnvelope } from '../../src/contracts/operator-events.js';

const runtimeState = {
  status: 'idle',
  project_id: 'project',
  pid: 123,
  started_at: '2026-01-01T00:00:00.000Z',
  current_card_id: null,
  current_agent_session_id: null,
  paused: false,
  paused_at: null,
  queue: [],
  running_processes: [],
  updated_at: '2026-01-01T00:00:01.000Z',
};

const card = {
  id: 'card-1',
  type: 'code',
  parent: null,
  depth: 0,
  title: 'Card 1',
  description: '',
  status: 'backlog',
  subtype: null,
  instructions_file: null,
  tags: [],
  priority: 0,
  urgency: 'normal',
  created_by: 'user',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  version_seq: 1,
  assigned_to: null,
  depends_on: [],
  blocks: [],
  related: [],
  acceptance: '',
  result: null,
  metrics: null,
  artifacts: [],
  attachments: [],
  estimate: null,
  started_at: null,
  completed_at: null,
  duration_ms: null,
  error: null,
  retries: 0,
};

describe('operator API contract registry', () => {
  it('contains the bounded first-batch operation inventory', () => {
    expect(Object.keys(operatorApiContracts)).toEqual([
      'runtime.getState',
      'runtime.pause',
      'runtime.resume',
      'cards.list',
      'cards.get',
      'cards.create',
      'cards.update',
    ]);
    expect(operatorRouteInventory()).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: 'runtime.pause', method: 'POST', path: '/api/runtime/pause', successSchemaName: 'RuntimeState' }),
      expect.objectContaining({ operationId: 'runtime.resume', method: 'POST', path: '/api/runtime/resume', successSchemaName: 'RuntimeState' }),
    ]));
  });

  it('parses first-batch success examples', () => {
    expect(parseOperatorResponse('runtime.getState', { runtime: runtimeState, cardIndex: { total: 1, byStatus: { backlog: 1 }, byType: { code: 1 } } }).runtime).toEqual(runtimeState);
    expect(parseOperatorResponse('runtime.pause', { ...runtimeState, status: 'paused', paused: true }).paused).toBe(true);
    expect(parseOperatorResponse('runtime.resume', runtimeState).status).toBe('idle');
    expect(parseOperatorResponse('cards.list', { cards: [card], total: 1 }).total).toBe(1);
    expect(parseOperatorResponse('cards.get', { card, children: [], ancestorIds: [] }).card.id).toBe('card-1');
    expect(parseOperatorResponse('cards.create', { card }).card.id).toBe('card-1');
    expect(parseOperatorResponse('cards.update', { card }).card.status).toBe('backlog');
  });

  it('rejects malformed migrated responses', () => {
    expect(() => parseOperatorResponse('runtime.pause', { status: 'paused' })).toThrow();
    expect(() => parseOperatorResponse('cards.list', { cards: [{}], total: 1 })).toThrow();
  });

  it('validates covered websocket status events but preserves unknown events', () => {
    const covered = createRuntimeEnvelope('runtime-state', { runtime: runtimeState, cardIndex: { total: 0, byStatus: {}, byType: {} } });
    expect(parseCoveredWsEnvelope(covered)?.content.event).toBe('runtime-state');
    const unknown = createRuntimeEnvelope('future-runtime-event', { value: true });
    expect(parseCoveredWsEnvelope(unknown)).toBeNull();
    expect(unknown).toEqual({ type: 'status', content: { event: 'future-runtime-event', value: true } });
  });
});
