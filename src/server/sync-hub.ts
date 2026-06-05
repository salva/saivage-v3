import type { DomainEvent, Subscription } from '../events/index.js';
import type { OperatorBroadcastEventKind } from '../events/index.js';
import type { LiveSyncInvalidateTarget } from '../contracts/index.js';
import type { RuntimeApi } from '../runtime/control-api.js';
import type { LiveSyncSocket } from './live-sync-socket.js';

export const liveSyncEventKinds = [
  'card_history_appended',
  'card_failed',
  'goal_completed',
  'goal_failed',
  'plan_updated',
  'session_started',
  'session_cancelled',
  'session_force_cancelled',
  'llm_attempt',
  'llm_invocation_summary',
  'llm_verifier_rejection',
  'compaction_triggered',
  'model_issue',
  'mcp_tool_invocation',
  'runtime_run',
  'runtime_activation',
  'runtime_command',
  'paused',
  'resumed',
  'frozen',
  'resumed_from_freeze',
  'project_run_completed',
  'runtime_actionable_error',
  'runtime_diagnostic',
  'runtime_fatal_error',
  'review_complete',
  'review_failed',
  'escalation',
  'dispatch_blocked',
  'notification_added',
  'control_action_recorded',
  'analyst_tool_invoked',
  'process_reconciled_dead',
  'process_reattach_rejected',
] as const satisfies readonly OperatorBroadcastEventKind[];

export type LiveSyncEventKind = typeof liveSyncEventKinds[number];

function targetKey(target: LiveSyncInvalidateTarget): string {
  return target.resource === 'conversation' ? `${target.resource}\u0000${target.id}` : target.resource;
}

function sessionIdFrom(event: DomainEvent<LiveSyncEventKind>): string | null {
  const direct = (event as unknown as Record<string, unknown>)['session_id'];
  if (typeof direct === 'string' && direct) return direct;
  const camel = (event as unknown as Record<string, unknown>)['sessionId'];
  return typeof camel === 'string' && camel ? camel : null;
}

export function mapLiveSyncEvent(event: DomainEvent<LiveSyncEventKind>): LiveSyncInvalidateTarget[] {
  const targets: LiveSyncInvalidateTarget[] = [];
  const add = (target: LiveSyncInvalidateTarget) => targets.push(target);
  const addConversation = () => {
    const id = sessionIdFrom(event);
    if (id) add({ resource: 'conversation', id });
  };

  switch (event.kind) {
    case 'card_history_appended':
    case 'card_failed':
    case 'goal_completed':
    case 'goal_failed':
    case 'plan_updated':
      add({ resource: 'cards' });
      if (event.kind !== 'plan_updated') add({ resource: 'timeline' });
      break;

    case 'session_started':
    case 'session_cancelled':
    case 'session_force_cancelled':
    case 'llm_invocation_summary':
    case 'compaction_triggered':
    case 'model_issue':
      add({ resource: 'agents' });
      addConversation();
      break;

    case 'llm_attempt':
    case 'llm_verifier_rejection':
    case 'mcp_tool_invocation':
      addConversation();
      break;

    case 'runtime_run':
    case 'runtime_activation':
    case 'runtime_command':
    case 'paused':
    case 'resumed':
    case 'frozen':
    case 'resumed_from_freeze':
    case 'project_run_completed':
      add({ resource: 'runtime' });
      break;

    case 'runtime_actionable_error':
    case 'runtime_diagnostic':
    case 'runtime_fatal_error':
      add({ resource: 'runtime' });
      add({ resource: 'timeline' });
      break;

    case 'review_complete':
    case 'review_failed':
    case 'escalation':
    case 'dispatch_blocked':
    case 'notification_added':
    case 'control_action_recorded':
    case 'analyst_tool_invoked':
      add({ resource: 'timeline' });
      break;

    case 'process_reconciled_dead':
    case 'process_reattach_rejected':
      add({ resource: 'processes' });
      add({ resource: 'timeline' });
      break;
  }

  return targets;
}

export class SyncHub {
  private readonly pending = new Map<string, LiveSyncInvalidateTarget>();
  private readonly subscriptions = new Map<object, Subscription>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly liveSyncSocket: LiveSyncSocket, private readonly debounceMs = 75) {}

  wire(runtime: Pick<RuntimeApi, 'subscribe'>): void {
    const key = runtime as object;
    if (this.subscriptions.has(key)) return;
    const subscription = runtime.subscribe({
      minSeverity: 'info',
      allowedKinds: [...liveSyncEventKinds],
      handler: (event) => {
        for (const target of mapLiveSyncEvent(event as DomainEvent<LiveSyncEventKind>)) this.markDirty(target);
      },
    });
    this.subscriptions.set(key, subscription);
  }

  dispose(runtime?: Pick<RuntimeApi, 'subscribe'>): void {
    if (runtime) {
      const key = runtime as object;
      this.subscriptions.get(key)?.unsubscribe();
      this.subscriptions.delete(key);
    } else {
      for (const subscription of this.subscriptions.values()) subscription.unsubscribe();
      this.subscriptions.clear();
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  subscriptionCount(): number {
    return this.subscriptions.size;
  }

  private markDirty(target: LiveSyncInvalidateTarget): void {
    this.pending.set(targetKey(target), target);
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  private flush(): void {
    this.timer = null;
    const targets = [...this.pending.values()];
    this.pending.clear();
    for (const target of targets) this.liveSyncSocket.invalidate(target);
  }
}
