import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { CardStore } from '../../src/cards/card-store.js';
import {
  cardLifecycleStateSchema,
  projectCardLifecycleState,
  validatePersistedCardLifecycle,
  type CardLifecycleState,
  type CardRecord,
} from '../../src/schemas/index.js';

const now = '2026-01-01T00:00:00.000Z';

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
    const done: CardLifecycleState = { status: 'done', result: { kind: 'planner_done', created_cards: [], updated_cards: [], summary: 'done' }, error: null, completed_at: now };
    const failed: CardLifecycleState = { status: 'failed', result: { kind: 'executor_failure', error: 'boom', partial_result: null, latest_self_report: { result: 'failed', outcome: 'failed', summary: 'boom', status_text: 'failed', at: now } }, error: 'boom', completed_at: now };
    const blocked: CardLifecycleState = { status: 'blocked', result: { kind: 'planner_blocked', blocked_reason: 'input needed', resume_reason: 'operator_input', created_cards: [], updated_cards: [] }, error: 'input needed', completed_at: null };
    const needsVerification: CardLifecycleState = { status: 'needs_verification', result: { kind: 'executor_needs_verification', reason: 'check output', preserved_result: {}, fallback_reason: null, latest_self_report: { result: 'needs_verification', outcome: 'needs_verification', summary: 'check output', status_text: 'verify', at: now } }, error: null, completed_at: null };

    for (const state of [done, failed, blocked, needsVerification]) {
      expect(cardLifecycleStateSchema.safeParse(state).success).toBe(true);
    }
  });

  it('rejects done plus error and failed without error at the schema boundary', () => {
    expect(cardLifecycleStateSchema.safeParse({ status: 'done', result: {}, error: 'stale', completed_at: now }).success).toBe(false);
    expect(cardLifecycleStateSchema.safeParse({ status: 'failed', result: {}, error: null, completed_at: now }).success).toBe(false);
    expect(cardLifecycleStateSchema.safeParse({ status: 'failed', result: {}, completed_at: now }).success).toBe(false);
  });

  it('projects current flat CardRecord shapes into normalized lifecycle states', () => {
    expect(projectCardLifecycleState(flatCard())).toEqual({ status: 'backlog', result: null, error: null, completed_at: null });
    expect(projectCardLifecycleState(flatCard({ status: 'running', result: { generated_files: ['a.ts'] }, error: 'transient' }))).toEqual({ status: 'running', result: { generated_files: ['a.ts'] }, error: 'transient', completed_at: null });
    expect(projectCardLifecycleState(flatCard({ status: 'done', result: { generated_files: ['a.ts'] } }))).toEqual({ status: 'done', result: { generated_files: ['a.ts'] }, error: null, completed_at: now });
    expect(projectCardLifecycleState(flatCard({ status: 'failed', result: { partial: true }, error: 'boom' }))).toEqual({ status: 'failed', result: { partial: true }, error: 'boom', completed_at: now });
  });

  it('normalizes legacy persisted flat cards when card store loads JSON', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-lifecycle-boundary-'));
    try {
      initProjectTree(root);
      writeCard(root, flatCard({ id: 'card-1', status: 'done', error: 'stale', result: {} }));
      const store = new CardStore(root);
      expect(store.read('card-1')).toEqual(expect.objectContaining({ status: 'done', error: null, result: {}, completed_at: now }));
      expect(() => validatePersistedCardLifecycle(flatCard({ status: 'failed', error: null }))).toThrow("status 'failed' requires");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps practical type/schema parity for constructed lifecycle values', () => {
    const state = {
      status: 'blocked',
      result: { planning: { status: 'blocked', blocked_reason: 'legacy flat planning result' } },
      error: 'legacy flat planning result',
      completed_at: null,
    } satisfies CardLifecycleState;

    expect(cardLifecycleStateSchema.parse(state)).toEqual(state);
  });
});
