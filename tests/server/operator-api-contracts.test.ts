import { describe, expect, it } from '@jest/globals';
import { createRuntimeEnvelope } from '../../src/server/websocket.js';
import { ServerAvailabilitySchema, operatorApiContracts, operatorRouteInventory, parseOperatorResponse } from '../../src/contracts/operator-api.js';
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
  runtime_intent: { status: 'stopped', updated_at: '2026-01-01T00:00:01.000Z', source_command_id: null, reason: null },
  runtime_commands: [],
  runtime_runs: [],
  runtime_activations: [],
};


const serverAvailability = {
  generatedAt: '2026-01-01T00:00:02.000Z',
  components: {
    api: { state: 'available', source: 'health-check', checkedAt: '2026-01-01T00:00:02.000Z' },
    runtime: { state: 'available', source: 'active-runtime', checkedAt: '2026-01-01T00:00:02.000Z' },
    mcp: { state: 'degraded', source: 'mcp-manager', checkedAt: '2026-01-01T00:00:02.000Z', diagnostic: { code: 'mcp-manager-empty', summary: 'MCP manager is running with no configured servers.' } },
  },
};


const runtimeCommand = {
  command_id: 'cmd-1',
  command: 'start_project',
  status: 'completed',
  requested_at: '2026-01-01T00:00:00.000Z',
  completed_at: '2026-01-01T00:00:01.000Z',
  source: 'operator',
  error: null,
};

const runtimeIntent = {
  status: 'running',
  updated_at: '2026-01-01T00:00:01.000Z',
  source_command_id: 'cmd-1',
  reason: 'operator start_project',
};

