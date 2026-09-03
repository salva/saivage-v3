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

export type ReconnectResourceKey = LiveSyncUnscopedResource | 'files';
export type SyncResourceKey = ReconnectResourceKey | 'cards';
type LeaseResource = 'agents' | 'card-agent-sessions' | 'conversation' | 'llm-exchange';
export type LeaseInvalidation = Extract<
  LiveSyncInvalidateFrame,
  { resource: 'agent-membership' | 'conversation' | 'llm-exchange' }
> | null;
export type ConversationInvalidation = Extract<LiveSyncInvalidateFrame, { resource: 'conversation' }> | null;

export type SyncResourceRegistration =
  | {
      resource: 'cards';
      onInvalidate: (target: LiveSyncCardInvalidateTarget) => void;
      onReconnect: () => void;
    }
  | {
      resource: Exclude<SyncResourceKey, 'cards'>;
      refetch: () => Promise<void>;
    };

interface FlightState {
  inFlight: boolean;
  trailing?: () => Promise<void>;
}

type LeaseCallback = (frame: LeaseInvalidation) => Promise<void>;

interface LeaseConsumer {
  callback: LeaseCallback;
  acknowledgedGeneration: number | null;
}

interface LeaseEntry {
  resource: LeaseResource;
  id?: string;
  consumers: Set<LeaseConsumer>;
  lease: string | null;
  acknowledged: boolean;
  inFlight: boolean;
  trailingFrame: Exclude<LeaseInvalidation, null> | undefined;
  generation: number;
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
  private readonly leases = new Map<string, LeaseEntry>();
  private readonly flights = new Map<string, FlightState>();
  private started = false;
  private cardsBaselineOpenPending = true;

  private readonly connectionStateRef: ReturnType<typeof ref<WsConnectionState>>;

  readonly connectionState: Readonly<ReturnType<typeof ref<WsConnectionState>>>;

