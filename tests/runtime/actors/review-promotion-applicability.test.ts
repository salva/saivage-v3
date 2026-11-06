import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { CardService, initProjectTree, TEST_RUNTIME_WORKFLOWS } from '../../helpers/canonical-project.js';
import { workflowResult } from '../../helpers/workflow-result.js';
import { AgentExecutor, type ReviewerSnapshot } from '../../../src/runtime/actors/agent-executor.js';
import { NodeExecution, type AcceptedNodeResult, type NodeExecutionArgs, type NodeExecutionDeps, type NodeExecutionHost } from '../../../src/runtime/actors/node-execution.js';
import type { CompiledNodeContract } from '../../../src/runtime/card-process/card-process-config.js';

const roots: string[] = [];
afterEach(() => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync('/home/salva/g/ml/tmp/review-applicability-');
  roots.push(root);
  initProjectTree(root);
  const store = new CardService(root);
  const child = store.create({ parent: 'project', type: 'goal', title: 'Reviewed work', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], bootstrap_content: 'Original assignment' });
  store.setStatus(child.id, 'running');
  store.commitActivationOutcome(child.id, { status: 'done', summary: 'Reviewed delivery', result: workflowResult('DONE', 'Reviewed delivery') }, new Date().toISOString());
  const process = TEST_RUNTIME_WORKFLOWS.cardTypes.get('project')!;
  const review = process.states.get('node:review')! as CompiledNodeContract;
  const deps = { cardId: 'project', store, workflows: TEST_RUNTIME_WORKFLOWS } as NodeExecutionDeps;
  const executor = new AgentExecutor(deps, {} as NodeExecutionHost);
  const capture = (records = review.descendantContext!.records.map(({ name }) => name)) =>
    (executor as unknown as { captureReviewerSnapshot(id: string, records: readonly string[]): ReviewerSnapshot }).captureReviewerSnapshot('project', records);
  const stale = (snapshot: ReviewerSnapshot) =>
    (executor as unknown as { reviewerStaleReason(id: string, snapshot: ReviewerSnapshot, records: readonly string[]): string | null }).reviewerStaleReason('project', snapshot, review.descendantContext!.records.map(({ name }) => name));
  const queue = (id: string) => {
    const notification = { id: randomUUID(), content: 'Ordinary context', created_at: new Date().toISOString() };
    store.enqueueNotification(id, notification);
    return notification.id;
  };
  return { store, child, process, review, deps, executor, capture, stale, queue };
}

describe('review applicability uses selected ordinary cards and exact record observations', () => {
  it('keeps root/descendant queue-only changes out of promotion but not current-review freshness', () => {
    const h = fixture();
    h.store.setStatus(h.child.id, 'changed');
    const before = h.capture();
    for (const id of ['project', h.child.id]) {
      const notificationId = h.queue(id);
      const queued = h.capture();
      expect(queued.cards.map(({ ordinary }) => ordinary)).toEqual(before.cards.map(({ ordinary }) => ordinary));
      expect(queued.cards.find((card) => card.id === id)!.headId).not.toBe(before.cards.find((card) => card.id === id)!.headId);
      expect(h.stale(before)).not.toBeNull();
      expect(h.executor.reviewPromotionViolation('project', h.review, before)).toBeNull();
      h.store.removeNotifications(id, [notificationId]);
      expect(h.executor.reviewPromotionViolation('project', h.review, before)).toBeNull();
    }
  });

  it('includes the required bootstrap once, alongside optional configured records and absence values', () => {
    const h = fixture();
    const snapshot = h.capture(['status.md', 'brief.md']);
    expect(snapshot.includedRecordVersions.map(({ filename }) => filename)).toEqual(['status.md', 'brief.md']);
    expect(snapshot.includedRecordVersions.find(({ filename }) => filename === 'brief.md')).toMatchObject({ sourceEntryId: expect.any(String), sourceVersion: 1, headId: expect.any(String) });
    expect(snapshot.includedRecordVersions.find(({ filename }) => filename === 'status.md')).toMatchObject({ sourceEntryId: null, sourceVersion: null });
  });

  it.each(['root', 'descendant', 'membership', 'order'] as const)('rejects a real %s ordinary publication', (change) => {
    const h = fixture();
    if (change === 'order') h.store.create({ parent: 'project', type: 'goal', title: 'Other', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], bootstrap_content: 'Other assignment' });
    const before = h.capture();
    if (change === 'root') h.store.editCard('project', { title: 'Revised title' });
    else if (change === 'descendant') h.store.setStatus(h.child.id, 'changed');
    else if (change === 'membership') h.store.create({ parent: 'project', type: 'goal', title: 'Added', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], bootstrap_content: 'Added assignment' });
    else h.store.reorderChildren('project', [...h.store.listChildren('project')].reverse());
    expect(h.executor.reviewPromotionViolation('project', h.review, before)).toContain('admit_review');
  });

  it.each(['status.md', 'brief.md'] as const)('rejects newly accepted %s even with the same content and unchanged ordinary cards', (name) => {
    const h = fixture();
    h.store.acceptRecord(h.child.id, name, 'Same text', { kind: 'agent', agent: 'analyst' });
    const before = h.capture();
    h.store.acceptRecord(h.child.id, name, 'Intervening correction', { kind: 'agent', agent: 'analyst' });
    h.store.acceptRecord(h.child.id, name, 'Same text', { kind: 'agent', agent: 'analyst' });
    const after = h.capture();
    expect(after.cards).toEqual(before.cards);
    expect(after.includedRecordVersions).not.toEqual(before.includedRecordVersions);
    expect(h.executor.reviewPromotionViolation('project', h.review, before)).toContain('review');
  });

  it('checks the original review custom record set, not assessment inputs, including draft-only heads', () => {
    const h = fixture();
    const review = { ...h.review, descendantContext: { ...h.review.descendantContext!, records: [h.process.records.get('review.md')!] } };
    const before = h.capture(['review.md']);
    h.store.openRecord(h.child.id, 'review.md');
    expect(h.executor.reviewPromotionViolation('project', h.review, h.capture())).toBeNull();
    expect(h.executor.reviewPromotionViolation('project', review, before)).not.toBeNull();
  });

  it('rejects different immutable UUIDs even when numeric versions are equal', () => {
    const h = fixture();
    const before = h.capture();
    const different = structuredClone(before);
    different.cards[1]!.ordinary = { ...different.cards[1]!.ordinary, entry_id: randomUUID() };
    expect(h.executor.reviewPromotionViolation('project', h.review, different)).not.toBeNull();
    const record = structuredClone(before);
    record.includedRecordVersions.find(({ filename }) => filename === 'brief.md')!.headId = randomUUID();
    expect(h.executor.reviewPromotionViolation('project', h.review, record)).not.toBeNull();
  });
});

