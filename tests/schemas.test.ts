import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  cardRecordSchema,
  
  processRecordSchema,
  projectConfigSchema,
  runtimeStateSchema,
  runtimeDispatchOwnershipSchema,
  agentMessageSchema,
  createActivationCompletionEnvelope,
  parseActivationCompletionEnvelope,
} from '../src/schemas/validators.js';
import { initProjectTree } from '../src/persistence/file-tree.js';
import { readRuntimeState } from '../src/runtime/state.js';


describe('Activation envelope schemas', () => {
  it('rejects completion envelopes with unplanned outcomes', () => {
    expect(() => createActivationCompletionEnvelope({ child_card_id: 'code-a', outcome: 'unknown' as any, summary: 'bad outcome' })).toThrow();
    expect(parseActivationCompletionEnvelope(JSON.stringify({ kind: 'activate_card_completion', version: 1, child_card_id: 'code-a', cardId: 'code-a', success: true, outcome: 'unknown', summary: 'bad' }))).toBeNull();
  });

  it('creates and parses typed completion envelopes', () => {
    const envelope = createActivationCompletionEnvelope({ child_card_id: 'code-a', outcome: 'done', summary: 'complete', result: { ok: true }, failure_kind: undefined });
    expect(envelope).toEqual(expect.objectContaining({ kind: 'activate_card_completion', version: 1, child_card_id: 'code-a', cardId: 'code-a', success: true, outcome: 'done' }));
    expect(parseActivationCompletionEnvelope(JSON.stringify(envelope))?.child_card_id).toBe('code-a');
  });
});

describe('Core schemas still validate expected records', () => {
  it('accepts a valid project config', () => {
    expect(projectConfigSchema.safeParse({
      id: 'project',
      name: 'saivage-v3',
      context: '',
      goals_summary: '',
      constraints: [],
      planner_enabled: true,
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
    }).success).toBe(true);
  });

  it('accepts a valid card record', () => {
    expect(cardRecordSchema.safeParse({
      id: 'goal-1',
      type: 'goal',
      parent: 'project',
      depth: 1,
      title: 'Goal 1',
      description: '',
      status: 'backlog',
      lifecycle: { status: 'backlog', result: null, error: null, completed_at: null },
      tags: [],
      priority: 0,
      position: 0,
      urgency: 'normal',
      created_by: 'analyst',
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
      version_seq: 1,
      depends_on: [],
      related: [],
      acceptance: '',
      metadata: { max_review_retries: 2, custom: 'kept' },
      retries: 0,
    }).success).toBe(true);
  });



  it('accepts goal-card retry override metadata and rejects invalid values', () => {
    const base = {
      id: 'goal-meta',
      type: 'goal',
      parent: 'project',
      depth: 1,
      title: 'Goal Meta',
      description: '',
      status: 'backlog',
      lifecycle: { status: 'backlog', result: null, error: null, completed_at: null },
      tags: [],
      priority: 0,
      position: 0,
      urgency: 'normal',
      created_by: 'analyst',
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
      version_seq: 1,
      depends_on: [],
      related: [],
      acceptance: '',
      retries: 0,
    };
    expect(cardRecordSchema.safeParse({ ...base, metadata: { max_review_retries: 4 } }).success).toBe(true);
    expect(cardRecordSchema.safeParse({ ...base, metadata: { max_review_retries: -1 } }).success).toBe(false);
  });

  it('accepts a valid process record', () => {
    expect(processRecordSchema.safeParse({
      id: 'proc-1',
      card_id: 'goal-1',
      owner_id: 'agent-1',
      owner_kind: 'agent',
      command: 'npm test',
      command_hash: 'a'.repeat(64),
      cwd: '/tmp',
      cwd_canonical: '/tmp',
      status: 'running',
      started_at: '2025-01-01T00:00:00.000Z',
      started_at_monotonic: 1,
      required_for_card_completion: false,
      output_dir: '/tmp/out',
      stdout_path: '/tmp/out/stdout.log',
      stderr_path: '/tmp/out/stderr.log',
    }).success).toBe(true);
  });


  it('rejects removed process record reconciliation fields and enum values', () => {
    const base = {
      id: 'proc-1',
      card_id: 'goal-1',
      owner_id: 'agent-1',
      owner_kind: 'agent',
      command: 'npm test',
      command_hash: 'a'.repeat(64),
      cwd: '/tmp',
      cwd_canonical: '/tmp',
      status: 'running',
      started_at: '2025-01-01T00:00:00.000Z',
      started_at_monotonic: 1,
      required_for_card_completion: false,
      output_dir: '/tmp/out',
      stdout_path: '/tmp/out/stdout.log',
      stderr_path: '/tmp/out/stderr.log',
    };
    expect(processRecordSchema.safeParse({ ...base, terminal_reason: 'lost' }).success).toBe(false);
    expect(processRecordSchema.safeParse({ ...base, terminal_reason: 'kill_unattached' }).success).toBe(false);
    expect(processRecordSchema.safeParse({ ...base, failure_classification: 'lost' }).success).toBe(false);
    expect(processRecordSchema.safeParse({ ...base, reattach_error: 'legacy' }).success).toBe(false);
    expect(processRecordSchema.safeParse({ ...base, process_group_id: 123 }).success).toBe(false);
  });

  it('accepts a valid runtime state', () => {
    expect(runtimeStateSchema.safeParse({
      status: 'running',
      project_id: 'project',
      pid: 123,
      started_at: '2025-01-01T00:00:00.000Z',
      active_card_run: null,
      updated_at: '2025-01-01T00:00:00.000Z',
    }).success).toBe(true);
    expect(runtimeStateSchema.safeParse({
      status: 'running', project_id: 'project', pid: 123, started_at: '2025-01-01T00:00:00.000Z', active_card_run: null, updated_at: '2025-01-01T00:00:00.000Z', runtime_commands: [], runtime_runs: [], runtime_activations: [],
    }).success).toBe(false);
    expect(runtimeDispatchOwnershipSchema.safeParse({ kind: 'activation', parent_card_id: 'project', parent_tool_call: { session_id: 'planner:project', source_input_id: 'planner:project:1', tool_call_id: 'call-1' } }).success).toBe(true);
    expect(runtimeDispatchOwnershipSchema.safeParse({ kind: 'activation', parent_card_id: 'project', parent_tool_call: { session_id: 'planner:project', tool_call_id: 'call-1' } }).success).toBe(false);
    expect(runtimeDispatchOwnershipSchema.safeParse({ kind: 'activation', activation_id: 'act-1', parent_run_id: 'run-1', parent_card_id: 'project', parent_tool_call: { session_id: 'planner:project', source_input_id: 'planner:project:1', tool_call_id: 'call-1' } }).success).toBe(false);
  });

  it('enforces persisted tool_error identity', () => {
    const base = {
      id: 'planner:G-1:1:tool-error:call-1',
      session_id: 'planner:G-1',
      role: 'tool',
      kind: 'tool_error',
      content: 'tool failed',
      round_id: 'r-user-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      message_index: 2,
      block_index: 0,
      timestamp: '2025-01-01T00:00:00.000Z',
      tool: 'emit_result',
      tool_call_id: 'call-1',
    };
    expect(agentMessageSchema.safeParse(base).success).toBe(true);
    expect(agentMessageSchema.safeParse({ ...base, tool: undefined }).success).toBe(false);
    expect(agentMessageSchema.safeParse({ ...base, tool_call_id: undefined }).success).toBe(false);
    expect(agentMessageSchema.safeParse({ ...base, id: 'planner:G-1:1:tool-error:other-call' }).success).toBe(false);
    expect(agentMessageSchema.safeParse({ ...base, id: 'planner:G-1:1:error:call-1' }).success).toBe(false);
  });


  it('strips legacy runtime state fields while parsing current runtime state', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-legacy-'));
    try {
      initProjectTree(root);
      writeFileSync(
        join(root, '.saivage', 'runtime', 'state.json'),
        JSON.stringify({ status: 'idle', queue: [] }, null, 2),
      );
      expect(readRuntimeState(root)).toMatchObject({ status: 'stopped' });
      expect(readRuntimeState(root)).not.toHaveProperty('queue');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects legacy card record shape via schema parse', () => {
    const result = cardRecordSchema.safeParse({
      id: 'goal-1',
      type: 'goal',
      parent: 'project',
      depth: 1,
      title: 'Goal 1',
      description: '',
      status: 'backlog',
      tags: [],
      priority: 0,
      urgency: 'normal',
      created_by: 'analyst',
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
      depends_on: [],
      related: [],
      acceptance: '',
      metadata: { max_review_retries: 2, custom: 'kept' },
      retries: 0,
    });
    expect(result.success).toBe(false);
  });
});

