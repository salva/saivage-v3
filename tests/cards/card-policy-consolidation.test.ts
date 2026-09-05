import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertSetStatusAdmission, isSetStatusTransition } from '../../src/cards/lifecycle.js';
import { publishCardVersion } from '../../src/persistence/card-files.js';
import { cardArtifactSchema, cardVersionChangeSchema, validateCardTransition, type CardArtifact } from '../../src/persistence/canonical-card-artifacts.js';
import type { GrowingFileIo } from '../../src/persistence/growing-file.js';
import { CARD_RECORD_FIELDS, cardRecordSchema, type CardLifecycleState, type CardRecord, type CardStatus } from '../../src/schemas/index.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { runtimeFailure, workflowResult } from '../helpers/workflow-result.js';
import { readStrictCanonicalGrowingFile } from '../../src/persistence/growing-file.js';
import { cardStreamFile } from '../../src/persistence/layout.js';

const roots: string[] = [];
afterEach(() => {
  jest.useRealTimers();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'saivage-card-policy-'));
  roots.push(root);
  initProjectTree(root);
  return { root, cards: new CardService(root) };
}

function childInput(parent: string, title: string) {
  return { type: 'code' as const, parent, title, bootstrap_content: 'brief', tags: [] as string[], priority: 0, urgency: 'normal' as const, created_by: 'analyst' as const, depends_on: [] as string[], related: [] as string[] };
}

function lifecycle(status: CardStatus): CardLifecycleState {
  switch (status) {
    case 'done': return { status, result: workflowResult('DONE', 'done'), error: null, completed_at: '2026-09-02T00:00:00.000Z' };
    case 'failed': return { status, result: runtimeFailure('failed'), error: 'failed', completed_at: '2026-09-02T00:00:00.000Z' };
    case 'blocked': return { status, result: workflowResult('BLOCKED', 'blocked'), error: 'blocked', completed_at: null };
    case 'backlog': case 'running': case 'changed': case 'stopped': case 'cancelled':
      return { status, result: null, error: null, completed_at: null };
  }
}

function cardInStatus(template: CardRecord, status: CardStatus, version = 1): CardRecord {
  return cardRecordSchema.parse({ ...template, lifecycle: lifecycle(status), pending_notifications: [], version_seq: version });
}

function statusChange(cardId: string, version: number, target: CardStatus, reason = `status -> ${target}`) {
  return cardVersionChangeSchema.parse({
    entry_id: randomUUID(), kind: 'status', card_id: cardId, resulting_version: version,
    changed_at: '2026-09-03T00:00:00.000Z', changed_by_actor: 'runtime', changed_by_surface: 'runtime',
    changed_fields: ['lifecycle'], change_summary: 'lifecycle updated', change_reason: reason, terminal_summary: null,
  });
}

function transition(template: CardRecord, from: CardStatus, to: CardStatus, reason?: string): void {
  const prior = cardInStatus(template, from);
  const next = cardInStatus(prior, to, 2);
  validateCardTransition(prior, next, statusChange(prior.id, 2, to, reason), 'test-card-stream');
}

function rows(root: string, cardId: string): CardArtifact[] {
  return readStrictCanonicalGrowingFile(cardStreamFile(root, cardId), cardArtifactSchema);
}

describe('card field ordering policy', () => {
  it('exports the exact complete card-record order', () => {
    expect(CARD_RECORD_FIELDS).toEqual([
      'id', 'type', 'children', 'title', 'subtype', 'tags', 'priority', 'urgency', 'created_by', 'created_at',
      'updated_at', 'version_seq', 'assigned_to', 'depends_on', 'related', 'lifecycle', 'metrics', 'estimate',
      'started_at', 'duration_ms', 'status_text', 'status_text_updated_at', 'status_text_author_session_id',
      'latest_self_report', 'metadata', 'pending_notifications',
    ]);
  });

  it('retains terminal and cancellation changed-field order', () => {
    const { root, cards } = fixture();
    const terminal = cards.create(childInput('project', 'terminal'));
    cards.enqueueNotification(terminal.id, { id: 'terminal-note', content: 'note', created_at: '2026-09-02T00:00:00.000Z' });
    cards.setStatus(terminal.id, 'running');
    cards.commitActivationOutcome(terminal.id, { status: 'done', summary: 'done', result: workflowResult('DONE', 'done') }, '2026-09-03T00:00:00.000Z');
    expect(rows(root, terminal.id).at(-1)!.change?.changed_fields).toEqual(['lifecycle', 'status_text', 'status_text_updated_at', 'pending_notifications']);

    const cancelled = cards.create(childInput('project', 'cancelled'));
    cards.enqueueNotification(cancelled.id, { id: 'cancel-note', content: 'note', created_at: '2026-09-02T00:00:00.000Z' });
    cards.setStatus(cancelled.id, 'cancelled');
    expect(rows(root, cancelled.id).at(-1)!.change?.changed_fields).toEqual(['lifecycle', 'pending_notifications']);
  });

  it('retains synthetic deleted and lifecycle-special version-diff order', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-02T00:00:00.000Z'));
    const { cards } = fixture();
    const child = cards.create(childInput('project', 'before'));
    jest.setSystemTime(new Date('2026-09-02T01:00:00.000Z'));
    cards.editCard(child.id, { title: 'after' });
    cards.setStatus(child.id, 'running');
    cards.commitActivationOutcome(child.id, { status: 'done', summary: 'done', result: workflowResult('DONE', 'done') }, '2026-09-02T02:00:00.000Z');
    cards.deleteSubtrees([child.id], () => true);

    const result = cards.diffCardVersions(child.id, { fromVersion: 1, toVersion: 'current' });
    expect(result.kind).toBe('found');
    if (result.kind === 'found') expect(result.diff.map(({ field }) => field)).toEqual([
      'deleted', 'title', 'lifecycle', 'updated_at', 'version_seq', 'status_text', 'status_text_updated_at',
    ]);
  });
});