  constructor(conn: WsConnectionManager = getWsConnection()) {
    this.conn = conn;
    this.connectionStateRef = ref<WsConnectionState>(conn.state.value);
    this.connectionState = readonly(this.connectionStateRef);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.conn.onState((state) => {
      this.connectionStateRef.value = state;
    });
    this.conn.onOpen(() => {
      this.handleResourceOpen();
      const cards = this.resources.get('cards');
      if (this.cardsBaselineOpenPending) this.cardsBaselineOpenPending = false;
      else if (cards?.resource === 'cards') cards.onReconnect();
      this.resubscribeLeases();
    });
    this.conn.onSyncFrame((frame) => this.handleSyncFrame(frame));
    this.conn.onEvent((envelope) => {
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

  reconfigure(): void {
    this.cardsBaselineOpenPending = true;
    this.conn.reconfigure();
  }

  register(registration: SyncResourceRegistration): () => void {
    this.resources.set(registration.resource, registration);
    if (registration.resource !== 'cards' && this.conn.state.value === 'connected')
      this.refetchResource(registration.resource);
    return () => {
      const current = this.resources.get(registration.resource);
      if (current === registration) {
        this.resources.delete(registration.resource);
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
    callback: (frame: ConversationInvalidation) => Promise<void>,
  ): () => void {
    return this.openLease('conversation', sessionId, async (frame) => {
      if (frame !== null && frame.resource !== 'conversation') throw new Error('Conversation lease received a non-conversation invalidation.');
      await callback(frame);
    });
  }
  openLlmExchange(
    sessionId: ConversationSessionId,
    callback: (frame: LeaseInvalidation) => Promise<void>,
  ): () => void {
    return this.openLease('llm-exchange', sessionId, callback);
  }

  private handleSyncFrame(frame: LiveSyncInvalidateFrame | LiveSyncSubscribedFrame): void {
    if (frame.t === 'subscribed') {
      const key = leaseKey(frame.resource, 'id' in frame ? frame.id : undefined);
      const entry = this.leases.get(key);
      if (entry?.lease === frame.lease && !entry.acknowledged) {
        entry.acknowledged = true;
        this.drainLease(key, entry, entry.generation);
      }
      return;
    }
    if (frame.resource === 'conversation' || frame.resource === 'llm-exchange') {
      const key = leaseKey(frame.resource, frame.id);
      const entry = this.leases.get(key);
      if (entry) this.queueLeaseFrame(key, entry, frame);
      return;
    }
    if (frame.resource === 'agent-membership') {
      const global = this.leases.get('agents');
      if (global) this.queueLeaseFrame('agents', global, frame);
      if (frame.scope === 'card') {
        const key = leaseKey('card-agent-sessions', frame.card_id);
        const card = this.leases.get(key);
        if (card) this.queueLeaseFrame(key, card, frame);
      }
      return;
    }
    if (frame.resource === 'cards') {
      const registration = this.resources.get('cards');
      if (registration?.resource === 'cards') registration.onInvalidate(frame);
      return;
    }
    if (frame.resource === 'runtime' || frame.resource === 'timeline')
      this.refetchResource(frame.resource);
  }

  private handleResourceOpen(): void {
    for (const registration of this.resources.values()) {
      if (registration.resource === 'cards') continue;
      this.refetchResource(registration.resource);
    }
  }

  private resubscribeLeases(): void {
    for (const entry of this.leases.values()) {
      this.subscribeLease(entry);
    }
  }

  private refetchResource(resource: SyncResourceKey): void {
    const registration = this.resources.get(resource);
    if (!registration) return;
    if (registration.resource === 'cards') return;
    this.runSingleFlight(resource, registration.refetch);
  }

  private openLease(
    resource: LeaseResource,
    id: string | undefined,
    callback: (frame: LeaseInvalidation) => Promise<void>,
  ): () => void {
    const key = leaseKey(resource, id);
    const entry: LeaseEntry = this.leases.get(key) ?? {
      resource,
      id,
      consumers: new Set(),
      lease: null,
      acknowledged: false,
      inFlight: false,
      trailingFrame: undefined,
      generation: 0,
    };
    const consumer: LeaseConsumer = { callback, acknowledgedGeneration: null };
    entry.consumers.add(consumer);
    this.leases.set(key, entry);
    if (entry.consumers.size === 1 && this.conn.state.value === 'connected')
      this.subscribeLease(entry);
    else if (entry.acknowledged)
      this.drainLease(key, entry, entry.generation);
    return () => {
      const current = this.leases.get(key);
      if (current !== entry) return;
      current.consumers.delete(consumer);
      if (current.consumers.size > 0) return;
      this.leases.delete(key);
      if (current.lease)
        this.conn.sendRaw(
          current.id === undefined
            ? { t: 'unsubscribe', resource: 'agents', lease: current.lease }
            : {
                t: 'unsubscribe',
                resource: current.resource as Exclude<LeaseResource, 'agents'>,
                id: current.id,
                lease: current.lease,
              },
        );
    };
  }
  private subscribeLease(entry: LeaseEntry): void {
    entry.generation += 1;
    entry.lease = createConversationLease();
    entry.acknowledged = false;
    entry.inFlight = false;
    entry.trailingFrame = undefined;
    this.conn.sendRaw(
      entry.id === undefined
        ? { t: 'subscribe', resource: 'agents', lease: entry.lease }
        : {
            t: 'subscribe',
            resource: entry.resource as Exclude<LeaseResource, 'agents'>,
            id: entry.id,
            lease: entry.lease,
          },
    );
  }
  private queueLeaseFrame(
    key: string,
    entry: LeaseEntry,
    frame: Exclude<LeaseInvalidation, null>,
  ): void {
    if (
      frame.resource === 'conversation' &&
      entry.trailingFrame?.resource === 'conversation' &&
      frame.segment_version < entry.trailingFrame.segment_version
    ) return;
    entry.trailingFrame = frame;
    this.drainLease(key, entry, entry.generation);
  }

  private drainLease(key: string, entry: LeaseEntry, generation: number): void {
    if (
      this.leases.get(key) !== entry ||
      entry.generation !== generation ||
      !entry.acknowledged ||
      entry.inFlight
    ) return;

    const pendingAcknowledgements = [...entry.consumers].filter(
      (consumer) => consumer.acknowledgedGeneration !== generation,
    );
    if (pendingAcknowledgements.length > 0) {
      entry.inFlight = true;
      const callbacks = pendingAcknowledgements.flatMap((consumer) => {
        if (
          this.leases.get(key) !== entry ||
          entry.generation !== generation ||
          !entry.acknowledged ||
          !entry.consumers.has(consumer) ||
          consumer.acknowledgedGeneration === generation
        ) return [];
        consumer.acknowledgedGeneration = generation;
        return [this.invokeLeaseCallback(consumer.callback, null)];
      });
      this.settleLeaseBatch(key, entry, generation, callbacks);
      return;
    }

    const frame = entry.trailingFrame;
    if (frame === undefined) return;
    entry.trailingFrame = undefined;
    entry.inFlight = true;
    const callbacks = [...entry.consumers].flatMap((consumer) => {
      if (
        this.leases.get(key) !== entry ||
        entry.generation !== generation ||
        !entry.acknowledged ||
        !entry.consumers.has(consumer) ||
        consumer.acknowledgedGeneration !== generation
      ) return [];
      return [this.invokeLeaseCallback(consumer.callback, frame)];
    });
    this.settleLeaseBatch(key, entry, generation, callbacks);
  }

  private invokeLeaseCallback(
    callback: LeaseCallback,
    frame: LeaseInvalidation,
  ): Promise<void> {
    try {
      return callback(frame);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private settleLeaseBatch(
    key: string,
    entry: LeaseEntry,
    generation: number,
    callbacks: Promise<void>[],
  ): void {
    void Promise.all(
      callbacks.map(async (callback) => {
        try {
          await callback;
        } catch (error) {
          log.warn(`Lease refresh failed for ${key}`, error);
        }
      }),
    ).finally(() => {
      if (this.leases.get(key) !== entry || entry.generation !== generation) return;
      entry.inFlight = false;
      this.drainLease(key, entry, generation);
    });
  }

  private runSingleFlight(
    key: string,
    refetch: () => Promise<void>,
  ): void {
    const state = this.flights.get(key) ?? { inFlight: false };
    this.flights.set(key, state);
    if (state.inFlight) {
      state.trailing = refetch;
      return;
    }
    state.inFlight = true;
    void refetch()
      .catch((err) => log.warn(`Sync refetch failed for ${key}`, err))
      .finally(() => {
        state.inFlight = false;
        const trailing = state.trailing;
        state.trailing = undefined;
        if (trailing) {
          this.runSingleFlight(key, trailing);
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
