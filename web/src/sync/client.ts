import { readonly, ref } from 'vue';
import { getWsConnection, type WsConnectionManager } from '../api/websocket';
import type { LiveSyncCardInvalidateTarget, LiveSyncInvalidateFrame, LiveSyncSubscribedFrame, LiveSyncUnscopedResource, WsConnectionState } from '../api/types';
import { isAnalystActivityContent, parseAnalystTurnAcknowledgedStatusContent, type ConversationSessionId } from '../api/contracts';
import { useAnalystChat } from '../stores/analystChat';
import { createLogger } from '../utils/logger';

export type SyncResourceScope = 'core' | 'active';
export type SyncResourceKey = LiveSyncUnscopedResource | 'cards';

export type SyncResourceRegistration =
  | {
      resource: 'cards';
      onInvalidate: (target: LiveSyncCardInvalidateTarget) => void;
      onReconnect: () => void;
    }
  | {
      resource: Exclude<SyncResourceKey, 'cards'>;
      scope: SyncResourceScope;
      requestOwnership: 'sync-client' | 'resource-store';
      refetch: () => Promise<void | boolean>;
      onRefetch?: (timestamp: string) => void;
    };

interface FlightState {
  inFlight: boolean;
  trailing: boolean;
}

const log = createLogger('sync');

function createConversationLease(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class SyncClient {
  private readonly conn: WsConnectionManager;
  private readonly resources = new Map<SyncResourceKey, SyncResourceRegistration>();
  private readonly conversations = new Map<ConversationSessionId, { callbacks: Set<() => Promise<void>>; lease: string | null }>();
  private readonly flights = new Map<string, FlightState>();
  private readonly resourceStoreBaselineOpenPending = new Set<Exclude<SyncResourceKey, 'cards'>>();
  private started = false;
  private cardsBaselineOpenPending = true;

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
      this.handleResourceOpen();
      const cards = this.resources.get('cards');
      if (this.cardsBaselineOpenPending) this.cardsBaselineOpenPending = false;
      else if (cards?.resource === 'cards') cards.onReconnect();
      this.resubscribeConversations();
    });
    this.conn.onSyncFrame((frame) => this.handleSyncFrame(frame));
    this.conn.onEvent((envelope) => {
      this.lastEventAtRef.value = new Date().toISOString();
      const restartAcknowledgement = parseAnalystTurnAcknowledgedStatusContent(envelope.content);
      if (restartAcknowledgement) {
        useAnalystChat().ingestRestartAcknowledgement(restartAcknowledgement.restart);
        return;
      }
      if (isAnalystActivityContent(envelope.content)) useAnalystChat().ingestWsEvent(envelope.content);
    });
    this.conn.connect();
  }

  stop(): void {
    this.conn.disconnect();
    this.connectionStateRef.value = 'offline';
    this.lastConnectedAtRef.value = null;
  }

  reconfigure(): void {
    this.cardsBaselineOpenPending = true;
    for (const registration of this.resources.values()) {
      if (registration.resource !== 'cards' && registration.requestOwnership === 'resource-store') {
        this.resourceStoreBaselineOpenPending.add(registration.resource);
      }
    }
    this.conn.reconfigure();
  }

  register(registration: SyncResourceRegistration): () => void {
    this.resources.set(registration.resource, registration);
    if (registration.resource !== 'cards') {
      this.resourceStoreBaselineOpenPending.delete(registration.resource);
      if (registration.requestOwnership === 'sync-client' && this.conn.state.value === 'connected') this.refetchResource(registration.resource);
      if (registration.requestOwnership === 'resource-store' && this.conn.state.value !== 'connected') this.resourceStoreBaselineOpenPending.add(registration.resource);
    }
    return () => {
      const current = this.resources.get(registration.resource);
      if (current === registration) {
        this.resources.delete(registration.resource);
        if (registration.resource !== 'cards') this.resourceStoreBaselineOpenPending.delete(registration.resource);
      }
    };
  }

  openConversation(sessionId: ConversationSessionId, refetch: () => Promise<void>): () => void {
    const entry = this.conversations.get(sessionId) ?? { callbacks: new Set(), lease: null };
    entry.callbacks.add(refetch);
    this.conversations.set(sessionId, entry);
    if (entry.callbacks.size === 1 && this.conn.state.value === 'connected') this.subscribeConversation(sessionId, entry);
    return () => this.closeConversation(sessionId, refetch);
  }

  closeConversation(sessionId: ConversationSessionId, refetch?: () => Promise<void>): void {
    const entry = this.conversations.get(sessionId);
    if (!entry) return;
    if (refetch) entry.callbacks.delete(refetch); else entry.callbacks.clear();
    if (entry.callbacks.size > 0) return;
    this.conversations.delete(sessionId);
    if (entry.lease) this.conn.sendRaw({ t: 'unsubscribe', resource: 'conversation', id: sessionId, lease: entry.lease });
  }

  sendMessage(text: string): void {
    this.conn.sendMessage(text);
  }

  private handleSyncFrame(frame: LiveSyncInvalidateFrame | LiveSyncSubscribedFrame): void {
    const timestamp = new Date().toISOString();
    this.lastEventAtRef.value = timestamp;
    if (frame.t === 'subscribed') {
      const entry = this.conversations.get(frame.id);
      if (entry?.lease === frame.lease) this.refetchConversation(frame.id);
      return;
    }
    if (frame.resource === 'conversation') {
      this.refetchConversation(frame.id);
      return;
    }
    if (frame.resource === 'cards') {
      const registration = this.resources.get('cards');
      if (registration?.resource === 'cards') registration.onInvalidate(frame);
      return;
    }
    this.refetchResource(frame.resource, timestamp);
  }

  private handleResourceOpen(): void {
    for (const registration of this.resources.values()) {
      if (registration.resource === 'cards') continue;
      if (registration.requestOwnership === 'resource-store' && this.resourceStoreBaselineOpenPending.delete(registration.resource)) continue;
      this.refetchResource(registration.resource);
    }
  }

  private resubscribeConversations(): void {
    for (const [id, entry] of this.conversations) this.subscribeConversation(id, entry);
  }

  private refetchResource(resource: SyncResourceKey, invalidatedAt?: string): void {
    const registration = this.resources.get(resource);
    if (!registration) return;
    if (registration.resource === 'cards') return;
    if (registration.requestOwnership === 'sync-client') {
      this.runSingleFlight(resource, registration.refetch, invalidatedAt, registration.onRefetch);
      return;
    }
    void registration.refetch()
      .then((completed) => {
        if (invalidatedAt && completed !== false) registration.onRefetch?.(invalidatedAt);
      })
      .catch((error) => log.warn(`Sync refetch failed for ${resource}`, error));
  }

  private refetchConversation(sessionId: ConversationSessionId): void {
    const entry = this.conversations.get(sessionId);
    if (!entry) return;
    this.runSingleFlight(`conversation:${sessionId}`, async () => {
      await Promise.all([...entry.callbacks].map(async (callback) => {
        try { await callback(); } catch (error) { log.warn(`Conversation refetch failed for ${sessionId}`, error); }
      }));
    });
  }

  private subscribeConversation(id: string, entry: { callbacks: Set<() => Promise<void>>; lease: string | null }): void {
    entry.lease = createConversationLease();
    this.conn.sendRaw({ t: 'subscribe', resource: 'conversation', id, lease: entry.lease });
  }

  private runSingleFlight(key: string, refetch: () => Promise<void | boolean>, refetchedAt?: string, onRefetch?: (timestamp: string) => void): void {
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
