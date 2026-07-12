import type { DomainEvent, Subscription } from '../events/index.js';
import type { OperatorBroadcastEventKind } from '../events/index.js';
import type { LiveSyncInvalidateTarget } from '../contracts/index.js';
import type { RuntimeApi } from '../runtime/control-api.js';
import type { LiveSyncSocket } from './live-sync-socket.js';
import type { ReadModelChangeListener } from '../application/read-model-changes.js';

export const liveSyncEventKinds = [
  'mcp_tool_invocation',
  'runtime_actionable_error',
  'runtime_diagnostic',
  'notification_added',
  'control_action_recorded',
  'analyst_tool_invoked',
  'conversation_changed',
] as const satisfies readonly OperatorBroadcastEventKind[];

export type LiveSyncEventKind = typeof liveSyncEventKinds[number];

function targetKey(target: LiveSyncInvalidateTarget): string {
  return target.resource === 'conversation' ? `${target.resource}\u0000${target.id}` : target.resource;
}

export function mapLiveSyncEvent(event: DomainEvent<LiveSyncEventKind>): LiveSyncInvalidateTarget[] {
  const targets: LiveSyncInvalidateTarget[] = [];
  const add = (target: LiveSyncInvalidateTarget) => targets.push(target);
  switch (event.kind) {

    case 'mcp_tool_invocation':
      break;

    case 'runtime_actionable_error':
    case 'runtime_diagnostic':
      add({ resource: 'timeline' });
      break;

    case 'notification_added':
    case 'control_action_recorded':
      add({ resource: 'timeline' });
      break;

    case 'analyst_tool_invoked':
      add({ resource: 'timeline' });
      break;
    case 'conversation_changed':
      break;


  }

  return targets;
}

export class SyncHub implements ReadModelChangeListener {
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

  runtimeChanged(): void { this.markDirty({ resource: 'runtime' }); }
  cardStateChanged(): void { this.markDirty({ resource: 'cards' }); }
  agentsChanged(): void { this.markDirty({ resource: 'agents' }); }
  conversationChanged(id: string): void { this.markDirty({ resource: 'conversation', id }); }

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
