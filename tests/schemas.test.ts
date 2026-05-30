import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  attachmentRefSchema,
  artifactRefSchema,
  cardRecordSchema,
  
  processRecordSchema,
  projectConfigSchema,
  reviewerResultSchema,
  reviewAssessmentSchema,
  runtimeStateSchema,
  processReconciledDeadEventSchema,
  processReattachRejectedEventSchema,
  createDeferredActivationEnvelope,
  createActivationCompletionEnvelope,
  parseDeferredActivationEnvelope,
  parseActivationCompletionEnvelope,
  parseActivationEnvelopeContent,
} from '../src/schemas/validators.js';
import { initProjectTree } from '../src/persistence/file-tree.js';
import { readRuntimeState } from '../src/runtime/state.js';


describe('Activation envelope schemas', () => {
  it('creates and parses typed deferred activation envelopes and rejects malformed payloads', () => {
    const envelope = createDeferredActivationEnvelope({ parent_card_id: 'goal-a', child_card_id: 'code-a', planner_session_id: 'planner:goal-a', tool_call_id: 'call-a', requested_at: '2025-01-01T00:00:00.000Z' });
    expect(envelope).toEqual({ kind: 'deferred_activate_card', version: 1, parent_card_id: 'goal-a', child_card_id: 'code-a', planner_session_id: 'planner:goal-a', tool_call_id: 'call-a', requested_at: '2025-01-01T00:00:00.000Z' });
    expect(parseDeferredActivationEnvelope(JSON.stringify(envelope))?.child_card_id).toBe('code-a');
    expect(parseDeferredActivationEnvelope(JSON.stringify({ kind: 'deferred_activate_card', version: 1, child_card_id: 'code-a' }))).toBeNull();
  });

  it('parses legacy completion JSON into typed envelopes', () => {
    const completion = parseActivationCompletionEnvelope(JSON.stringify({ success: false, cardId: 'legacy-child', outcome: 'failed', summary: 'old', failure_kind: 'service_restart' }));
    expect(completion).toEqual(expect.objectContaining({ kind: 'activate_card_completion', version: 1, child_card_id: 'legacy-child', cardId: 'legacy-child', success: false, failure_kind: 'service_restart' }));
  });



  it('rejects completion envelopes and legacy completion JSON with unplanned outcomes', () => {
    expect(() => createActivationCompletionEnvelope({ child_card_id: 'code-a', outcome: 'unknown' as any, summary: 'bad outcome' })).toThrow();
    expect(parseActivationCompletionEnvelope(JSON.stringify({ success: true, cardId: 'legacy-child', outcome: 'unknown', summary: 'old' }))).toBeNull();
  });

  it('creates typed completion envelopes with compatibility aliases', () => {
    const envelope = createActivationCompletionEnvelope({ child_card_id: 'code-a', outcome: 'done', summary: 'complete', result: { ok: true }, failure_kind: undefined });
    expect(envelope).toEqual(expect.objectContaining({ kind: 'activate_card_completion', version: 1, child_card_id: 'code-a', cardId: 'code-a', success: true, outcome: 'done' }));
    expect(parseActivationEnvelopeContent(JSON.stringify(envelope)).completion?.child_card_id).toBe('code-a');
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
      max_goal_depth: 5,
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
      tags: [],
      priority: 0,
      position: 0,
      urgency: 'normal',
      created_by: 'analyst',
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
      version_seq: 1,
      depends_on: [],
      blocks: [],
      related: [],
      acceptance: '',
      artifacts: [],
      attachments: [],
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
      tags: [],
      priority: 0,
      position: 0,
      urgency: 'normal',
      created_by: 'analyst',
      created_at: '2025-01-01T00:00:00.000Z',
      updated_at: '2025-01-01T00:00:00.000Z',
      version_seq: 1,
      depends_on: [],
      blocks: [],
      related: [],
      acceptance: '',
      artifacts: [],
      attachments: [],
      retries: 0,
    };
    expect(cardRecordSchema.safeParse({ ...base, metadata: { max_review_retries: 4 } }).success).toBe(true);
    expect(cardRecordSchema.safeParse({ ...base, metadata: { max_review_retries: -1 } }).success).toBe(false);
  });

  it('accepts valid artifact and attachment refs', () => {
    expect(artifactRefSchema.safeParse({
      id: 'art-1',
      card_id: 'goal-1',
      path: '/tmp/a',
      type: 'report',
      description: 'desc',
      retain: true,
      created_at: '2025-01-01T00:00:00.000Z',
    }).success).toBe(true);

    expect(attachmentRefSchema.safeParse({
      id: 'att-1',
      card_id: 'goal-1',
      path: '/tmp/b',
      mime: 'text/plain',
      title: 'title',
      created_at: '2025-01-01T00:00:00.000Z',
    }).success).toBe(true);
  });

  it('accepts valid reviewer pass and needs_corrections results', () => {
    expect(reviewerResultSchema.safeParse({
      result: 'pass',
      summary: 'ok',
      achieved: ['implemented'],
      issues: [],
      evidence_card_ids: ['code-1'],
    }).success).toBe(true);

    expect(reviewerResultSchema.safeParse({
      result: 'needs_corrections',
      summary: 'fix required',
      achieved: [],
      issues: [{ summary: 'missing test', severity: 'blocker', evidence_card_id: 'test-1', recommendation: 'add coverage' }],
      evidence_card_ids: [],
    }).success).toBe(true);
  });

  it('rejects legacy reviewer result fail/missing payloads at the schema boundary', () => {
    expect(reviewerResultSchema.safeParse({
      result: 'fail',
      summary: 'old failure shape',
      achieved: [],
      issues: [],
      evidence_card_ids: [],
    }).success).toBe(false);

    expect(reviewerResultSchema.safeParse({
      result: 'needs_corrections',
      summary: 'old missing shape',
      achieved: [],
      missing: ['legacy missing entry'],
      evidence_card_ids: [],
    }).success).toBe(false);
  });

  it('accepts a valid review assessment with required preallocated metadata', () => {
    expect(reviewAssessmentSchema.safeParse({
      assessment_id: 'assessment-1',
      at: '2025-01-01T00:00:00.000Z',
      goal_card_id: 'goal-1',
      reviewer_session_id: 'reviewer:goal-1:assessment-1',
      result: 'pass',
      summary: 'ok',
      achieved: [],
      issues: [],
      evidence_card_ids: [],
    }).success).toBe(true);
  });

  it('rejects legacy review assessments without required metadata or with missing[]', () => {
    expect(reviewAssessmentSchema.safeParse({
      id: 'review-1',
      goal_card_id: 'goal-1',
      reviewer_session_id: 'reviewer-1',
      result: 'pass',
      summary: 'ok',
      achieved: [],
      issues: [],
      evidence_card_ids: [],
      created_at: '2025-01-01T00:00:00.000Z',
    }).success).toBe(false);

    expect(reviewAssessmentSchema.safeParse({
      assessment_id: 'assessment-2',
      at: '2025-01-01T00:00:00.000Z',
      result: 'needs_corrections',
      summary: 'legacy missing shape',
      achieved: [],
      issues: [],
      missing: ['legacy missing entry'],
      evidence_card_ids: [],
    }).success).toBe(false);
  });

  it('accepts a valid process record', () => {
    expect(processRecordSchema.safeParse({
      id: 'proc-1',
      card_id: 'goal-1',
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
      combined_log_path: '/tmp/out/combined.log',
    }).success).toBe(true);
  });


  it('accepts typed process reconciliation audit events and rejects raw command fields', () => {
    expect(processReconciledDeadEventSchema.safeParse({
      id: 'evt-1',
      kind: 'process_reconciled_dead',
      timestamp: '2025-01-01T00:00:00.000Z',
      process_id: 'proc-1',
      card_id: 'card-1',
      goal_id: 'goal-1',
      session_id: 'sess-1',
      pid: 123,
      probe_status: 'not_running',
      terminal_reason: 'lost',
      failure_classification: 'lost',
      detail: 'restart identity probe mismatch',
    }).success).toBe(true);
    expect(processReattachRejectedEventSchema.safeParse({
      id: 'evt-2',
      kind: 'process_reattach_rejected',
      timestamp: '2025-01-01T00:00:00.000Z',
      process_id: 'proc-2',
      card_id: 'card-2',
      terminal_reason: 'lost',
      failure_classification: 'lost',
      reattach_error: 'process reattach failed',
      detail: 'process reattach failed',
      command: 'echo sk-live-secret',
    }).success).toBe(false);
  });

  it('accepts a valid runtime state', () => {
    expect(runtimeStateSchema.safeParse({
      status: 'running',
      project_id: 'project',
      pid: 123,
      started_at: '2025-01-01T00:00:00.000Z',
      paused: false,
      updated_at: '2025-01-01T00:00:00.000Z',
      runtime_intent: { status: 'stopped', updated_at: '2025-01-01T00:00:00.000Z', source_command_id: null, reason: null },
      runtime_commands: [],
      runtime_runs: [],
      runtime_activations: [],
    }).success).toBe(true);
  });


  it('rejects legacy runtime state with discard guidance', () => {
    const root = mkdtempSync(join(tmpdir(), 'runtime-legacy-'));
    try {
      initProjectTree(root);
      writeFileSync(
        join(root, '.saivage', 'runtime', 'state.json'),
        JSON.stringify({ status: 'idle', queue: [] }, null, 2),
      );
      expect(readRuntimeState(root)).toBeNull();
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
      blocks: [],
      related: [],
      acceptance: '',
      artifacts: [],
      attachments: [],
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
  parseLoggedEventCompat,
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

  it('strictly validates formerly missing event kinds with their payloads', () => {
    expect(loggedEventSchema.parse({ id: 'evt-session-cancelled', kind: 'session_cancelled', timestamp, session_id: 'sess-1' })).toMatchObject({ kind: 'session_cancelled', session_id: 'sess-1' });
    expect(loggedEventSchema.parse({ id: 'evt-mcp', kind: 'mcp_tool_invocation', timestamp, session_id: 'sess-1', role: 'planner', server_name: 'planner-control', tool_name: 'activate_card', success: true })).toMatchObject({ kind: 'mcp_tool_invocation', tool_name: 'activate_card' });
  });

  it('keeps tolerant historical parsing separate from strict current validation', () => {
    const historical = { id: 'evt-old', kind: 'legacy_kind_from_old_log', timestamp, payload: { kept: true } };
    expect(loggedEventSchema.safeParse(historical).success).toBe(false);
    const compat = parseLoggedEventCompat(historical);
    expect(compat.ok).toBe(true);
    if (compat.ok) {
      expect(compat.compatibility).toBe('unknown-kind');
      expect(compat.event.kind).toBe('legacy_kind_from_old_log');
    }
  });
});
