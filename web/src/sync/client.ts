import { readonly, ref } from 'vue';
import { getWsConnection, type WsConnectionManager } from '../api/websocket';
import type { LiveSyncInvalidateFrame, LiveSyncUnscopedResource, WsConnectionState } from '../api/types';
import { isAnalystActivityContent } from '../api/contracts';
import { useAnalystChat } from '../stores/analystChat';
import { createLogger } from '../utils/logger';

export type SyncResourceScope = 'core' | 'active';
export type SyncResourceKey = LiveSyncUnscopedResource;

export interface SyncResourceRegistration {
  resource: SyncResourceKey;
  scope: SyncResourceScope;
  refetch: () => Promise<void>;
  onRefetch?: (timestamp: string) => void;
}

interface FlightState {
  inFlight: boolean;
  trailing: boolean;
}

const log = createLogger('sync');

export class SyncClient {
  private readonly conn: WsConnectionManager;
  private readonly resources = new Map<SyncResourceKey, SyncResourceRegistration>();
  private readonly conversations = new Map<string, () => Promise<void>>();
  private readonly flights = new Map<string, FlightState>();
  private started = false;

  private readonly connectionStateRef: ReturnType<typeof ref<WsConnectionState>>;
  private readonly lastConnectedAtRef = ref<string | null>(null);
  private readonly lastEventAtRef = ref<string | null>(null);

  readonly connectionState: Readonly<ReturnType<typeof ref<WsConnectionState>>>;
  readonly lastConnectedAt: Readonly<ReturnType<typeof ref<string | null>>>;
  readonly lastEventAt: Readonly<ReturnType<typeof ref<string | null>>>;

  constructor(conn: WsConnectionManager = getWsConnection()) {
    this.conn = conn;
    this.connectionStateRef = ref<WsConnectionState>(conn.state.value);
    this.connectionState = readonly(this.connectionStateRef);
    this.lastConnectedAt = readonly(this.lastConnectedAtRef);
    this.lastEventAt = readonly(this.lastEventAtRef);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.conn.onState((state) => {
      this.connectionStateRef.value = state;
      if (state !== 'connected') return;
      this.lastConnectedAtRef.value = new Date().toISOString();
    });
    this.conn.onOpen(() => {
      this.lastConnectedAtRef.value = new Date().toISOString();
      this.refetchRegistered();
      this.resubscribeConversations();
    });
    this.conn.onSyncFrame((frame) => this.handleSyncFrame(frame));
    this.conn.onEvent((envelope) => {
      this.lastEventAtRef.value = new Date().toISOString();
      if (isAnalystActivityContent(envelope.content)) useAnalystChat().ingestWsEvent(envelope.content);
    });
    this.conn.connect();
  }

  stop(): void {
    this.conn.disconnect();
    this.connectionStateRef.value = 'offline';
    this.lastConnectedAtRef.value = null;
  }

  register(registration: SyncResourceRegistration): () => void {
    this.resources.set(registration.resource, registration);
    if (this.conn.state.value === 'connected') this.refetchResource(registration.resource);
    return () => {
      const current = this.resources.get(registration.resource);
      if (current === registration) this.resources.delete(registration.resource);
    };
  }

  openConversation(sessionId: string, refetch: () => Promise<void>): () => void {
    this.conversations.set(sessionId, refetch);
    this.conn.sendRaw({ t: 'subscribe', resource: 'conversation', id: sessionId });
    this.refetchConversation(sessionId);
    return () => this.closeConversation(sessionId);
  }

  closeConversation(sessionId: string): void {
    this.conversations.delete(sessionId);
    this.conn.sendRaw({ t: 'unsubscribe', resource: 'conversation', id: sessionId });
  }

  sendMessage(text: string): void {
    this.conn.sendMessage(text);
  }

  private handleSyncFrame(frame: LiveSyncInvalidateFrame): void {
    const timestamp = new Date().toISOString();
    this.lastEventAtRef.value = timestamp;
    if (frame.resource === 'conversation') {
      this.refetchConversation(frame.id);
      return;
    }
    this.refetchResource(frame.resource, timestamp);
  }

  private refetchRegistered(): void {
    for (const key of this.resources.keys()) this.refetchResource(key);
    for (const sessionId of this.conversations.keys()) this.refetchConversation(sessionId);
  }

  private resubscribeConversations(): void {
    for (const id of this.conversations.keys()) this.conn.sendRaw({ t: 'subscribe', resource: 'conversation', id });
  }

  private refetchResource(resource: SyncResourceKey, invalidatedAt?: string): void {
    const registration = this.resources.get(resource);
    if (!registration) return;
    this.runSingleFlight(resource, registration.refetch, invalidatedAt, registration.onRefetch);
  }

  private refetchConversation(sessionId: string): void {
    const refetch = this.conversations.get(sessionId);
    if (!refetch) return;
    this.runSingleFlight(`conversation:${sessionId}`, refetch);
  }

  private runSingleFlight(key: string, refetch: () => Promise<void>, refetchedAt?: string, onRefetch?: (timestamp: string) => void): void {
    const state = this.flights.get(key) ?? { inFlight: false, trailing: false };
    this.flights.set(key, state);
    if (state.inFlight) {
      state.trailing = true;
      return;
    }
    state.inFlight = true;
    void refetch()
      .then(() => {
        if (refetchedAt) onRefetch?.(refetchedAt);
      })
      .catch((err) => log.warn(`Sync refetch failed for ${key}`, err))
      .finally(() => {
        state.inFlight = false;
        if (state.trailing) {
          state.trailing = false;
          this.runSingleFlight(key, refetch);
          return;
        }
        this.flights.delete(key);
      });
  }
}

export const syncClient = new SyncClient();
