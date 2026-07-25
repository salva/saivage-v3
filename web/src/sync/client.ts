import { readonly, ref } from 'vue';
import { getWsConnection, type WsConnectionManager } from '../api/websocket';
import type {
  LiveSyncCardInvalidateTarget,
  LiveSyncInvalidateFrame,
  LiveSyncSubscribedFrame,
  LiveSyncUnscopedResource,
  WsConnectionState,
} from '../api/types';
import {
  isAnalystActivityContent,
  parseAnalystTurnAcknowledgedStatusContent,
  type ConversationSessionId,
} from '../api/contracts';
import { useAnalystChat } from '../stores/analystChat';
import { createLogger } from '../utils/logger';

export type SyncResourceScope = 'core' | 'active';
export type SyncResourceKey = LiveSyncUnscopedResource | 'cards';
type LeaseResource = 'agents' | 'card-agent-sessions' | 'conversation' | 'llm-exchange';
export type LeaseInvalidation = Extract<
  LiveSyncInvalidateFrame,
  { resource: 'agent-membership' | 'conversation' | 'llm-exchange' }
> | null;

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
  private readonly leases = new Map<
    string,
    {
      resource: LeaseResource;
      id?: string;
      callbacks: Set<(frame: LeaseInvalidation) => Promise<void>>;
      lease: string | null;
      acknowledged: boolean;
      inFlight: boolean;
      trailingFrame: LeaseInvalidation | undefined;
      generation: number;
    }
  >();
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
      this.resubscribeLeases();
    });
    this.conn.onSyncFrame((frame) => this.handleSyncFrame(frame));
    this.conn.onEvent((envelope) => {
      this.lastEventAtRef.value = new Date().toISOString();
      const restartAcknowledgement = parseAnalystTurnAcknowledgedStatusContent(envelope.content);
      if (restartAcknowledgement) {
        useAnalystChat().ingestRestartAcknowledgement(restartAcknowledgement.restart);
        return;
      }
      if (isAnalystActivityContent(envelope.content))
        useAnalystChat().ingestWsEvent(envelope.content);
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
      if (registration.requestOwnership === 'sync-client' && this.conn.state.value === 'connected')
        this.refetchResource(registration.resource);
      if (
        registration.requestOwnership === 'resource-store' &&
        this.conn.state.value !== 'connected'
      )
        this.resourceStoreBaselineOpenPending.add(registration.resource);
    }
    return () => {
      const current = this.resources.get(registration.resource);
      if (current === registration) {
        this.resources.delete(registration.resource);
        if (registration.resource !== 'cards')
          this.resourceStoreBaselineOpenPending.delete(registration.resource);
      }
    };
  }

  openAgents(callback: (frame: LeaseInvalidation) => Promise<void>): () => void {
    return this.openLease('agents', undefined, callback);
  }
  openCardAgentSessions(
    cardId: string,
    callback: (frame: LeaseInvalidation) => Promise<void>,
  ): () => void {
    return this.openLease('card-agent-sessions', cardId, callback);
  }
  openConversation(
    sessionId: ConversationSessionId,
    callback: (frame: LeaseInvalidation) => Promise<void>,
  ): () => void {
    return this.openLease('conversation', sessionId, callback);
  }
  openLlmExchange(
    sessionId: ConversationSessionId,
    callback: (frame: LeaseInvalidation) => Promise<void>,
  ): () => void {
    return this.openLease('llm-exchange', sessionId, callback);
  }

  sendMessage(text: string): void {
    this.conn.sendMessage(text);
  }

  private handleSyncFrame(frame: LiveSyncInvalidateFrame | LiveSyncSubscribedFrame): void {
    const timestamp = new Date().toISOString();
    this.lastEventAtRef.value = timestamp;
    if (frame.t === 'subscribed') {
      const key = leaseKey(frame.resource, 'id' in frame ? frame.id : undefined);
      const entry = this.leases.get(key);
      if (entry?.lease === frame.lease && !entry.acknowledged) {
        entry.acknowledged = true;
        this.runLease(key, entry, null);
      }
      return;
    }
    if (frame.resource === 'conversation' || frame.resource === 'llm-exchange') {
      const key = leaseKey(frame.resource, frame.id);
      const entry = this.leases.get(key);
      if (entry) this.runLease(key, entry, frame);
      return;
    }
    if (frame.resource === 'agent-membership') {
      const global = this.leases.get('agents');
      if (global) this.runLease('agents', global, frame);
      if (frame.scope === 'card') {
        const key = leaseKey('card-agent-sessions', frame.card_id);
        const card = this.leases.get(key);
        if (card) this.runLease(key, card, frame);
      }
      return;
    }
    if (frame.resource === 'cards') {
      const registration = this.resources.get('cards');
      if (registration?.resource === 'cards') registration.onInvalidate(frame);
      return;
    }
    if (
      frame.resource === 'runtime' ||
      frame.resource === 'timeline' ||
      frame.resource === 'processes' ||
      frame.resource === 'files'
    )
      this.refetchResource(frame.resource, timestamp);
  }

  private handleResourceOpen(): void {
    for (const registration of this.resources.values()) {
      if (registration.resource === 'cards') continue;
      if (
        registration.requestOwnership === 'resource-store' &&
        this.resourceStoreBaselineOpenPending.delete(registration.resource)
      )
        continue;
      this.refetchResource(registration.resource);
    }
  }

  private resubscribeLeases(): void {
    for (const [key, entry] of this.leases) {
      entry.acknowledged = false;
      entry.lease = null;
      entry.inFlight = false;
      entry.trailingFrame = undefined;
      this.subscribeLease(key, entry);
    }
  }

  private refetchResource(resource: SyncResourceKey, invalidatedAt?: string): void {
    const registration = this.resources.get(resource);
    if (!registration) return;
    if (registration.resource === 'cards') return;
    if (registration.requestOwnership === 'sync-client') {
      this.runSingleFlight(resource, registration.refetch, invalidatedAt, registration.onRefetch);
      return;
    }
    void registration
      .refetch()
      .then((completed) => {
        if (invalidatedAt && completed !== false) registration.onRefetch?.(invalidatedAt);
      })
      .catch((error) => log.warn(`Sync refetch failed for ${resource}`, error));
  }

  private openLease(
    resource: LeaseResource,
    id: string | undefined,
    callback: (frame: LeaseInvalidation) => Promise<void>,
  ): () => void {
    const key = leaseKey(resource, id);
    const entry = this.leases.get(key) ?? {
      resource,
      id,
      callbacks: new Set(),
      lease: null,
      acknowledged: false,
      inFlight: false,
      trailingFrame: undefined,
      generation: 0,
    };
    entry.callbacks.add(callback);
    this.leases.set(key, entry);
    if (entry.callbacks.size === 1 && this.conn.state.value === 'connected')
      this.subscribeLease(key, entry);
    return () => {
      const current = this.leases.get(key);
      if (current !== entry) return;
      current.callbacks.delete(callback);
      if (current.callbacks.size > 0) return;
      this.leases.delete(key);
      if (current.lease)
        this.conn.sendRaw(
          current.id === undefined
            ? { t: 'unsubscribe', resource: 'agents', lease: current.lease }
            : {
                t: 'unsubscribe',
                resource: current.resource as 'conversation',
                id: current.id,
                lease: current.lease,
              },
        );
    };
  }
  private subscribeLease(
    _key: string,
    entry: {
      resource: LeaseResource;
      id?: string;
      lease: string | null;
      acknowledged: boolean;
      generation: number;
    },
  ): void {
    entry.generation += 1;
    entry.lease = createConversationLease();
    entry.acknowledged = false;
    this.conn.sendRaw(
      entry.id === undefined
        ? { t: 'subscribe', resource: 'agents', lease: entry.lease }
        : {
            t: 'subscribe',
            resource: entry.resource as 'conversation',
            id: entry.id,
            lease: entry.lease,
          },
    );
  }
  private runLease(
    key: string,
    entry: {
      callbacks: Set<(frame: LeaseInvalidation) => Promise<void>>;
      acknowledged: boolean;
      inFlight: boolean;
      trailingFrame: LeaseInvalidation | undefined;
      generation: number;
    },
    frame: LeaseInvalidation,
  ): void {
    if (!entry.acknowledged || entry.inFlight) {
      entry.trailingFrame = frame;
      return;
    }
    const generation = entry.generation;
    entry.inFlight = true;
    void Promise.all(
      [...entry.callbacks].map(async (callback) => {
        try {
          await callback(frame);
        } catch (error) {
          log.warn(`Lease refresh failed for ${key}`, error);
        }
      }),
    ).finally(() => {
      if (this.leases.get(key) !== entry || entry.generation !== generation) return;
      entry.inFlight = false;
      if (entry.trailingFrame !== undefined) {
        const trailing = entry.trailingFrame;
        entry.trailingFrame = undefined;
        this.runLease(key, entry, trailing);
      }
    });
  }

  private runSingleFlight(
    key: string,
    refetch: () => Promise<void | boolean>,
    refetchedAt?: string,
    onRefetch?: (timestamp: string) => void,
  ): void {
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

function leaseKey(resource: LeaseResource, id?: string): string {
  return id === undefined ? resource : `${resource}\u0000${id}`;
}

export const syncClient = new SyncClient();