import {
  EventRegistry as SchemaEventRegistry,
  agentEventKindValues,
  eventKindValues,
  runtimeEventKindValues,
} from '../src/schemas/index.js';
import {
  EventRegistry as RuntimeEventRegistry,
  eventKindValues as runtimePackageEventKindValues,
  getEventSeverity,
} from '../src/events/index.js';
import {
  agentEventKindSchema,
  eventKindSchema,
  loggedEventSchema,
  loggedEventSchemaByKind,
  runtimeEventKindSchema,
} from '../src/schemas/validators.js';

describe('Runtime event catalog schemas', () => {
  const timestamp = '2025-01-01T00:00:00.000Z';

  it('derives Zod event-kind schemas from exported catalog arrays', () => {
    expect(runtimeEventKindSchema.options).toEqual([...runtimeEventKindValues]);
    expect(agentEventKindSchema.options).toEqual([...agentEventKindValues]);
    expect(eventKindSchema.options).toEqual([...eventKindValues]);
    expect(Object.keys(loggedEventSchemaByKind).sort()).toEqual([...eventKindValues].sort());
  });

  it('uses one bottom-layer event catalog for schemas and the events package', () => {
    expect(runtimePackageEventKindValues).toEqual(eventKindValues);
    expect(RuntimeEventRegistry).toBe(SchemaEventRegistry);
    expect(getEventSeverity('runtime_diagnostic')).toBe(SchemaEventRegistry.runtime_diagnostic.severity);
  });

  it('strictly validates kept event kinds with their payloads', () => {
    expect(loggedEventSchema.parse({ id: 'evt-runtime-diagnostic', kind: 'runtime_diagnostic', timestamp, session_id: 'sess-1', error_message: 'boom' })).toMatchObject({ kind: 'runtime_diagnostic', session_id: 'sess-1' });
    expect(loggedEventSchema.parse({ id: 'evt-mcp', kind: 'mcp_tool_invocation', timestamp, session_id: 'sess-1', role: 'planner', server_name: 'planner-control', tool_name: 'activate_card', success: true })).toMatchObject({ kind: 'mcp_tool_invocation', tool_name: 'activate_card' });
  });

  it('rejects unknown event kinds under strict current validation', () => {
    const historical = { id: 'evt-old', kind: 'legacy_kind_from_old_log', timestamp, payload: { kept: true } };
    expect(loggedEventSchema.safeParse(historical).success).toBe(false);
  });
});
