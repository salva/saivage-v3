import { CardActivationOwner } from '../../src/runtime/actors/card-activation-owner.js';
import type { CardProcessActor } from '../../src/runtime/actors/card-process-actor.js';
import { ChildInvocationLease } from '../../src/runtime/actors/child-invocation-wait.js';
import { createSupervisorRuntimeApi } from '../../src/runtime/actors/supervisor-runtime-api.js';
import type { CardRecord } from '../../src/schemas/index.js';
import { workflowResult } from '../helpers/workflow-result.js';
import { RuntimeGate } from '../../src/runtime/runtime-gate.js';

function card(id: 'project' | 'card-a'): CardRecord {
  return { id, type: id === 'project' ? 'project' : 'code', child_membership: [], active_child_order: [], title: id, subtype: null, priority: 0, urgency: 'normal', created_by: 'planner', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', version_seq: 1, assigned_to: null, depends_on: [], pending_notifications: [], lifecycle: { status: 'running', result: null, error: null, completed_at: null }, metrics: null, estimate: null, started_at: null, duration_ms: null, status_text: null, status_text_updated_at: null, status_text_author_session_id: null, latest_self_report: null, metadata: null };
}

const store = { read: (id: string) => id === 'project' || id === 'card-a' ? card(id) : null };
function processor(activate: CardProcessActor['activate']): CardProcessActor {
  return {
    activate,
    prepareForRuntimeHalt() {},
    joinActivation: async () => [],
  } as unknown as CardProcessActor;
}
const rootProcessor = processor(async () => ({ status: 'done' as const, summary: 'done', result: workflowResult('DONE', 'done') }));
const childProcessor = processor(async () => new Promise<never>(() => undefined));
const owner = new CardActivationOwner({ card: card('project'), processor: rootProcessor, activationId: 'root-activation', entry: 'BACKLOG', phase: 'prepared_root' });
const lease = new ChildInvocationLease({ sessionId: 'agent:planner:project', sourceInputId: 'input-1', toolCallId: 'call-1', toolName: 'activate_card' }, 'card-a');
void lease.activation.catch(() => undefined);
lease.markAdmitted();
const child = new CardActivationOwner({ card: card('card-a'), processor: childProcessor, activationId: 'child-activation', entry: 'BACKLOG', phase: 'child_admission', parentRelationship: { parentCardId: 'project', invocation: lease } });
owner.phase = 'active';
owner.childCardId = child.cardId;
child.phase = 'active';

interface Internals {
  activationOwners: Map<string, CardActivationOwner>;
  runIdentity: object | null;
  currentCardId: string | null;
  status: string;
  halt: { trigger: string; interruption: Error; failure?: Error; promise: Promise<void> } | null;
  activateProcessor(owner: CardActivationOwner): void;
}
let resolveTermination!: (report: { selected: never[]; stopped: never[]; failed: never[] }) => void;
const processTermination = new Promise<{ selected: never[]; stopped: never[]; failed: never[] }>((resolve) => { resolveTermination = resolve; });
const supervisor = createSupervisorRuntimeApi({
  actorStore: store,
  runtimeGate: new RuntimeGate(),
  processRunner: { terminateScopeTree: () => processTermination },
  runtimeProcessRootScope: {},
  freshness: { runtimeChanged() {}, agentMembershipChanged() {} },
} as never);
const internals = supervisor as unknown as Internals;
internals.activationOwners.set('project', owner);
internals.activationOwners.set('card-a', child);
internals.runIdentity = {};
internals.currentCardId = 'card-a';
internals.status = 'running';
const ownerSettlement = owner.settlement.promise.catch((error) => error as Error);
const childSettlement = child.settlement.promise.catch((error) => error as Error);
internals.activateProcessor(owner);
await new Promise<void>((resolve) => setImmediate(resolve));
const halt = internals.halt;
if (!halt) throw new Error('Expected result-settlement failure to install a runtime halt.');
const [ownerFailure, childFailure] = await Promise.all([ownerSettlement, childSettlement]);
resolveTermination({ selected: [], stopped: [], failed: [] });
await halt.promise;
process.stdout.write(JSON.stringify({
  trigger: halt.trigger,
  failureMessage: halt.failure?.message,
  ownerRetainedOriginalFailure: ownerFailure === halt.failure,
  childReceivedInterruption: childFailure === halt.interruption,
}));
