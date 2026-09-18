import { CardActivationOwner } from '../../src/runtime/actors/card-activation-owner.js';
import type { CardProcessActor } from '../../src/runtime/actors/card-process-actor.js';
import { createSupervisorRuntimeApi } from '../../src/runtime/actors/supervisor-runtime-api.js';
import type { CardActivationOutcome } from '../../src/contracts/tool-api.js';
import type { CardRecord } from '../../src/schemas/index.js';
import { RuntimeGate } from '../../src/runtime/runtime-gate.js';
import { workflowResult } from '../helpers/workflow-result.js';

const card: CardRecord = { id: 'project', type: 'project', child_membership: [], active_child_order: [], title: 'project', subtype: null, priority: 0, urgency: 'normal', created_by: 'planner', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', version_seq: 1, assigned_to: null, depends_on: [], pending_notifications: [], lifecycle: { status: 'running', result: null, error: null, completed_at: null }, metrics: null, estimate: null, started_at: null, duration_ms: null, status_text: null, status_text_updated_at: null, status_text_author_session_id: null, latest_self_report: null, metadata: null };
const processor = {
  activate: async () => ({ status: 'done' as const, summary: 'done', result: workflowResult('DONE', 'done') }),
} as unknown as CardProcessActor;
const owner = new CardActivationOwner({ card, processor, activationId: 'root-activation', entry: 'BACKLOG', phase: 'prepared_root' });
owner.phase = 'active';

interface Internals {
  activationOwners: Map<string, CardActivationOwner>;
  runIdentity: object | null;
  currentCardId: string | null;
  status: string;
  halt: object | null;
  activateProcessor(owner: CardActivationOwner): void;
  settleResult(owner: CardActivationOwner, outcome: Exclude<CardActivationOutcome, { status: 'cancelled' | 'stopped' }>): Promise<void>;
}

let storeWrites = 0;
let processTerminations = 0;
let injectionRan = false;
const supervisor = createSupervisorRuntimeApi({
  actorStore: {
    read: (id: string) => id === 'project' ? card : null,
    commitActivationOutcome: () => { storeWrites += 1; throw new Error('Unexpected store write.'); },
    setStatus: () => { storeWrites += 1; throw new Error('Unexpected store write.'); },
    stopRunning: () => { storeWrites += 1; throw new Error('Unexpected store write.'); },
  },
  runtimeGate: new RuntimeGate(),
  processRunner: { terminateScopeTree: async () => { processTerminations += 1; return { selected: [], stopped: [], failed: [] }; } },
  runtimeProcessRootScope: {},
  freshness: { runtimeChanged() {}, agentMembershipChanged() {} },
} as never);
const internals = supervisor as unknown as Internals;
internals.activationOwners.set('project', owner);
internals.runIdentity = {};
internals.currentCardId = 'project';
internals.status = 'running';
internals.settleResult = async () => {
  injectionRan = true;
  internals.activationOwners.clear();
  internals.runIdentity = null;
  internals.currentCardId = null;
  internals.status = 'stopped';
  throw new Error('synthetic stale settlement');
};

internals.activateProcessor(owner);
await new Promise<void>((resolve) => setImmediate(resolve));
process.stdout.write(JSON.stringify({
  injectionRan,
  haltAbsent: internals.halt === null,
  stoppedAuthorityRetained: internals.runIdentity === null && internals.currentCardId === null && internals.status === 'stopped',
  ownersEmpty: internals.activationOwners.size === 0,
  processTerminations,
  storeWrites,
}));
