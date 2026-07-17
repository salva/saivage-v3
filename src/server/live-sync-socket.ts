import type { WebSocket } from 'ws';
import { parseLiveSyncClientFrame, type LiveSyncInvalidateTarget } from '../contracts/index.js';
import type { ConversationSessionId } from '../schemas/index.js';

function isOpen(ws: WebSocket): boolean {
  return ws.readyState === ws.OPEN;
}

export class LiveSyncSocket {
  private readonly clients = new Set<WebSocket>();
  private readonly conversationSubscriptions = new WeakMap<WebSocket, Map<ConversationSessionId, string>>();
  private admissionOpen = true;

  add(ws: WebSocket): void {
    if (!this.admissionOpen) { ws.close(); return; }
    this.clients.add(ws);
  }

  closeAdmission(): void { this.admissionOpen = false; }
  isAdmissionOpen(): boolean { return this.admissionOpen; }

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
    const set = this.conversationSubscriptions.get(ws) ?? new Map<ConversationSessionId, string>();
    if (frame.t === 'subscribe') {
      set.set(frame.id, frame.lease);
      this.sendRaw(ws, JSON.stringify({ t: 'subscribed', resource: 'conversation', id: frame.id, lease: frame.lease }));
    } else if (set.get(frame.id) === frame.lease) set.delete(frame.id);
    if (set.size > 0) this.conversationSubscriptions.set(ws, set);
    else this.conversationSubscriptions.delete(ws);
    return true;
  }

  invalidate(target: LiveSyncInvalidateTarget): void {
    const payload = JSON.stringify({ t: 'invalidate', ...target });
    if (target.resource === 'conversation') {
      for (const ws of this.clients) {
        const subscriptions = this.conversationSubscriptions.get(ws);
        if (subscriptions?.has(target.id)) this.sendRaw(ws, payload);
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
