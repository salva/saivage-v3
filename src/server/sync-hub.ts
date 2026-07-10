import type { DomainEvent, Subscription } from '../events/index.js';
import type { OperatorBroadcastEventKind } from '../events/index.js';
import type { LiveSyncInvalidateTarget } from '../contracts/index.js';
import type { RuntimeApi } from '../runtime/control-api.js';
import type { LiveSyncSocket } from './live-sync-socket.js';

export const liveSyncEventKinds = [
  'card_history_appended',
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

function sessionIdFrom(event: DomainEvent<LiveSyncEventKind>): string | null {
  const source = {
    ...(event.payload as Record<string, unknown>),
    ...(event as unknown as Record<string, unknown>),
  };
  const direct = source['session_id'];
  if (typeof direct === 'string' && direct) return direct;
  const camel = source['sessionId'];
  return typeof camel === 'string' && camel ? camel : null;
}

function isCardControlAction(event: DomainEvent<LiveSyncEventKind>): boolean {
  const action = (event.payload as Record<string, unknown>)['action'];
  return typeof action === 'string' && action.startsWith('card.');
}

function isCardAnalystTool(event: DomainEvent<LiveSyncEventKind>): boolean {
  const tool = (event.payload as Record<string, unknown>)['tool'];
  return typeof tool === 'string' && ['create_card', 'edit_card', 'delete_card', 'reorder_child'].includes(tool);
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
      add({ resource: 'cards' });
      break;

    case 'mcp_tool_invocation':
      break;

    case 'runtime_actionable_error':
    case 'runtime_diagnostic':
      add({ resource: 'runtime' });
      add({ resource: 'timeline' });
      break;

    case 'notification_added':
    case 'control_action_recorded':
      if (isCardControlAction(event)) add({ resource: 'cards' });
      add({ resource: 'timeline' });
      break;

    case 'analyst_tool_invoked':
      if (isCardAnalystTool(event)) add({ resource: 'cards' });
      add({ resource: 'timeline' });
      break;

    case 'conversation_changed':
      addConversation();
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
