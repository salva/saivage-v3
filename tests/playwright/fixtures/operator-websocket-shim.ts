import type { Page } from '@playwright/test';
import {
  buildConnectedEnvelope,
  parseKnownWsEnvelope,
  wsContractFixtures,
  type WsEnvelope,
} from '../../../src/contracts/operator-events.js';

const connectedEnvelope = buildConnectedEnvelope({
  sessionId: 'synthetic-ws-session',
  timestamp: '2026-05-19T12:00:00.000Z',
  clientCount: 1,
});
const runtimeUpdateEnvelope = parseKnownWsEnvelope({
  type: 'status',
  content: {
    event: 'runtime-state',
    runtime: {
      status: 'running',
      project_id: 'project',
      pid: 4242,
      started_at: '2026-05-19T12:00:00.000Z',
      current_card_id: 'card-smoke',
      current_agent_session_id: 'planner-smoke',
      paused: false,
      paused_at: null,
      queue: ['card-next'],
      running_processes: ['proc-smoke'],
      updated_at: '2026-05-19T12:01:00.000Z',
      runtime_intent: { status: 'running', updated_at: '2026-05-19T12:01:00.000Z', source_command_id: null, reason: null },
      runtime_commands: [],
      runtime_runs: [],
      runtime_activations: [],
    },
    cardIndex: { total: 3, byStatus: { running: 2, done: 1 }, byType: { project: 1, code: 2 } },
  },
}) as WsEnvelope;
const cardChangedEnvelope = parseKnownWsEnvelope({
  type: 'status',
  content: {
    event: 'card-status-changed',
    card: { id: 'card-smoke', status: 'running', type: 'code', title: 'Synthetic dashboard smoke card' },
  },
}) as WsEnvelope;

export async function installOperatorWebSocketShim(page: Page): Promise<void> {
  await page.addInitScript(({ connected, runtimeUpdate, cardChanged, inboundFixture }) => {
    type Listener = (event: Event) => void;
    type FixtureEnvelope = { type: string; content: Record<string, unknown> };

    const NativeWebSocket = window.WebSocket;
    const sockets: Array<SaivageFixtureWebSocket> = [];
    const outbound: string[] = [];

    class FixtureMessageEvent extends Event {
      data: string;
      constructor(data: string) {
        super('message');
        this.data = data;
      }
    }

    class SaivageFixtureWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSING = 2;
      readonly CLOSED = 3;
      readonly url: string;
      readonly protocol = '';
      readonly extensions = '';
      binaryType: BinaryType = 'blob';
      bufferedAmount = 0;
      readyState = SaivageFixtureWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      private readonly listenerMap = new Map<string, Set<Listener>>();

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        const parsed = new URL(this.url, window.location.href);
        if (parsed.pathname !== '/ws') {
          return new NativeWebSocket(url) as unknown as SaivageFixtureWebSocket;
        }
        sockets.push(this);
        window.setTimeout(() => {
          if (this.readyState !== SaivageFixtureWebSocket.CONNECTING) return;
          this.readyState = SaivageFixtureWebSocket.OPEN;
          this.dispatchSynthetic('open', new Event('open'));
          this.emit(connected as FixtureEnvelope);
        }, 0);
      }

      override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
        if (!listener) return;
        const fn: Listener = typeof listener === 'function' ? listener : (event) => listener.handleEvent(event);
        if (!this.listenerMap.has(type)) this.listenerMap.set(type, new Set());
        this.listenerMap.get(type)?.add(fn);
      }

      override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
        if (!listener) return;
        const fn: Listener = typeof listener === 'function' ? listener : (event) => listener.handleEvent(event);
        this.listenerMap.get(type)?.delete(fn);
      }

      override dispatchEvent(event: Event): boolean {
        this.dispatchSynthetic(event.type, event);
        return true;
      }

      send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
        outbound.push(typeof data === 'string' ? data : '[binary]');
      }

      close(code = 1000, reason = 'Fixture close'): void {
        if (this.readyState === SaivageFixtureWebSocket.CLOSED) return;
        this.readyState = SaivageFixtureWebSocket.CLOSING;
        window.setTimeout(() => {
          this.readyState = SaivageFixtureWebSocket.CLOSED;
          const event = new CloseEvent('close', { code, reason, wasClean: true });
          this.dispatchSynthetic('close', event);
        }, 0);
      }

      emit(envelope: FixtureEnvelope): void {
        if (this.readyState !== SaivageFixtureWebSocket.OPEN) return;
        this.dispatchSynthetic('message', new FixtureMessageEvent(JSON.stringify(envelope)) as MessageEvent);
      }

      private dispatchSynthetic(type: string, event: Event): void {
        const propertyHandler = this[`on${type}` as 'onopen' | 'onmessage' | 'onerror' | 'onclose'];
        if (typeof propertyHandler === 'function') propertyHandler.call(this, event as never);
        for (const listener of this.listenerMap.get(type) ?? []) listener.call(this, event);
      }
    }

    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      writable: true,
      value: SaivageFixtureWebSocket,
    });

    window.__saivageWsFixture = {
      sockets,
      outbound,
      connectedEnvelope: connected as FixtureEnvelope,
      inboundAnalystFixture: inboundFixture as FixtureEnvelope,
      emitRuntimeUpdate() {
        for (const socket of sockets) socket.emit(runtimeUpdate as FixtureEnvelope);
      },
      emitCardChanged() {
        for (const socket of sockets) socket.emit(cardChanged as FixtureEnvelope);
      },
      emit(envelope: FixtureEnvelope) {
        for (const socket of sockets) socket.emit(envelope);
      },
      closeAll() {
        for (const socket of sockets) socket.close(1000, 'Fixture closeAll');
      },
    };
  }, {
    connected: connectedEnvelope,
    runtimeUpdate: runtimeUpdateEnvelope,
    cardChanged: cardChangedEnvelope,
    inboundFixture: wsContractFixtures.inboundAnalystMessage,
  });
}

declare global {
  interface Window {
    __saivageWsFixture?: {
      sockets: unknown[];
      outbound: string[];
      connectedEnvelope: unknown;
      inboundAnalystFixture: unknown;
      emitRuntimeUpdate(): void;
      emitCardChanged(): void;
      emit(envelope: unknown): void;
      closeAll(): void;
    };
  }
}
