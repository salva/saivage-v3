import type { WebSocket } from 'ws';
import { parseLiveSyncClientFrame, type LiveSyncInvalidateTarget } from '../contracts/index.js';

function isOpen(ws: WebSocket): boolean {
  return ws.readyState === ws.OPEN;
}

export class LiveSyncSocket {
  private readonly clients = new Set<WebSocket>();
  private readonly subscriptions = new WeakMap<WebSocket, Map<string, string>>();
  private admissionOpen = true;

  add(ws: WebSocket): void {
    if (!this.admissionOpen) {
      ws.close();
      return;
    }
    this.clients.add(ws);
  }

  closeAdmission(): void {
    this.admissionOpen = false;
  }
  isAdmissionOpen(): boolean {
    return this.admissionOpen;
  }

  delete(ws: WebSocket): void {
    this.clients.delete(ws);
    this.subscriptions.delete(ws);
  }

  clientCount(): number {
    return this.clients.size;
  }

  forEachClient(callback: (ws: WebSocket) => void): void {
    for (const ws of this.clients) callback(ws);
  }

  dispose(): void {
    for (const ws of this.clients) {
      try {
        ws.removeAllListeners();
        if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
      } catch {
        void 0;
      }
    }
    this.clients.clear();
  }

  handleClientFrame(ws: WebSocket, input: unknown): boolean {
    const frame = parseLiveSyncClientFrame(input);
    if (!frame) return false;
    const set = this.subscriptions.get(ws) ?? new Map<string, string>();
    const key = subscriptionKey(frame);
    if (frame.t === 'subscribe') {
      set.set(key, frame.lease);
      this.subscriptions.set(ws, set);
      this.sendRaw(ws, JSON.stringify({ ...frame, t: 'subscribed' }));
    } else if (set.get(key) === frame.lease) set.delete(key);
    if (set.size > 0) this.subscriptions.set(ws, set);
    else this.subscriptions.delete(ws);
    return true;
  }

  invalidate(target: LiveSyncInvalidateTarget): void {
    const payload = JSON.stringify({ t: 'invalidate', ...target });
    if (target.resource === 'conversation' || target.resource === 'llm-exchange') {
      for (const ws of this.clients) {
        if (this.subscriptions.get(ws)?.has(`${target.resource}\u0000${target.id}`))
          this.sendRaw(ws, payload);
      }
      return;
    }
    if (target.resource === 'agent-membership') {
      for (const ws of this.clients) {
        const subscriptions = this.subscriptions.get(ws);
        if (
          subscriptions?.has('agents') ||
          (target.scope === 'card' &&
            subscriptions?.has(`card-agent-sessions\u0000${target.card_id}`))
        )
          this.sendRaw(ws, payload);
      }
      return;
    }
    for (const ws of this.clients) this.sendRaw(ws, payload);
  }

  private sendRaw(ws: WebSocket, payload: string): void {
    try {
      if (isOpen(ws)) ws.send(payload);
    } catch {
      void 0;
    }
  }
}

function subscriptionKey(frame: import('../contracts/index.js').LiveSyncClientFrame): string {
  if (frame.resource === 'agents') return 'agents';
  return `${frame.resource}\u0000${frame.id}`;
}