describe('terminal promotion acceptance boundaries', () => {
  it.each([
    ['off', 'record', false],
    ['writers', 'record', false],
    ['verify', 'record', false],
    ['writers', 'queue', true],
    ['verify', 'queue', true],
  ] as const)('checks %s after awaited settlement: %s change, accepted=%s', async (phase, change, succeeds) => {
    const h = fixture();
    const snapshot = h.capture();
    const assessment = h.process.states.get('node:assess-completion')! as CompiledNodeContract;
    expect(assessment.kind).toBe('node');
    const events: string[] = [];
    const source = { candidate: 'unchanged-source' };
    const promoted = { reviewerSnapshot: snapshot, source } as unknown as AcceptedNodeResult;
    const mutate = () => {
      events.push('change');
      if (change === 'record') h.store.acceptRecord(h.child.id, 'status.md', 'New evidence', { kind: 'agent', agent: 'analyst' });
      else {
        const notificationId = h.queue('project');
        h.store.removeNotifications('project', [notificationId]);
      }
    };
    const execution = new NodeExecution({ ...h.deps, workflows: { ...TEST_RUNTIME_WORKFLOWS, gitPolicy: { review_bindings: { project: { node: 'review', approved_outcome: 'approved' } } } } } as unknown as NodeExecutionDeps, {
      promotedResult: () => { events.push('select-promoted'); return promoted; },
      assertCurrentActivation: () => {},
      assertCurrentNode: () => {},
      assertPromotionAvailable: () => {},
      claimResultHandoff: () => { events.push('claim'); },
    } as unknown as NodeExecutionHost);
    jest.spyOn(execution, 'settleSourceWriters').mockImplementation(async () => {
      await Promise.resolve();
      events.push('writers-settled');
      if (phase === 'writers') mutate();
    });
    const nativeSource = phase === 'off' ? null : {
      verifyCandidate: async () => {
        events.push('verify');
        await Promise.resolve();
        if (phase === 'verify') mutate();
        return null;
      },
    };
    if (phase === 'off') mutate();
    const internals = execution as unknown as {
      validateRecords(): { candidates: Map<string, never> };
      closeAcceptedRecords(): [];
      acceptCandidate(...args: unknown[]): Promise<{ violations?: string[]; accepted?: AcceptedNodeResult }>;
    };
    internals.validateRecords = () => ({ candidates: new Map<string, never>() });
    internals.closeAcceptedRecords = () => { events.push('close'); return []; };
    const result = await internals.acceptCandidate(
      { node: assessment, process: h.process, input: { card: h.store.read('project'), nativeSource, notificationDelivery: { hasPendingNotifications: () => false } }, signal: new AbortController().signal, nodeOrdinal: 4 } as unknown as NodeExecutionArgs,
      { outcome: 'complete_reviewed', summary: 'Promote reviewed work' },
      new Map(), () => null, () => { events.push('before-claim'); }, () => {}, new Set(),
    );
    if (succeeds) {
      expect(result.accepted?.event).toBe('result:complete_reviewed');
      expect(events).toContain('verify');
      expect(events.slice(-3)).toEqual(['before-claim', 'claim', 'close']);
    } else {
      expect(result.violations?.[0]).toContain("Review 'review'");
      expect(events).not.toContain('before-claim');
      expect(events).not.toContain('claim');
      expect(events).not.toContain('close');
      if (phase === 'writers') expect(events).not.toContain('verify');
    }
  });
});
