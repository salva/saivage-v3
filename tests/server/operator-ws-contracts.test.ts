import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import { operatorBroadcastEventKindValues } from '../../src/events/registry.js';
import { loggedEventSchema } from '../../src/schemas/validators.js';
import { EventLogger } from '../../src/observability/event-logger.js';
import {
  AnalystActivityEventNames,
  InboundAnalystMessageEnvelopeSchema,
  buildConnectedEnvelope,
  buildInboundAnalystMessageEnvelope,
  buildRuntimeFanoutEnvelope,
  isAnalystActivityContent,
  isConnectedEnvelope,
  isRuntimeFanoutContent,
  knownRuntimeFanoutEventNames,
  parseKnownWsContent,
  parseKnownWsEnvelope,
  parseWsEnvelope,
  validateKnownWsEnvelope,
  wsContractFixtures,
} from '../../src/contracts/operator-events.js';
import { createRuntimeEnvelope, wireRuntimeEvents, resetRuntimeEventSubscriptions } from '../../src/server/websocket.js';

describe('operator websocket shared contract registry', () => {
  it('parses base-valid unknown envelopes without treating them as known', () => {
    const envelope = { type: 'activity', content: { event: 'future_event', payload: true } };

    expect(parseWsEnvelope(envelope)).toEqual(envelope);
    expect(parseKnownWsEnvelope(envelope)).toBeNull();
    expect(validateKnownWsEnvelope(envelope as any)).toEqual(envelope);
  });

  it('rejects malformed recognized content events', () => {
    expect(() => parseKnownWsEnvelope(wsContractFixtures.malformedKnown)).toThrow();
    expect(() => validateKnownWsEnvelope(wsContractFixtures.malformedKnown)).toThrow();
  });



  it('accepts runtime-state events with optional CardStore health and without it', () => {
    const withHealth = {
      type: 'status',
      content: {
        event: 'runtime-state',
        cardStoreHealth: {
          canonical: 'ok',
        },
      },
    };
    expect(parseKnownWsEnvelope(withHealth)?.content.event).toBe('runtime-state');
    expect(parseKnownWsEnvelope({ type: 'status', content: { event: 'runtime-state' } })?.content.event).toBe('runtime-state');
    expect(parseKnownWsEnvelope({ type: 'status', content: { event: 'runtime-state', serverAvailability: { generatedAt: '2026-01-01T00:00:02.000Z', components: { api: { state: 'available', source: 'health-check', checkedAt: '2026-01-01T00:00:02.000Z' }, runtime: { state: 'unknown', source: 'unknown', checkedAt: '2026-01-01T00:00:02.000Z' }, mcp: { state: 'unavailable', source: 'startup', checkedAt: '2026-01-01T00:00:02.000Z', diagnostic: { code: 'mcp-manager-start-failed', summary: 'Error: synthetic redacted startup failure' } } } } } })?.content.event).toBe('runtime-state');
  });

  it('builds fixture-worthy connected and inbound analyst message envelopes', () => {
    const connected = buildConnectedEnvelope({ sessionId: 'session-1', timestamp: '2025-01-01T00:00:00.000Z', clientCount: 2 });
    expect(isConnectedEnvelope(connected)).toBe(true);
    expect(connected).toEqual({
      type: 'status',
      content: { event: 'connected', sessionId: 'session-1', timestamp: '2025-01-01T00:00:00.000Z', clientCount: 2 },
    });

    const outbound = buildInboundAnalystMessageEnvelope('hello');
    expect(InboundAnalystMessageEnvelopeSchema.parse(outbound).content.text).toBe('hello');
    expect(() => buildInboundAnalystMessageEnvelope('')).toThrow();
  });

  it('covers analyst activity event predicates through the shared tuple', () => {
    expect(AnalystActivityEventNames).toContain('card_history_appended');
    expect(isAnalystActivityContent({ event: 'card_history_appended', card_id: 'card-1', version_seq: 1, changed_fields: ['status'], changed_at: 'now' })).toBe(true);
    expect(isAnalystActivityContent({ event: 'card_history_appended' })).toBe(false);
  });


  it('distinguishes planner-state events from runtime execution events and rejects queue aliases', () => {
    const command = {
      command_id: 'cmd-1',
      command: 'start_project',
      status: 'completed',
      requested_at: '2026-01-01T00:00:00.000Z',
      completed_at: '2026-01-01T00:00:01.000Z',
      source: 'operator',
      error: null,
    };
    const run = {
      run_id: 'run-1',
      kind: 'root',
      card_id: 'project',
      command_id: 'cmd-1',
      parent_run_id: null,
      activation_id: null,
      phase: 'planner',
      runtime_status: 'running',
      session_id: 'planner:project',
      started_at: '2026-01-01T00:00:01.000Z',
      updated_at: '2026-01-01T00:00:01.000Z',
      finished_at: null,
      result: null,
    };
    expect(parseKnownWsEnvelope({ type: 'activity', content: { event: 'runtime.command', command } })?.content.event).toBe('runtime.command');
    expect(parseKnownWsEnvelope({ type: 'status', content: { event: 'runtime.run', run } })?.content.event).toBe('runtime.run');
    expect(parseKnownWsEnvelope({ type: 'status', content: { event: 'card.planner_state_changed', card: { id: 'goal-1', planner_state: 'active' } } })?.content.event).toBe('card.planner_state_changed');
    expect(parseKnownWsEnvelope({ type: 'activity', content: { event: 'runtime.queue', queue: ['goal-1'] } })).toBeNull();
  });


  it('maps persisted runtime ledger events to validated websocket envelopes', () => {
    const saivageDir = mkdtempSync(join(tmpdir(), 'saivage-runtime-ledger-'));
    const logger = new EventLogger(saivageDir);
    try {
      const command = { command_id: 'cmd-1', command: 'start_project' as const, status: 'completed' as const, requested_at: '2026-01-01T00:00:00.000Z', completed_at: '2026-01-01T00:00:01.000Z', source: 'operator' as const, error: null };
      const run = { run_id: 'run-1', kind: 'root' as const, card_id: 'project', command_id: 'cmd-1', parent_run_id: null, activation_id: null, phase: 'planner' as const, runtime_status: 'running' as const, session_id: null, started_at: '2026-01-01T00:00:01.000Z', updated_at: '2026-01-01T00:00:01.000Z', finished_at: null, result: null };
      const activation = { activation_id: 'act-1', idempotency_key: 'key-1', parent_card_id: 'goal-a', parent_run_id: 'run-parent', parent_session_id: 'planner:goal-a', parent_tool_call_id: 'call-a', child_card_id: 'code-a', status: 'pending' as const, requested_at: '2026-01-01T00:00:02.000Z', updated_at: '2026-01-01T00:00:02.000Z', precondition: 'accepted' as const, runtime_run_id: 'run-child', error: null };
      const actionable_error = { code: 'runtime_start_precondition_failed', message: 'Project runtime is already running or paused.', currentState: { intent: 'running', paused: false }, nextAction: 'Use stop_project before starting again.', docsRef: 'docs/operator-runbook.md', runId: null, sessionId: null, cardId: 'project' };

      logger.appendEvent({ kind: 'runtime_command', command, timestamp: '2026-01-01T00:00:00.000Z' });
      logger.appendEvent({ kind: 'runtime_run', run, timestamp: '2026-01-01T00:00:01.000Z' });
      logger.appendEvent({ kind: 'runtime_activation', activation, timestamp: '2026-01-01T00:00:02.000Z' });
      logger.appendEvent({ kind: 'runtime_actionable_error', actionable_error, timestamp: '2026-01-01T00:00:03.000Z' });

      const events = logger.getEvents();
      for (const event of events) expect(loggedEventSchema.parse(event)).toEqual(event);

      const envelopes = events.map(({ kind, id, timestamp, ...data }) => createRuntimeEnvelope(kind, data));
      expect(parseKnownWsEnvelope(envelopes[0])?.content).toEqual({ event: 'runtime.command', command });
      expect(parseKnownWsEnvelope(envelopes[1])?.content).toEqual({ event: 'runtime.run', run });
      expect(parseKnownWsEnvelope(envelopes[2])?.content).toEqual({ event: 'runtime.activation', activation });
      expect(parseKnownWsEnvelope(envelopes[3])?.content).toEqual({ event: 'runtime.actionable_error', actionable_error });
    } finally {
      logger.close();
      rmSync(saivageDir, { recursive: true, force: true });
    }
  });

  it('aligns runtime fanout names with operator broadcast registry metadata', () => {
    expect([...knownRuntimeFanoutEventNames].sort()).toEqual([...operatorBroadcastEventKindValues].sort());
    expect(knownRuntimeFanoutEventNames).not.toContain('subscriber_error');
  });

  it('does not accept subscriber_error as an operator runtime fanout contract event', () => {
    const envelope = {
      type: 'error',
      content: {
        event: 'subscriber_error',
        subscription_id: 'sub-1',
        source_kind: 'goal_completed',
        error_message: 'boom',
      },
    };

    expect(parseKnownWsEnvelope(envelope)).toBeNull();
    expect(parseKnownWsContent(envelope.content)).toBeNull();
    expect(isRuntimeFanoutContent(envelope.content)).toBe(false);
    expect(() => buildRuntimeFanoutEnvelope({ event: 'subscriber_error' as never, content: envelope.content })).toThrow();
  });

  it('subscribes websocket runtime fanout only to operator broadcast registry events', () => {
    const subscriptions: Array<{ allowedKinds?: string[] }> = [];
    const runtime = {
      on: jest.fn(),
      eventBus: {
        subscribe: jest.fn((options: { allowedKinds?: string[] }) => {
          subscriptions.push(options);
          return { id: 'sub-1', pause: jest.fn(), resume: jest.fn(), unsubscribe: jest.fn() };
        }),
      },
    };

    try {
      wireRuntimeEvents(runtime as never);
      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0].allowedKinds?.sort()).toEqual([...operatorBroadcastEventKindValues].sort());
      expect(subscriptions[0].allowedKinds).not.toContain('subscriber_error');
    } finally {
      resetRuntimeEventSubscriptions(runtime as never);
    }
  });

  it('validates runtime fanout projections while omitting persisted metadata', () => {
    const envelope = buildRuntimeFanoutEnvelope({ event: 'session_cancelled', content: { session_id: 'sess-1' } });

    expect(envelope).toEqual({ type: 'status', content: { event: 'session_cancelled', session_id: 'sess-1' } });
    expect(isRuntimeFanoutContent(envelope.content)).toBe(true);
    expect(parseKnownWsContent(envelope.content)).toEqual(envelope.content);
    expect(JSON.stringify(envelope)).not.toMatch(/"kind"|"id"|"timestamp"/);
  });

  it('rejects malformed runtime fanout for cataloged event names', () => {
    expect(() => parseKnownWsEnvelope({ type: 'status', content: { event: 'session_cancelled' } })).toThrow();
  });
});
