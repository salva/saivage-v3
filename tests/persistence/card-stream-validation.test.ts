import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService } from '../helpers/canonical-project.js';
import { cardStreamRowSchema, validateCardStream, type CardStreamRow } from '../../src/persistence/canonical-card-artifacts.js';
import { readCardArtifacts } from '../../src/persistence/card-files.js';
import { parseGrowingFile } from '../../src/persistence/growing-file.js';
import { cardStreamFile } from '../../src/persistence/layout.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import type { CardActivationOutcome } from '../../src/contracts/tool-api.js';
import { runtimeFailure, workflowResult } from '../helpers/workflow-result.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function input(type: 'goal' | 'code' = 'code') {
  return { type, parent: 'project', title: 'Stream contract', bootstrap_content: 'Validate the card stream.', tags: [], priority: 0, urgency: 'normal' as const, created_by: 'analyst' as const, depends_on: [], related: [] };
}

function updatedRows(initialType: 'goal' | 'code'): { id: string; rows: CardStreamRow[] } {
  const root = mkdtempSync(join(tmpdir(), 'saivage-card-stream-validation-'));
  roots.push(root);
  initProjectTree(root);
  const cards = new CardService(root);
  const card = cards.create(input(initialType));
  cards.editCard(card.id, { title: 'Still the same type' });
  return { id: card.id, rows: structuredClone(readCardArtifacts(root, card.id).artifacts) };
}

const settledAt = '2026-07-22T00:00:00.000Z';
type TerminalOutcome = Exclude<CardActivationOutcome, { status: 'cancelled' }>;
const terminalOutcomes = [
  (summary: string): TerminalOutcome => ({ status: 'done', summary, result: workflowResult('DONE', summary) }),
  (summary: string): TerminalOutcome => ({ status: 'failed', summary, result: runtimeFailure(summary) }),
  (summary: string): TerminalOutcome => ({ status: 'blocked', summary, result: workflowResult('BLOCKED', summary) }),
] as const;

function serviceFixture() {
  const root = mkdtempSync(join(tmpdir(), 'saivage-card-stream-validation-'));
  roots.push(root); initProjectTree(root);
  return { root, cards: new CardService(root) };
}

function createInStatus(cards: CardService, status: 'backlog' | 'running' | 'changed' | 'stopped' | 'done' | 'failed' | 'blocked', title: string) {
  const card = cards.create({ ...input(), title });
  if (status === 'backlog') return card;
  cards.setStatus(card.id, 'running');
  if (status === 'running') return cards.read(card.id)!;
  if (status === 'stopped') return cards.stopRunningForRecovery(card.id);
  const outcome = status === 'done' || status === 'changed' ? terminalOutcomes[0](title) : status === 'failed' ? terminalOutcomes[1](title) : terminalOutcomes[2](title);
  cards.commitActivationOutcome(card.id, outcome, settledAt);
  return status === 'changed' ? cards.setStatus(card.id, 'changed') : cards.read(card.id)!;
}