const runtimeRun = {
  run_id: 'run-1',
  kind: 'root',
  card_id: 'project',
  command_id: 'cmd-1',
  activation_id: null,
  parent_run_id: null,
  phase: 'planner',
  runtime_status: 'running',
  session_id: 'planner:project',
  started_at: '2026-01-01T00:00:01.000Z',
  updated_at: '2026-01-01T00:00:01.000Z',
  finished_at: null,
  result: null,
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
      'runtime.startProject',
      'runtime.stopProject',
      'runtime.pause',
      'runtime.resume',
      'cards.list',
      'cards.get',
      'cards.create',
      'cards.update',
    ]);
    expect(operatorRouteInventory()).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: 'runtime.startProject', method: 'POST', path: '/api/runtime/start_project', successSchemaName: 'RuntimeCommandResponse' }),
      expect.objectContaining({ operationId: 'runtime.stopProject', method: 'POST', path: '/api/runtime/stop_project', successSchemaName: 'RuntimeCommandResponse' }),
      expect.objectContaining({ operationId: 'runtime.pause', method: 'POST', path: '/api/runtime/pause', successSchemaName: 'RuntimeState' }),
      expect.objectContaining({ operationId: 'runtime.resume', method: 'POST', path: '/api/runtime/resume', successSchemaName: 'RuntimeState' }),
    ]));
  });

  it('parses first-batch success examples', () => {
    expect(parseOperatorResponse('runtime.getState', { runtime: runtimeState, cardIndex: { total: 1, byStatus: { backlog: 1 }, byType: { code: 1 } } }).runtime).toEqual(runtimeState);
    expect(parseOperatorResponse('runtime.startProject', { success: true, command: runtimeCommand, intent: runtimeIntent, run: runtimeRun }).run?.run_id).toBe('run-1');
    expect(parseOperatorResponse('runtime.stopProject', { success: true, command: { ...runtimeCommand, command: 'stop_project' }, intent: { ...runtimeIntent, status: 'stopped' } }).intent.status).toBe('stopped');
    expect(parseOperatorResponse('runtime.getState', { runtime: runtimeState, cardIndex: { total: 1, byStatus: { backlog: 1 }, byType: { code: 1 } }, serverAvailability }).serverAvailability?.components.mcp.state).toBe('degraded');
    expect(parseOperatorResponse('runtime.pause', { ...runtimeState, status: 'paused', paused: true }).paused).toBe(true);
    expect(parseOperatorResponse('runtime.resume', runtimeState).status).toBe('idle');
    expect(parseOperatorResponse('cards.list', { cards: [card], total: 1 }).total).toBe(1);
    expect(parseOperatorResponse('cards.get', { card, children: [], ancestorIds: [] }).card.id).toBe('card-1');
    expect(parseOperatorResponse('cards.create', { card }).card.id).toBe('card-1');
    expect(parseOperatorResponse('cards.update', { card }).card.status).toBe('backlog');
  });



  it('accepts optional read-only CardStore health on runtime state responses', () => {
    const degradedHealth = {
      canonical: 'ok',
      compatibilitySnapshots: 'degraded',
      lastCompatibilitySnapshotWarning: {
        code: 'compatibility-snapshot-degraded',
        operation: 'mutation-rebuild',
        relativePath: '.saivage/cards/tree/project.children.json',
        message: 'Synthetic redacted snapshot write failure for [REDACTED]',
        errorName: 'Error',
        occurredAt: '2026-01-01T00:00:03.000Z',
        canonicalCommitted: true,
      },
      warnings: [],
    };
    const parsed = parseOperatorResponse('runtime.getState', {
      runtime: runtimeState,
      cardIndex: { total: 1, byStatus: { backlog: 1 }, byType: { code: 1 } },
      cardStoreHealth: { ...degradedHealth, warnings: [degradedHealth.lastCompatibilitySnapshotWarning] },
    });
    expect(parsed.cardStoreHealth?.compatibilitySnapshots).toBe('degraded');
    expect(parseOperatorResponse('runtime.getState', { runtime: runtimeState, cardIndex: { total: 0, byStatus: {}, byType: {} } }).cardStoreHealth).toBeUndefined();
  });

  it('rejects malformed server availability component states', () => {
    expect(ServerAvailabilitySchema.parse(serverAvailability).components.api.state).toBe('available');
    expect(() => parseOperatorResponse('runtime.getState', {
      runtime: runtimeState,
      cardIndex: { total: 0, byStatus: {}, byType: {} },
      serverAvailability: { ...serverAvailability, components: { ...serverAvailability.components, runtime: { ...serverAvailability.components.runtime, state: 'failed' } } },
    })).toThrow();
  });

  it('rejects malformed migrated responses', () => {
    expect(operatorApiContracts['runtime.startProject'].error.parse({ success: false, actionable_error: { code: 'active_runtime_unavailable', message: 'missing runtime', nextAction: 'Start runtime.' } }).actionable_error.code).toBe('active_runtime_unavailable');
    expect(() => parseOperatorResponse('runtime.pause', { status: 'paused' })).toThrow();
    expect(() => parseOperatorResponse('cards.list', { cards: [{}], total: 1 })).toThrow();
  });


  it('does not register obsolete lets_dance or preview-hash runtime controls', () => {
    const paths = operatorRouteInventory().map((route) => route.path);
    expect(paths).toContain('/api/runtime/start_project');
    expect(paths).toContain('/api/runtime/stop_project');
    expect(paths).not.toContain('/api/runtime/lets_dance');
    expect(JSON.stringify(operatorApiContracts)).not.toMatch(/preview_hash|confirmed/);
  });

  it('validates covered websocket status events but preserves unknown events', () => {
    const covered = createRuntimeEnvelope('runtime-state', { runtime: runtimeState, cardIndex: { total: 0, byStatus: {}, byType: {} } });
    expect(parseCoveredWsEnvelope(covered)?.content.event).toBe('runtime-state');
    const unknown = createRuntimeEnvelope('future-runtime-event', { value: true });
    expect(parseCoveredWsEnvelope(unknown)).toBeNull();
    expect(unknown).toEqual({ type: 'status', content: { event: 'future-runtime-event', value: true } });
  });
});
