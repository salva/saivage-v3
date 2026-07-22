import { describe, expect, it } from '@jest/globals';
import { CardActivationOwner, type CardProcessorActor } from '../../../src/runtime/actors/card-activation-owner.js';
import type { CardRecord } from '../../../src/schemas/index.js';
import { workflowResult } from '../../helpers/workflow-result.js';

const card: CardRecord = { id: 'project', type: 'project', children: [], title: 'Project', subtype: null, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', version_seq: 1, assigned_to: null, depends_on: [], related: [], pending_notifications: [], lifecycle: { status: 'backlog', result: null, error: null, completed_at: null }, metrics: null, estimate: null, started_at: null, duration_ms: null, status_text: null, status_text_updated_at: null, status_text_author_session_id: null, latest_self_report: null, metadata: null };
const processor = { start() {}, activate: async () => ({ status: 'done' as const, summary: 'done', result: workflowResult('DONE','done') }), disposeActivation() {}, suppressContinuationAndPrepareJoin() {}, joinActivation: async () => [], processPosition: () => ({ cardType: 'project' as const, stateId: 'ready', kind: 'ready' as const }), executingLlmSnapshot: () => null } satisfies CardProcessorActor;

describe('CardActivationOwner terminal and containment authority', () => {
  it('starts with independent open terminal and absent containment axes', () => { const owner = new CardActivationOwner({ card, store: {} as never, processor, activationId: 'activation', entry: 'BACKLOG', caller: { kind: 'root' }, phase: 'prepared_root' }); expect(owner).toMatchObject({ phase: 'prepared_root', terminalWinner: 'open', containmentOwner: 'none', childCardId: null }); });
  it('can retain a result winner while Stop owns containment', () => { const owner = new CardActivationOwner({ card, store: {} as never, processor, activationId: 'activation', entry: 'BACKLOG', caller: { kind: 'root' }, phase: 'prepared_root' }); owner.terminalWinner = 'result'; owner.containmentOwner = 'stop'; owner.phase = 'settled_contained'; expect(owner).toMatchObject({ terminalWinner: 'result', containmentOwner: 'stop', phase: 'settled_contained' }); });
});