describe('two-kind card stream validation', () => {
  it('accepts real stopped-transition rows with their exact v2 lifecycle-only reasons', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-stream-validation-'));
    roots.push(root);
    initProjectTree(root);
    const cards = new CardService(root);
    const card = cards.create(input());
    cards.setStatus(card.id, 'running');
    cards.stopRunningForRecovery(card.id);
    cards.activateStopped(card.id);

    const rows = readCardArtifacts(root, card.id).artifacts;
    expect(validateCardStream(rows, cardStreamFile(root, card.id), card.id).current.card.lifecycle.status).toBe('running');
    expect(rows.filter((row) => row.kind === 'card-version').map((row) => row.history?.change_reason)).toEqual([
      undefined,
      'status -> running',
      'recovery stopped lifecycle',
      'STOPPED activation',
    ]);
    for (const index of [2, 3]) {
      const wrongReason = structuredClone(rows); const reasonRow = wrongReason[index]!;
      if (reasonRow.kind !== 'card-version' || !reasonRow.history) throw new Error('Expected stopped-transition row.');
      reasonRow.history.change_reason = 'status -> running';
      expect(() => validateCardStream(wrongReason, '/canonical/card.jsonl', card.id)).toThrow(/invalid reason or summary/);

      const wrongFields = structuredClone(rows); const fieldsRow = wrongFields[index]!;
      if (fieldsRow.kind !== 'card-version' || !fieldsRow.history) throw new Error('Expected stopped-transition row.');
      fieldsRow.history.changed_fields = ['lifecycle', 'pending_notifications'];
      expect(() => validateCardStream(wrongFields, '/canonical/card.jsonl', card.id)).toThrow(/wrong changed fields/);

      const relabelled = structuredClone(rows); const relabelledRow = relabelled[index]!;
      if (relabelledRow.kind !== 'card-version' || !relabelledRow.history) throw new Error('Expected stopped-transition row.');
      relabelledRow.history.kind = 'terminal';
      expect(() => validateCardStream(relabelled, '/canonical/card.jsonl', card.id)).toThrow();
    }
  });

  it('accepts every exact status subtype and rejects relabelling, wrong deltas, summaries, and notification consequences', () => {
    const admitted = {
      running: ['backlog', 'blocked', 'changed'],
      changed: ['blocked', 'done', 'failed'],
      cancelled: ['backlog', 'running', 'blocked', 'changed', 'stopped', 'failed'],
    } as const;
    for (const [target, sources] of Object.entries(admitted)) for (const source of sources) {
      const { root, cards } = serviceFixture();
      const card = createInStatus(cards, source, `${source}-${target}`);
      if (target === 'cancelled' && source === 'backlog') cards.enqueueNotification(card.id, { id: 'cancel', content: 'clear', created_at: settledAt });
      cards.setStatus(card.id, target as 'running' | 'changed' | 'cancelled');
      const rows = structuredClone(readCardArtifacts(root, card.id).artifacts);
      expect(() => validateCardStream(rows, cardStreamFile(root, card.id), card.id)).not.toThrow();

      const wrongFields = structuredClone(rows); const fieldsRow = wrongFields.at(-1)!;
      if (fieldsRow.kind !== 'card-version' || !fieldsRow.history) throw new Error('Expected status row.');
      fieldsRow.history.changed_fields = [...fieldsRow.history.changed_fields, 'title'];
      expect(() => validateCardStream(wrongFields, '/canonical/card.jsonl', card.id)).toThrow(/wrong changed fields/);

      const wrongSummary = structuredClone(rows); const summaryRow = wrongSummary.at(-1)!;
      if (summaryRow.kind !== 'card-version' || !summaryRow.history) throw new Error('Expected status row.');
      summaryRow.history.change_summary = 'wrong summary';
      expect(() => validateCardStream(wrongSummary, '/canonical/card.jsonl', card.id)).toThrow(/invalid reason or summary/);

      const relabelled = structuredClone(rows); const relabelledRow = relabelled.at(-1)!;
      if (relabelledRow.kind !== 'card-version' || !relabelledRow.history) throw new Error('Expected status row.');
      relabelledRow.history.kind = 'terminal';
      expect(() => validateCardStream(relabelled, '/canonical/card.jsonl', card.id)).toThrow();
    }

    const { root, cards } = serviceFixture();
    const running = createInStatus(cards, 'running', 'running changed relabel');
    cards.setStatus(running.id, 'cancelled');
    const runningChanged = structuredClone(readCardArtifacts(root, running.id).artifacts);
    const runningChangedRow = runningChanged.at(-1)!;
    if (runningChangedRow.kind !== 'card-version' || !runningChangedRow.history) throw new Error('Expected status row.');
    runningChangedRow.card.lifecycle = { status: 'changed', result: null, error: null, completed_at: null };
    runningChangedRow.history.change_reason = 'status -> changed';
    expect(() => validateCardStream(runningChanged, '/canonical/card.jsonl', running.id)).toThrow(/invalid status transition/);

    const blockedFixture = serviceFixture(); const blockedCard = createInStatus(blockedFixture.cards, 'running', 'running blocked relabel');
    blockedFixture.cards.commitActivationOutcome(blockedCard.id, terminalOutcomes[2]('blocked'), settledAt);
    const runningBlocked = structuredClone(readCardArtifacts(blockedFixture.root, blockedCard.id).artifacts);
    const blockedRow = runningBlocked.at(-1)!;
    if (blockedRow.kind !== 'card-version' || !blockedRow.history) throw new Error('Expected terminal row.');
    blockedRow.history.kind = 'status'; blockedRow.history.change_reason = 'status -> blocked';
    expect(() => validateCardStream(runningBlocked, '/canonical/card.jsonl', blockedCard.id)).toThrow(/invalid status transition/);

    const preserveFixture = serviceFixture(); const preserve = createInStatus(preserveFixture.cards, 'backlog', 'preserve notifications');
    preserveFixture.cards.enqueueNotification(preserve.id, { id: 'keep', content: 'keep', created_at: settledAt });
    preserveFixture.cards.setStatus(preserve.id, 'running');
    const dropped = structuredClone(readCardArtifacts(preserveFixture.root, preserve.id).artifacts);
    const droppedRow = dropped.at(-1)!;
    if (droppedRow.kind !== 'card-version') throw new Error('Expected status row.');
    droppedRow.card.pending_notifications = [];
    expect(() => validateCardStream(dropped, '/canonical/card.jsonl', preserve.id)).toThrow(/changed notifications/);

    const cancelFixture = serviceFixture(); const cancel = createInStatus(cancelFixture.cards, 'backlog', 'cancel notifications');
    cancelFixture.cards.enqueueNotification(cancel.id, { id: 'clear', content: 'clear', created_at: settledAt });
    cancelFixture.cards.setStatus(cancel.id, 'cancelled');
    const retained = structuredClone(readCardArtifacts(cancelFixture.root, cancel.id).artifacts); const retainedRow = retained.at(-1)!;
    if (retainedRow.kind !== 'card-version' || !retainedRow.history) throw new Error('Expected cancellation row.');
    retainedRow.card.pending_notifications = structuredClone(retainedRow.history.snapshot.pending_notifications);
    expect(() => validateCardStream(retained, '/canonical/card.jsonl', cancel.id)).toThrow(/retained notifications/);
    const reorderedFields = structuredClone(readCardArtifacts(cancelFixture.root, cancel.id).artifacts); const reorderedRow = reorderedFields.at(-1)!;
    if (reorderedRow.kind !== 'card-version' || !reorderedRow.history) throw new Error('Expected cancellation row.');
    reorderedRow.history.changed_fields.reverse();
    expect(() => validateCardStream(reorderedFields, '/canonical/card.jsonl', cancel.id)).toThrow(/wrong changed fields/);
  });

  it('rejects v1 and removed fields from current and embedded history snapshots', () => {
    const { rows } = updatedRows('code');
    expect(cardStreamRowSchema.safeParse({ ...rows[0], format_version: 1 }).success).toBe(false);
    const initial = rows[0];
    if (initial?.kind !== 'card-version') throw new Error('expected card version');
    const updated = rows[1];
    if (updated?.kind !== 'card-version' || !updated.history) throw new Error('expected updated card version');
    for (const field of ['status', 'parent', 'depth', 'allowedActions']) {
      expect(cardStreamRowSchema.safeParse({ ...initial, card: { ...initial.card, [field]: null } }).success).toBe(false);
      expect(cardStreamRowSchema.safeParse({ ...updated, history: { ...updated.history, snapshot: { ...updated.history.snapshot, [field]: null } } }).success).toBe(false);
    }
  });

  it.each(['intent', 'write_intent', 'reset'])('keeps the strict v2 row schema free of %s', (field) => {
    const { rows } = updatedRows('code');
    const invalid = { ...structuredClone(rows[1]!), [field]: 'forbidden' };
    expect(() => cardStreamRowSchema.parse(invalid)).toThrow();
  });

  it('replays ordinary running terminal outcomes without a persisted write intent', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-stream-validation-'));
    roots.push(root);
    initProjectTree(root);
    const cards = new CardService(root);
    const done = cards.create(input());
    const failed = cards.create(input());
    const blocked = cards.create(input());
    for (const card of [done, failed, blocked]) cards.setStatus(card.id, 'running');
    cards.commitActivationOutcome(done.id, { status: 'done', summary: 'done', result: workflowResult('DONE', 'done') }, '2026-07-19T00:00:00.000Z');
    cards.commitActivationOutcome(failed.id, { status: 'failed', summary: 'failed', result: runtimeFailure('failed') }, '2026-07-19T00:00:00.000Z');
    cards.commitActivationOutcome(blocked.id, { status: 'blocked', summary: 'blocked', result: workflowResult('BLOCKED', 'blocked') }, '2026-07-19T00:00:00.000Z');

    for (const card of [done, failed, blocked]) {
      const rows = readCardArtifacts(root, card.id).artifacts;
      expect(validateCardStream(rows, cardStreamFile(root, card.id), card.id).current.card.lifecycle.status).toBe(cards.read(card.id)?.lifecycle.status);
      expect(JSON.stringify(rows)).not.toMatch(/write_intent|"intent"|"reset"/);
    }
  });

  it('accepts every terminal S/T/N delta matrix for every outcome and rejects wrong fields, summaries, metadata, and reason', () => {
    for (const outcomeFactory of terminalOutcomes) for (const sameSummary of [false, true]) for (const sameTime of [false, true]) for (const notifications of [false, true]) {
      const { root, cards } = serviceFixture(); const card = createInStatus(cards, 'running', `terminal-${sameSummary}-${sameTime}-${notifications}`);
      cards.commitActivationOutcome(card.id, terminalOutcomes[0]('prior'), sameTime ? settledAt : '2026-07-21T00:00:00.000Z');
      cards.setStatus(card.id, 'changed'); cards.setStatus(card.id, 'running');
      if (notifications) cards.enqueueNotification(card.id, { id: 'n', content: 'clear', created_at: settledAt });
      cards.commitActivationOutcome(card.id, outcomeFactory(sameSummary ? 'prior' : 'next'), settledAt);
      const rows = structuredClone(readCardArtifacts(root, card.id).artifacts);
      expect(() => validateCardStream(rows, cardStreamFile(root, card.id), card.id)).not.toThrow();
      const terminal = rows.at(-1)!;
      if (terminal.kind !== 'card-version' || !terminal.history) throw new Error('Expected terminal row.');

      const wrongFields = structuredClone(rows); const wrongFieldsRow = wrongFields.at(-1)!;
      if (wrongFieldsRow.kind !== 'card-version' || !wrongFieldsRow.history) throw new Error('Expected terminal row.');
      wrongFieldsRow.history.changed_fields = [...wrongFieldsRow.history.changed_fields].reverse();
      if (wrongFieldsRow.history.changed_fields.length === 1) wrongFieldsRow.history.changed_fields.push('status_text');
      expect(() => validateCardStream(wrongFields, '/canonical/card.jsonl', card.id)).toThrow(/wrong changed fields/);

      if (!notifications) {
        const falseNotificationDelta = structuredClone(rows); const falseNotificationRow = falseNotificationDelta.at(-1)!;
        if (falseNotificationRow.kind !== 'card-version' || !falseNotificationRow.history) throw new Error('Expected terminal row.');
        falseNotificationRow.history.changed_fields.push('pending_notifications');
        falseNotificationRow.history.change_summary = `${falseNotificationRow.history.changed_fields.join(', ')} updated`;
        expect(() => validateCardStream(falseNotificationDelta, '/canonical/card.jsonl', card.id)).toThrow(/wrong changed fields/);
      }

      const wrongSummary = structuredClone(rows); const wrongSummaryRow = wrongSummary.at(-1)!;
      if (wrongSummaryRow.kind !== 'card-version' || !wrongSummaryRow.history) throw new Error('Expected terminal row.');
      wrongSummaryRow.history.change_summary = 'wrong';
      expect(() => validateCardStream(wrongSummary, '/canonical/card.jsonl', card.id)).toThrow(/invalid reason or summary/);

      const wrongReason = structuredClone(rows); const wrongReasonRow = wrongReason.at(-1)!;
      if (wrongReasonRow.kind !== 'card-version' || !wrongReasonRow.history) throw new Error('Expected terminal row.');
      wrongReasonRow.history.change_reason = 'status -> done';
      expect(() => validateCardStream(wrongReason, '/canonical/card.jsonl', card.id)).toThrow(/invalid reason or summary/);

      const wrongMetadata = structuredClone(rows); const wrongMetadataRow = wrongMetadata.at(-1)!;
      if (wrongMetadataRow.kind !== 'card-version' || !wrongMetadataRow.history) throw new Error('Expected terminal row.');
      const rawHistory = wrongMetadataRow.history as unknown as { changed_by_actor: string; changed_by_surface: string };
      rawHistory.changed_by_actor = 'analyst'; rawHistory.changed_by_surface = 'web-chat';
      expect(cardStreamRowSchema.safeParse(wrongMetadataRow).success).toBe(false);
    }
  });

  it('rejects every independently varied terminal relationship and retained notifications', () => {
    for (const outcomeFactory of terminalOutcomes) {
      const { root, cards } = serviceFixture(); const card = createInStatus(cards, 'running', `relationships-${outcomeFactory('x').status}`);
      cards.commitActivationOutcome(card.id, outcomeFactory('summary'), settledAt);
      const rows = structuredClone(readCardArtifacts(root, card.id).artifacts);
      const mutations: Array<readonly [string, (row: Extract<CardStreamRow, { kind: 'card-version' }>) => void]> = [
        ['result summary', (row) => { if (row.card.lifecycle.status === 'done' || row.card.lifecycle.status === 'failed' || row.card.lifecycle.status === 'blocked') row.card.lifecycle.result.summary = 'different'; }],
        ['result terminal identity', (row) => {
          if (row.card.lifecycle.status === 'done' || row.card.lifecycle.status === 'blocked') row.card.lifecycle.result.terminal = 'FAILED';
          else if (row.card.lifecycle.status === 'failed') Object.assign(row.card.lifecycle.result, { kind: 'workflow-result', terminal: 'DONE' });
        }],
        ['status text', (row) => { row.card.status_text = 'different'; }],
      ];
      if (outcomeFactory('x').status !== 'blocked') mutations.push(['status timestamp', (row) => { row.card.status_text_updated_at = '2026-07-20T00:00:00.000Z'; }]);
      if (outcomeFactory('x').status !== 'done') mutations.push(['lifecycle error', (row) => { if (row.card.lifecycle.status === 'failed' || row.card.lifecycle.status === 'blocked') row.card.lifecycle.error = 'different'; }]);
      if (outcomeFactory('x').status !== 'blocked') mutations.push(['completion timestamp', (row) => { if (row.card.lifecycle.status === 'done' || row.card.lifecycle.status === 'failed') row.card.lifecycle.completed_at = '2026-07-20T00:00:00.000Z'; }]);
      for (const [name, mutate] of mutations) {
        const invalid = structuredClone(rows); const row = invalid.at(-1)!;
        if (row.kind !== 'card-version') throw new Error('Expected terminal row.');
        mutate(row);
        let rejected = false;
        try { validateCardStream(invalid, '/canonical/card.jsonl', card.id); } catch { rejected = true; }
        if (!rejected) throw new Error(`${outcomeFactory('x').status} ${name} mutation was accepted.`);
      }
      for (const key of ['status_text', 'status_text_updated_at'] as const) {
        const absent = structuredClone(rows); const row = absent.at(-1)!;
        if (row.kind !== 'card-version') throw new Error('Expected terminal row.');
        delete (row.card as unknown as Record<string, unknown>)[key];
        expect(cardStreamRowSchema.safeParse(row).success).toBe(false);
      }
      const retained = structuredClone(rows); const retainedRow = retained.at(-1)!;
      if (retainedRow.kind !== 'card-version') throw new Error('Expected terminal row.');
      retainedRow.card.pending_notifications = [{ id: 'retained', content: 'invalid', created_at: settledAt }];
      expect(() => validateCardStream(retained, '/canonical/card.jsonl', card.id)).toThrow(/retained notifications|piggyback/);
    }
  });

  it('rejects absent or non-null fixed initial fields for both root and child families', () => {
    const { root, cards } = serviceFixture(); const child = cards.create(input());
    const nullOnly = ['subtype', 'assigned_to', 'metrics', 'estimate', 'started_at', 'duration_ms', 'status_text_author_session_id', 'latest_self_report', 'metadata'] as const;
    const requiredNullable = [...nullOnly, 'status_text', 'status_text_updated_at'] as const;
    for (const id of ['project', child.id]) {
      const initial = structuredClone(readCardArtifacts(root, id).artifacts[0]!);
      if (initial.kind !== 'card-version') throw new Error('Expected initial row.');
      for (const key of requiredNullable) {
        const absent = structuredClone(initial); delete (absent.card as unknown as Record<string, unknown>)[key];
        expect(cardStreamRowSchema.safeParse(absent).success).toBe(false);
      }
      for (const key of nullOnly) {
        const valued = structuredClone(initial); (valued.card as unknown as Record<string, unknown>)[key] = 'not-null';
        expect(cardStreamRowSchema.safeParse(valued).success).toBe(false);
      }
      for (const key of ['status_text', 'status_text_updated_at'] as const) {
        const valued = structuredClone(initial); (valued.card as unknown as Record<string, unknown>)[key] = key === 'status_text' ? 'premature' : settledAt;
        expect(cardStreamRowSchema.safeParse(valued).success).toBe(true);
        expect(() => validateCardStream([valued], '/canonical/card.jsonl', id)).toThrow(/invalid initial card/);
      }
    }
  });

  it('accepts only contiguous card versions before an optional terminal tombstone', () => {
    const { id, rows } = updatedRows('code');
    expect(rows.map((row) => row.kind)).toEqual(['card-version', 'card-version']);
    expect(validateCardStream(rows, '/canonical/card.jsonl', id).current.version).toBe(2);

    const noncontiguous = structuredClone(rows);
    const later = noncontiguous[1]!;
    if (later.kind !== 'card-version') throw new Error('Expected a card version.');
    later.version = 3;
    later.card.version_seq = 3;
    expect(() => validateCardStream(noncontiguous, '/canonical/card.jsonl', id)).toThrow(/inconsistent version identity/);
  });

  it.each<{ initialType: 'goal' | 'code'; changedType: 'goal' | 'code' }>([
    { initialType: 'goal', changedType: 'code' },
    { initialType: 'code', changedType: 'goal' },
  ])('rejects a later $initialType to $changedType type transition', ({ initialType, changedType }) => {
    const { id, rows } = updatedRows(initialType);
    const later = rows[1]!;
    if (later.kind !== 'card-version') throw new Error('Expected a card version.');
    later.card.type = changedType;
    expect(() => validateCardStream(rows, '/canonical/card.jsonl', id)).toThrow("mutates immutable field 'type'");
  });

  it('allows a child link to mutate only children, version, and update time', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-stream-validation-'));
    roots.push(root);
    initProjectTree(root);
    new CardService(root).create(input());
    const rows = structuredClone(readCardArtifacts(root, 'project').artifacts);
    expect(rows.map((row) => row.kind)).toEqual(['card-version', 'card-version']);
    const link = rows[1]!;
    if (link.kind !== 'card-version') throw new Error('Expected a child-link card version.');
    expect(link.history?.kind).toBe('child_link');
    expect(validateCardStream(rows, '/canonical/card.jsonl', 'project').current.version).toBe(2);
    const replaced = structuredClone(rows);
    const replacedLink = replaced[1]!;
    if (replacedLink.kind !== 'card-version') throw new Error('Expected a child-link card version.');
    replacedLink.card.children = [replacedLink.card.children[0]!, 'card-z'];
    expect(() => validateCardStream(replaced, '/canonical/card.jsonl', 'project')).toThrow(/invalid child link/);

    link.card.title = 'Forbidden during child link';
    expect(() => validateCardStream(rows, '/canonical/card.jsonl', 'project')).toThrow(/piggyback/);

    const wrongMetadata = structuredClone(readCardArtifacts(root, 'project').artifacts);
    const metadataLink = wrongMetadata[1]!;
    if (metadataLink.kind !== 'card-version' || !metadataLink.history) throw new Error('Expected a child-link card version.');
    const rawHistory = metadataLink.history as unknown as { changed_by_actor: string; changed_by_surface: string };
    rawHistory.changed_by_actor = 'planner'; rawHistory.changed_by_surface = 'runtime';
    expect(cardStreamRowSchema.safeParse(metadataLink).success).toBe(false);
  });

  it('rejects update relabelling from a disallowed source and update piggyback changes', () => {
    const { root, cards } = serviceFixture(); const card = createInStatus(cards, 'running', 'disallowed update');
    cards.commitActivationOutcome(card.id, terminalOutcomes[0]('done'), settledAt);
    const disallowed = structuredClone(readCardArtifacts(root, card.id).artifacts);
    const terminal = disallowed.at(-1)!;
    if (terminal.kind !== 'card-version' || !terminal.history) throw new Error('Expected terminal row.');
    terminal.history.kind = 'update';
    const provenance = terminal.history as unknown as { changed_by_actor: string; changed_by_surface: string; change_reason: string };
    provenance.changed_by_actor = 'planner'; provenance.changed_by_surface = 'runtime'; provenance.change_reason = 'agent edit_card';
    expect(() => validateCardStream(disallowed, '/canonical/card.jsonl', card.id)).toThrow(/disallowed lifecycle state/);

    const accepted = updatedRows('code'); const piggyback = structuredClone(accepted.rows);
    const update = piggyback.at(-1)!;
    if (update.kind !== 'card-version') throw new Error('Expected update row.');
    update.card.related = ['project'];
    expect(() => validateCardStream(piggyback, '/canonical/card.jsonl', accepted.id)).toThrow(/wrong changed fields|invalid update delta/);
  });

  it('rejects broad notification replacement and non-subsequence removal', () => {
    const { root, cards } = serviceFixture(); const card = cards.create(input());
    cards.enqueueNotification(card.id, { id: 'first', content: 'first', created_at: settledAt });
    cards.enqueueNotification(card.id, { id: 'second', content: 'second', created_at: settledAt });
    const enqueueRows = structuredClone(readCardArtifacts(root, card.id).artifacts);
    const enqueue = enqueueRows.at(-1)!;
    if (enqueue.kind !== 'card-version') throw new Error('Expected notification enqueue row.');
    enqueue.card.pending_notifications = [
      { id: 'replacement-prior', content: 'replacement', created_at: settledAt },
      { id: 'replacement-next', content: 'replacement', created_at: settledAt },
    ];
    expect(() => validateCardStream(enqueueRows, '/canonical/card.jsonl', card.id)).toThrow(/invalid notification enqueue/);

    cards.enqueueNotification(card.id, { id: 'third', content: 'third', created_at: settledAt });
    cards.removeNotifications(card.id, ['second']);
    const removeRows = structuredClone(readCardArtifacts(root, card.id).artifacts);
    const remove = removeRows.at(-1)!;
    if (remove.kind !== 'card-version') throw new Error('Expected notification removal row.');
    remove.card.pending_notifications = [
      { id: 'third', content: 'third', created_at: settledAt },
      { id: 'first', content: 'first', created_at: settledAt },
    ];
    expect(() => validateCardStream(removeRows, '/canonical/card.jsonl', card.id)).toThrow(/invalid notification removal/);
  });

  it.each(['mutate', 'depends', 'archive', 'unknown'])('rejects removed or unknown history kind %s at the row schema', (kind) => {
    const { rows } = updatedRows('code'); const invalid = structuredClone(rows[1]!);
    if (invalid.kind !== 'card-version' || !invalid.history) throw new Error('Expected update row.');
    (invalid.history as unknown as { kind: string }).kind = kind;
    expect(cardStreamRowSchema.safeParse(invalid).success).toBe(false);
  });

  it('accepts only a real children-only same-membership permutation, including retained-link movement', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-stream-validation-'));
    roots.push(root);
    initProjectTree(root);
    const cards = new CardService(root);
    const first = cards.create(input());
    const retained = cards.create(input());
    const second = cards.create(input());
    cards.deleteSubtrees([retained.id], () => true);
    cards.reorderChildren('project', [second.id, first.id]);
    const rows = structuredClone(readCardArtifacts(root, 'project').artifacts);
    const reorder = rows.at(-1)!;
    if (reorder.kind !== 'card-version' || !reorder.history) throw new Error('Expected a reorder card version.');
    expect(reorder.card.children).toEqual([second.id, first.id, retained.id]);
    expect(reorder.history).toMatchObject({ kind: 'reorder', changed_fields: ['children'] });
    expect(validateCardStream(rows, '/canonical/card.jsonl', 'project').current.card.children).toEqual([second.id, first.id, retained.id]);

    const identity = structuredClone(rows);
    const identityRow = identity.at(-1)!;
    if (identityRow.kind !== 'card-version' || !identityRow.history) throw new Error('Expected a reorder card version.');
    identityRow.card.children = [...identityRow.history.snapshot.children];
    expect(() => validateCardStream(identity, '/canonical/card.jsonl', 'project')).toThrow(/invalid child reorder/);

    const changedMembership = structuredClone(rows);
    const changedRow = changedMembership.at(-1)!;
    if (changedRow.kind !== 'card-version') throw new Error('Expected a reorder card version.');
    changedRow.card.children[0] = 'card-z';
    expect(() => validateCardStream(changedMembership, '/canonical/card.jsonl', 'project')).toThrow(/invalid child reorder/);

    const duplicate = structuredClone(rows);
    const duplicateRow = duplicate.at(-1)!;
    if (duplicateRow.kind !== 'card-version') throw new Error('Expected a reorder card version.');
    duplicateRow.card.children[1] = duplicateRow.card.children[0]!;
    expect(() => validateCardStream(duplicate, '/canonical/card.jsonl', 'project')).toThrow();

    for (const nextChildren of [
      [...reorder.card.children, 'card-z'],
      reorder.card.children.slice(1),
      ['card-z', ...reorder.card.children.slice(1)],
    ]) {
      const invalid = structuredClone(rows);
      const invalidRow = invalid.at(-1)!;
      if (invalidRow.kind !== 'card-version') throw new Error('Expected a reorder card version.');
      invalidRow.card.children = nextChildren;
      expect(() => validateCardStream(invalid, '/canonical/card.jsonl', 'project')).toThrow(/invalid child reorder/);
    }

    const wrongKind = structuredClone(rows);
    const wrongKindRow = wrongKind.at(-1)!;
    if (wrongKindRow.kind !== 'card-version' || !wrongKindRow.history) throw new Error('Expected a reorder card version.');
    wrongKindRow.history.kind = 'update';
    expect(() => validateCardStream(wrongKind, '/canonical/card.jsonl', 'project')).toThrow();

    const wrongFields = structuredClone(rows);
    const wrongFieldsRow = wrongFields.at(-1)!;
    if (wrongFieldsRow.kind !== 'card-version' || !wrongFieldsRow.history) throw new Error('Expected a reorder card version.');
    wrongFieldsRow.history.changed_fields = ['children', 'title'];
    expect(() => validateCardStream(wrongFields, '/canonical/card.jsonl', 'project')).toThrow(/wrong changed fields/);

    const piggyback = structuredClone(rows);
    const piggybackRow = piggyback.at(-1)!;
    if (piggybackRow.kind !== 'card-version') throw new Error('Expected a reorder card version.');
    piggybackRow.card.title = 'piggybacked';
    expect(() => validateCardStream(piggyback, '/canonical/card.jsonl', 'project')).toThrow(/piggyback/);
  });

  it('requires an exact type-preserving tombstone and rejects every later row', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-stream-validation-'));
    roots.push(root);
    initProjectTree(root);
    const cards = new CardService(root);
    const card = cards.create(input());
    cards.deleteSubtrees([card.id], () => true);
    const path = cardStreamFile(root, card.id);
    const rows = parseGrowingFile(path, readFileSync(path, 'utf8'), cardStreamRowSchema);
    const validated = validateCardStream(rows, path, card.id);
    expect(rows.map((row) => row.kind)).toEqual(['card-version', 'card-tombstone']);
    expect(validated.tombstone?.final_card.type).toBe('code');
    const exactTombstone = rows.at(-1)!;
    if (exactTombstone.kind !== 'card-tombstone') throw new Error('Expected a terminal tombstone.');
    for (const field of ['status', 'parent', 'depth', 'allowedActions']) {
      expect(cardStreamRowSchema.safeParse({ ...exactTombstone, final_card: { ...exactTombstone.final_card, [field]: null } }).success).toBe(false);
      expect(cardStreamRowSchema.safeParse({ ...exactTombstone, deletion_history: { ...exactTombstone.deletion_history, snapshot: { ...exactTombstone.deletion_history.snapshot, [field]: null } } }).success).toBe(false);
    }

    const changedHistoryCardId = structuredClone(rows);
    const cardIdTombstone = changedHistoryCardId.at(-1)!;
    if (cardIdTombstone.kind !== 'card-tombstone') throw new Error('Expected a terminal tombstone.');
    cardIdTombstone.deletion_history.card_id = 'card-z';
    expect(() => validateCardStream(changedHistoryCardId, path, card.id)).toThrow(/invalid tombstone/);

    const changedHistoryTime = structuredClone(rows);
    const timeTombstone = changedHistoryTime.at(-1)!;
    if (timeTombstone.kind !== 'card-tombstone') throw new Error('Expected a terminal tombstone.');
    timeTombstone.deletion_history.changed_at = '2000-01-01T00:00:00.000Z';
    expect(() => validateCardStream(changedHistoryTime, path, card.id)).toThrow(/invalid tombstone/);

    const changedHistoryVersion = structuredClone(rows);
    const versionTombstone = changedHistoryVersion.at(-1)!;
    if (versionTombstone.kind !== 'card-tombstone') throw new Error('Expected a terminal tombstone.');
    versionTombstone.deletion_history.version_seq = versionTombstone.final_card.version_seq + 1;
    expect(() => validateCardStream(changedHistoryVersion, path, card.id)).toThrow(/invalid tombstone/);

    const wrongMetadata = structuredClone(rows);
    const metadataTombstone = wrongMetadata.at(-1)!;
    if (metadataTombstone.kind !== 'card-tombstone') throw new Error('Expected a terminal tombstone.');
    const rawDeletion = metadataTombstone.deletion_history as unknown as { changed_by_actor: string; changed_by_surface: string };
    rawDeletion.changed_by_actor = 'runtime'; rawDeletion.changed_by_surface = 'runtime';
    expect(cardStreamRowSchema.safeParse(metadataTombstone).success).toBe(true);

    const wrongReason = structuredClone(rows);
    const reasonTombstone = wrongReason.at(-1)!;
    if (reasonTombstone.kind !== 'card-tombstone') throw new Error('Expected a terminal tombstone.');
    reasonTombstone.deletion_history.change_reason = 'delete';
    expect(() => validateCardStream(wrongReason, path, card.id)).toThrow(/invalid reason or summary/);

    const changedType = structuredClone(rows);
    const tombstone = changedType.at(-1)!;
    if (tombstone.kind !== 'card-tombstone') throw new Error('Expected a terminal tombstone.');
    tombstone.final_card.type = 'goal';
    expect(() => validateCardStream(changedType, path, card.id)).toThrow(/invalid tombstone/);
    expect(() => validateCardStream([...rows, rows[0]!], path, card.id)).toThrow(/invalid tombstone position/);
  });
});