describe('generic set-status policy', () => {
  const admitted = [
    { from: 'backlog', to: 'running' }, { from: 'blocked', to: 'running' }, { from: 'changed', to: 'running' },
    { from: 'blocked', to: 'changed' }, { from: 'done', to: 'changed' }, { from: 'failed', to: 'changed' },
    { from: 'backlog', to: 'cancelled' }, { from: 'running', to: 'cancelled' }, { from: 'blocked', to: 'cancelled' },
    { from: 'changed', to: 'cancelled' }, { from: 'stopped', to: 'cancelled' }, { from: 'failed', to: 'cancelled' },
  ] as const satisfies readonly { from: CardStatus; to: CardStatus }[];

  it.each(admitted)('admits $from -> $to identically for live operation and replay', ({ from, to }) => {
    const { cards } = fixture();
    const template = cards.read('project')!;
    expect(isSetStatusTransition(from, to)).toBe(true);
    expect(() => assertSetStatusAdmission(cardInStatus(template, from), to)).not.toThrow();
    expect(() => transition(template, from, to)).not.toThrow();
  });

  it.each([
    { from: 'done', to: 'running', replayError: "Card stream 'test-card-stream' has an invalid status transition." },
    { from: 'running', to: 'changed', replayError: "Card stream 'test-card-stream' has an invalid status transition." },
    { from: 'done', to: 'cancelled', replayError: "Card stream 'test-card-stream' has an invalid status transition." },
    { from: 'stopped', to: 'running', replayError: "Card stream 'test-card-stream' has invalid reason or summary." },
  ] as const satisfies readonly { from: CardStatus; to: CardStatus; replayError: string }[])('rejects generic $from -> $to identically for live operation and generic replay', ({ from, to, replayError }) => {
    const { cards } = fixture();
    const template = cards.read('project')!;
    expect(isSetStatusTransition(from, to)).toBe(false);
    expect(() => assertSetStatusAdmission(cardInStatus(template, from), to)).toThrow(`Invalid status operation: ${from} → ${to}.`);
    expect(() => transition(template, from, to)).toThrow(replayError);
  });

  it('retains special recovery and STOPPED activation only under their exact replay reasons', () => {
    const { cards } = fixture();
    const template = cards.read('project')!;
    expect(isSetStatusTransition('running', 'stopped')).toBe(false);
    expect(isSetStatusTransition('stopped', 'running')).toBe(false);
    expect(() => transition(template, 'running', 'stopped', 'recovery stopped lifecycle')).not.toThrow();
    expect(() => transition(template, 'stopped', 'running', 'STOPPED activation')).not.toThrow();
    expect(() => transition(template, 'running', 'stopped')).toThrow("Card stream 'test-card-stream' has invalid reason or summary.");
    expect(() => transition(template, 'stopped', 'running')).toThrow("Card stream 'test-card-stream' has invalid reason or summary.");
  });
});

describe('reorder publication boundary', () => {
  function appendIo() {
    const calls = { open: jest.fn(), stat: jest.fn(), write: jest.fn(), fsync: jest.fn(), close: jest.fn() };
    return { calls, io: calls as unknown as GrowingFileIo };
  }

  function reorderChange(parent: CardRecord) {
    return cardVersionChangeSchema.parse({
      entry_id: randomUUID(), kind: 'reorder', card_id: parent.id, resulting_version: parent.version_seq + 1,
      changed_at: '2026-09-03T00:00:00.000Z', changed_by_actor: 'runtime', changed_by_surface: 'runtime',
      changed_fields: ['children'], change_summary: 'children reordered', change_reason: 'children reordered', terminal_summary: null,
    });
  }

  it('rejects a schema-valid membership-changing reorder before append I/O', () => {
    const { root, cards } = fixture();
    const first = cards.create(childInput('project', 'first'));
    cards.create(childInput('project', 'second'));
    const parent = cards.read('project')!;
    const candidate = cardRecordSchema.parse({ ...parent, children: [first.id, 'card-c'], version_seq: parent.version_seq + 1, updated_at: '2026-09-03T00:00:00.000Z' });
    const { calls, io } = appendIo();

    expect(() => publishCardVersion(root, candidate, reorderChange(parent), io)).toThrow('has an invalid child reorder');
    for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled();
  });

  it('rejects a schema-valid reorder piggyback before append I/O', () => {
    const { root, cards } = fixture();
    const first = cards.create(childInput('project', 'first'));
    const second = cards.create(childInput('project', 'second'));
    const parent = cards.read('project')!;
    const candidate = cardRecordSchema.parse({ ...parent, children: [second.id, first.id], title: 'piggyback', version_seq: parent.version_seq + 1, updated_at: '2026-09-03T00:00:00.000Z' });
    const { calls, io } = appendIo();

    expect(() => publishCardVersion(root, candidate, reorderChange(parent), io)).toThrow('has a reorder piggyback change');
    for (const call of Object.values(calls)) expect(call).not.toHaveBeenCalled();
  });
});
