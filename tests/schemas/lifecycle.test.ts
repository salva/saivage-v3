import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { CardStore } from '../../src/cards/card-store.js';
import { CardStoreInvariantError } from '../../src/cards/state.js';
import {
  cardRecordSchema,
  cardResultSchema,
  cardLifecycleStateSchema,
  projectCardLifecycleState,
  validatePersistedCardLifecycle,
  type CardLifecycleState,
  type CardRecord,
  type ExecutorFailureResult,
  type ExecutorNeedsVerificationResult,
  type PlannerBlockedResult,
  type PlannerDoneResult,
} from '../../src/schemas/index.js';

const now = '2026-01-01T00:00:00.000Z';

const selfReport = { result: 'done', outcome: 'done', summary: 'ok', status_text: 'done', at: now };
const plannerDone: PlannerDoneResult = { kind: 'planner_done', created_cards: [], updated_cards: [], summary: 'done' };
const plannerBlocked: PlannerBlockedResult = { kind: 'planner_blocked', blocked_reason: 'input needed', resume_reason: 'operator_input', created_cards: [], updated_cards: [] };
const executorFailure: ExecutorFailureResult = { kind: 'executor_failure', error: 'boom', partial_result: null, latest_self_report: { ...selfReport, result: 'failed', outcome: 'failed', summary: 'boom', status_text: 'failed' } };
const executorNeedsVerification: ExecutorNeedsVerificationResult = { kind: 'executor_needs_verification', reason: 'check output', preserved_result: {}, fallback_reason: null, latest_self_report: { ...selfReport, result: 'needs_verification', outcome: 'needs_verification', summary: 'check output', status_text: 'verify' } };

function flatCard(overrides: Partial<CardRecord> = {}): CardRecord {
  return {
    id: overrides.id ?? 'card-1',
    type: overrides.type ?? 'code',
    parent: overrides.parent ?? 'project',
    depth: overrides.depth ?? 1,
    position: overrides.position ?? 0,
    title: overrides.title ?? 'Lifecycle Card',
    description: overrides.description ?? '',
    status: overrides.status ?? 'backlog',
    subtype: overrides.subtype ?? null,
    instructions_file: overrides.instructions_file ?? null,
    tags: overrides.tags ?? [],
    priority: overrides.priority ?? 0,
    urgency: overrides.urgency ?? 'normal',
    created_by: overrides.created_by ?? 'analyst',
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
    version_seq: overrides.version_seq ?? 1,
    assigned_to: overrides.assigned_to ?? null,
    depends_on: overrides.depends_on ?? [],
    blocks: overrides.blocks ?? [],
    related: overrides.related ?? [],
    acceptance: overrides.acceptance ?? '',
    result: overrides.result ?? null,
    metrics: overrides.metrics ?? null,
    artifacts: overrides.artifacts ?? [],
    attachments: overrides.attachments ?? [],
    estimate: overrides.estimate ?? null,
    started_at: overrides.started_at ?? null,
    completed_at: overrides.completed_at ?? null,
    duration_ms: overrides.duration_ms ?? null,
    error: overrides.error ?? null,
    status_text: overrides.status_text ?? null,
    status_text_updated_at: overrides.status_text_updated_at ?? null,
    status_text_author_session_id: overrides.status_text_author_session_id ?? null,
    latest_self_report: overrides.latest_self_report ?? null,
    metadata: overrides.metadata ?? null,
    retries: overrides.retries ?? 0,
  };
}

function writeCard(root: string, card: CardRecord): void {
  const dir = join(root, '.saivage', 'cards', 'by-id');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${card.id}.json`), JSON.stringify(card, null, 2) + '\n');
}

describe('card lifecycle schemas', () => {
  it('accepts valid done, failed, blocked, and needs_verification shapes', () => {
    const done: CardLifecycleState = { status: 'done', result: plannerDone, error: null, completed_at: now };
    const failed: CardLifecycleState = { status: 'failed', result: executorFailure, error: 'boom', completed_at: now };
    const blocked: CardLifecycleState = { status: 'blocked', result: plannerBlocked, error: 'input needed', completed_at: null };
    const needsVerification: CardLifecycleState = { status: 'needs_verification', result: executorNeedsVerification, error: null, completed_at: null };

    for (const state of [done, failed, blocked, needsVerification]) {
      expect(cardLifecycleStateSchema.safeParse(state).success).toBe(true);
    }
  });

  it('rejects invalid terminal lifecycle shapes at the schema boundary', () => {
    expect(cardLifecycleStateSchema.safeParse({ status: 'done', result: plannerDone, error: 'stale', completed_at: now }).success).toBe(false);
    expect(cardLifecycleStateSchema.safeParse({ status: 'done', result: null, error: null, completed_at: now }).success).toBe(false);
    expect(cardLifecycleStateSchema.safeParse({ status: 'done', result: {}, error: null, completed_at: now }).success).toBe(false);
    expect(cardLifecycleStateSchema.safeParse({ status: 'failed', result: executorFailure, error: null, completed_at: now }).success).toBe(false);
    expect(cardLifecycleStateSchema.safeParse({ status: 'failed', result: executorFailure, completed_at: now }).success).toBe(false);
    expect(cardLifecycleStateSchema.safeParse({ status: 'blocked', result: plannerBlocked, error: null, completed_at: null }).success).toBe(false);
    expect(cardLifecycleStateSchema.safeParse({ status: 'needs_verification', result: executorNeedsVerification, error: 'stale', completed_at: null }).success).toBe(false);
    expect(cardLifecycleStateSchema.safeParse({ status: 'done', result: plannerDone, error: null }).success).toBe(false);
  });

  it('projects current flat CardRecord fields into strict lifecycle states', () => {
    expect(projectCardLifecycleState(flatCard())).toEqual({ status: 'backlog', result: null, error: null, completed_at: null });
    expect(projectCardLifecycleState(flatCard({ status: 'running', result: plannerDone }))).toEqual({ status: 'running', result: plannerDone, error: null, completed_at: null });
    expect(projectCardLifecycleState(flatCard({ status: 'done', result: plannerDone, completed_at: now }))).toEqual({ status: 'done', result: plannerDone, error: null, completed_at: now });
    expect(projectCardLifecycleState(flatCard({ status: 'failed', result: executorFailure, error: 'boom', completed_at: now }))).toEqual({ status: 'failed', result: executorFailure, error: 'boom', completed_at: now });
  });

  it('does not accept arbitrary records as lifecycle results', () => {
    expect(cardResultSchema.safeParse({}).success).toBe(false);
    expect(cardResultSchema.safeParse({ planning: { status: 'blocked', blocked_reason: 'legacy flat planning result' } }).success).toBe(false);
    expect(cardRecordSchema.safeParse(flatCard({ status: 'done', result: {}, completed_at: now })).success).toBe(false);
  });

  it('strictly rejects invalid persisted flat cards without repair', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-lifecycle-boundary-'));
    try {
      initProjectTree(root);
      writeCard(root, flatCard({ id: 'card-1', status: 'done', error: 'stale', result: plannerDone, completed_at: now }));
      expect(() => new CardStore(root)).toThrow(CardStoreInvariantError);
      expect(() => validatePersistedCardLifecycle(flatCard({ status: 'failed', result: executorFailure, error: null, completed_at: now }))).toThrow();
      expect(() => validatePersistedCardLifecycle({ ...flatCard({ status: 'done', result: plannerDone }), completed_at: undefined })).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
