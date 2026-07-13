import { initProjectTree, CardStore, cardByIdPath } from '../helpers/canonical-project.js';
import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';



import { CardStoreInvariantError } from '../../src/cards/errors.js';
import {
  cardRecordSchema,
  cardResultSchema,
  cardLifecycleStateSchema,
  validatePersistedCardLifecycle,
  type CardLifecycleState,
  type CardRecord,
  type FailedResult,
  type BlockedResult,
  type DoneResult,
  type ReworkResult,
} from '../../src/schemas/index.js';

const now = '2026-01-01T00:00:00.000Z';

const plannerDone: DoneResult = { kind: 'done', summary: 'done' };
const plannerBlocked: BlockedResult = { kind: 'blocked', summary: 'input needed', resume_reason: 'operator_input' };
const reviewerBlocked: ReworkResult = { kind: 'rework', summary: 'fix it' };
const executorFailure: FailedResult = { kind: 'failed', summary: 'boom' };

function card(overrides: Partial<CardRecord> = {}): CardRecord {
  const lifecycle = overrides.lifecycle ?? ({ status: overrides.status ?? 'backlog', result: null, error: null, completed_at: null } as CardLifecycleState);
  return {
    id: overrides.id ?? 'card-1',
    type: overrides.type ?? 'code',
    parent: overrides.parent ?? 'project',
    depth: overrides.depth ?? 1,
    position: overrides.position ?? 0,
    title: overrides.title ?? 'Lifecycle Card',
    status: overrides.status ?? 'backlog',
    subtype: overrides.subtype ?? null,
    tags: overrides.tags ?? [],
    priority: overrides.priority ?? 0,
    urgency: overrides.urgency ?? 'normal',
    created_by: overrides.created_by ?? 'analyst',
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
    version_seq: overrides.version_seq ?? 1,
    assigned_to: overrides.assigned_to ?? null,
    depends_on: overrides.depends_on ?? [],
    related: overrides.related ?? [],
    lifecycle,
    metrics: overrides.metrics ?? null,
    estimate: overrides.estimate ?? null,
    started_at: overrides.started_at ?? null,
    duration_ms: overrides.duration_ms ?? null,
    status_text: overrides.status_text ?? null,
    status_text_updated_at: overrides.status_text_updated_at ?? null,
    status_text_author_session_id: overrides.status_text_author_session_id ?? null,
    latest_self_report: overrides.latest_self_report ?? null,
    metadata: overrides.metadata ?? null,
    retries: overrides.retries ?? 0,
  };
}

describe('card lifecycle schemas', () => {
  it('accepts valid done, failed, and blocked shapes', () => {
    const done: CardLifecycleState = { status: 'done', result: plannerDone, error: null, completed_at: now };
    const failed: CardLifecycleState = { status: 'failed', result: executorFailure, error: 'boom', completed_at: now };
    const blocked: CardLifecycleState = { status: 'blocked', result: plannerBlocked, error: 'input needed', completed_at: null };
    const blockedByReviewer: CardLifecycleState = { status: 'blocked', result: reviewerBlocked, error: 'fix it', completed_at: null };

    for (const state of [done, failed, blocked, blockedByReviewer]) {
      expect(cardLifecycleStateSchema.safeParse(state).success).toBe(true);
    }
  });

  it('rejects removed verification lifecycle and result shapes', () => {
    const removedResult = { kind: 'executor_needs_verification', reason: 'check output', preserved_result: {}, fallback_reason: null, latest_self_report: { result: 'needs_verification', outcome: 'needs_verification', summary: 'check output', status_text: 'verify', at: now } };
    expect(cardResultSchema.safeParse(removedResult).success).toBe(false);
    expect(cardLifecycleStateSchema.safeParse({ status: 'needs_verification', result: removedResult, error: null, completed_at: null }).success).toBe(false);
  });

  it('rejects invalid terminal lifecycle shapes at the schema boundary', () => {
    expect(cardLifecycleStateSchema.safeParse({ status: 'done', result: plannerDone, error: 'stale', completed_at: now }).success).toBe(false);
    expect(cardLifecycleStateSchema.safeParse({ status: 'done', result: null, error: null, completed_at: now }).success).toBe(false);
    expect(cardLifecycleStateSchema.safeParse({ status: 'done', result: {}, error: null, completed_at: now }).success).toBe(false);
    expect(cardLifecycleStateSchema.safeParse({ status: 'failed', result: executorFailure, error: null, completed_at: now }).success).toBe(false);
    expect(cardLifecycleStateSchema.safeParse({ status: 'failed', result: executorFailure, completed_at: now }).success).toBe(false);
    expect(cardLifecycleStateSchema.safeParse({ status: 'blocked', result: plannerBlocked, error: null, completed_at: null }).success).toBe(false);
    expect(cardLifecycleStateSchema.safeParse({ status: 'done', result: plannerDone, error: null }).success).toBe(false);
  });

  it('validates persisted card lifecycle against derived status', () => {
    expect(validatePersistedCardLifecycle(card())).toEqual({ status: 'backlog', result: null, error: null, completed_at: null });
    expect(validatePersistedCardLifecycle(card({ status: 'running', lifecycle: { status: 'running', result: plannerDone, error: null, completed_at: null } }))).toEqual({ status: 'running', result: plannerDone, error: null, completed_at: null });
    expect(validatePersistedCardLifecycle(card({ status: 'done', lifecycle: { status: 'done', result: plannerDone, error: null, completed_at: now } }))).toEqual({ status: 'done', result: plannerDone, error: null, completed_at: now });
    expect(validatePersistedCardLifecycle(card({ status: 'failed', lifecycle: { status: 'failed', result: executorFailure, error: 'boom', completed_at: now } }))).toEqual({ status: 'failed', result: executorFailure, error: 'boom', completed_at: now });
  });

  it('does not accept arbitrary records as lifecycle results', () => {
    expect(cardResultSchema.safeParse({}).success).toBe(false);
    expect(cardResultSchema.safeParse({ planning: { status: 'blocked', blocked_reason: 'legacy flat planning result' } }).success).toBe(false);
    expect(cardRecordSchema.safeParse(card({ status: 'done', lifecycle: { status: 'done', result: {} as never, error: null, completed_at: now } })).success).toBe(false);
  });

  it('strictly rejects invalid persisted lifecycle records without repair', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-lifecycle-boundary-'));
    try {
      initProjectTree(root);
      const store = new CardStore(root);
      const { id: _id, created_at: _createdAt, updated_at: _updatedAt, version_seq: _versionSeq, position: _position, ...input } = card({ status: 'backlog' });
      store.create({ ...input, brief: 'card-1' });
      expect(() => validatePersistedCardLifecycle(card({ status: 'failed', lifecycle: { status: 'failed', result: executorFailure, error: null, completed_at: now } as never }))).toThrow();
      expect(() => validatePersistedCardLifecycle({ status: 'done', lifecycle: { status: 'done', result: plannerDone, error: null } })).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
