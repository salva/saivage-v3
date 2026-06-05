import type { WebSocket } from 'ws';
import { parseLiveSyncClientFrame, type LiveSyncInvalidateTarget } from '../contracts/index.js';

function scopedKey(target: Extract<LiveSyncInvalidateTarget, { resource: 'conversation' }>): string {
  return `${target.resource}\u0000${target.id}`;
}

function isOpen(ws: WebSocket): boolean {
  return ws.readyState === ws.OPEN;
}

export class LiveSyncSocket {
  private readonly clients = new Set<WebSocket>();
  private readonly conversationSubscriptions = new WeakMap<WebSocket, Set<string>>();

  add(ws: WebSocket): void {
    this.clients.add(ws);
  }

  delete(ws: WebSocket): void {
    this.clients.delete(ws);
    this.conversationSubscriptions.delete(ws);
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
    const set = this.conversationSubscriptions.get(ws) ?? new Set<string>();
    if (frame.t === 'subscribe') set.add(scopedKey({ resource: 'conversation', id: frame.id }));
    else set.delete(scopedKey({ resource: 'conversation', id: frame.id }));
    if (set.size > 0) this.conversationSubscriptions.set(ws, set);
    else this.conversationSubscriptions.delete(ws);
    return true;
  }

  invalidate(target: LiveSyncInvalidateTarget): void {
    const payload = JSON.stringify({ t: 'invalidate', ...target });
    if (target.resource === 'conversation') {
      const key = scopedKey(target);
      for (const ws of this.clients) {
        const subscriptions = this.conversationSubscriptions.get(ws);
        if (subscriptions?.has(key)) this.sendRaw(ws, payload);
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
