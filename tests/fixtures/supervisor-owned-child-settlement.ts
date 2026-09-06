import { CardActivationOwner } from '../../src/runtime/actors/card-activation-owner.js';
import type { CardProcessActor } from '../../src/runtime/actors/card-process-actor.js';
import { SupervisorRuntimeApi } from '../../src/runtime/actors/supervisor-runtime-api.js';
import type { CardRecord } from '../../src/schemas/index.js';
import { workflowResult } from '../helpers/workflow-result.js';
import { RuntimeGate } from '../../src/runtime/runtime-gate.js';

function card(id: 'project' | 'card-a'): CardRecord {
  return { id, type: id === 'project' ? 'project' : 'code', child_membership: [], active_child_order: [], title: id, subtype: null, tags: [], priority: 0, urgency: 'normal', created_by: 'planner', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', version_seq: 1, assigned_to: null, depends_on: [], related: [], pending_notifications: [], lifecycle: { status: 'running', result: null, error: null, completed_at: null }, metrics: null, estimate: null, started_at: null, duration_ms: null, status_text: null, status_text_updated_at: null, status_text_author_session_id: null, latest_self_report: null, metadata: null };
}

const store = { read: (id: string) => id === 'project' || id === 'card-a' ? card(id) : null };
const processor = {
  activate: async () => ({ status: 'done' as const, summary: 'done', result: workflowResult('DONE', 'done') }),
} as unknown as CardProcessActor;
const owner = new CardActivationOwner({ card: card('project'), processor, activationId: 'root-activation', entry: 'BACKLOG', phase: 'prepared_root' });
owner.phase = 'active';
owner.childCardId = 'card-a';

interface Internals {
  activationOwners: Map<string, CardActivationOwner>;
  activateProcessor(owner: CardActivationOwner): void;
}
const supervisor = new SupervisorRuntimeApi({ actorStore: store, runtimeGate: new RuntimeGate() } as never);
const internals = supervisor as unknown as Internals;
internals.activationOwners.set('project', owner);
internals.activateProcessor(owner);
