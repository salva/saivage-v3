import { describe, expect, it } from '@jest/globals';

import {
  errorEventSchema,
  eventKindValues,
  getEventSeverity,
  isErrorEvent,
  loggedEventSchema,
} from '../../src/schemas/event-catalog.js';
import { actionableErrorEnvelopeSchema } from '../../src/schemas/actionable-error.js';
import { appLogEntrySchema } from '../../src/contracts/app-log.js';
import { projectLoggedEvent } from '../../src/observability/logged-event-projection.js';
import { actionableErrorEnvelopeSchema as barrelActionableSchema, loggedEventSchema as barrelLoggedEventSchema } from '../../src/schemas/index.js';
import type { EventKind, LoggedEvent, LoggedEventByKind, RuntimeActionableErrorEvent } from '../../src/schemas/index.js';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type AllKindsPresent = { [K in EventKind]: [LoggedEventByKind[K]] extends [never] ? false : true }[EventKind];
type _LoggedKindsEqualCatalog = Assert<Equal<LoggedEvent['kind'], EventKind>>;
type _NoLoggedKindIsNever = Assert<Equal<AllKindsPresent, true>>;
type _ActionablePayloadIsStrictEnvelope = Assert<Equal<RuntimeActionableErrorEvent['actionable_error']['nextAction'], string>>;

const timestamp = '2026-01-01T00:00:00.000Z';
const events: LoggedEvent[] = [
  { id: 'diagnostic', timestamp, kind: 'runtime_diagnostic', error_message: 'boom' },
  { id: 'actionable', timestamp, kind: 'runtime_actionable_error', actionable_error: { code: 'fix', message: 'fix it', nextAction: 'retry' } },
  { id: 'mcp-ok', timestamp, kind: 'mcp_tool_invocation', server: 'server', tool: 'tool', success: true, duration_ms: 1 },
  { id: 'mcp-failed', timestamp, kind: 'mcp_tool_invocation', server: 'server', tool: 'tool', success: false, duration_ms: 2, error: 'failed' },
  { id: 'control', timestamp, kind: 'operator_runtime_control', actor: 'operator', surface: 'operator_api', result: { operation: 'pause_runtime', outcome: 'returned', runtime_status: 'pausing' } },
];

describe('durable event catalog', () => {
  it('has exactly four inferred strict event variants with exhaustive severity', () => {
    expect(eventKindValues).toEqual(['runtime_diagnostic', 'runtime_actionable_error', 'mcp_tool_invocation', 'operator_runtime_control']);
    expect(eventKindValues.map(getEventSeverity)).toEqual(['error', 'error', 'info', 'info']);
    for (const event of events) {
      expect(loggedEventSchema.parse(event)).toEqual(event);
      expect(appLogEntrySchema.parse({ type: 'event', data: event })).toEqual({ type: 'event', data: event });
    }
  });

  it('owns a strict actionable envelope in the dependency-neutral schema module', () => {
    expect(barrelActionableSchema).toBe(actionableErrorEnvelopeSchema);
    expect(barrelLoggedEventSchema).toBe(loggedEventSchema);
    expect(actionableErrorEnvelopeSchema.parse({ code: 'x', message: 'm', nextAction: 'n' })).toEqual({ code: 'x', message: 'm', nextAction: 'n' });
    expect(actionableErrorEnvelopeSchema.safeParse({ code: 'x', message: 'm', nextAction: 'n', extra: true }).success).toBe(false);
    expect(loggedEventSchema.safeParse({ id: 'x', timestamp, kind: 'runtime_actionable_error', actionable_error: {} }).success).toBe(false);
  });

  it('selects diagnostics, actionable errors, and only failed MCP invocations', () => {
    expect(events.map(isErrorEvent)).toEqual([true, true, false, true, false]);
    expect(events.map((event) => errorEventSchema.safeParse(event).success)).toEqual([true, true, false, true, false]);
  });
  it('projects only strict bounded operator outcomes and rejects incompatible combinations', () => {
    const base = { id: 'control', timestamp, kind: 'operator_runtime_control', actor: 'operator', surface: 'operator_api' };
    const results = [
      { operation: 'pause_runtime', outcome: 'returned', runtime_status: 'pausing' },
      { operation: 'resume_runtime', outcome: 'returned', runtime_status: 'running' },
      { operation: 'stop_project', outcome: 'returned', status: 'stopped', contained: false },
      { operation: 'restart_server', outcome: 'restart_scheduled' },
      ...['pause_runtime', 'resume_runtime', 'stop_project'].map(operation => ({ operation, outcome: 'rejected', reason: 'body_not_allowed' })),
      { operation: 'restart_server', outcome: 'rejected', reason: 'restart_unavailable' },
    ];
    for (const result of results) {
      const event = loggedEventSchema.parse({ ...base, result });
      expect(projectLoggedEvent(event)).toEqual(event);
      for (const extra of [{ card_id: 'project' }, { session_id: 'agent:analyst:global' }, { body: {} }, { headers: {} }]) {
        expect(() => projectLoggedEvent({ ...event, ...extra } as LoggedEvent)).toThrow();
      }
      expect(loggedEventSchema.safeParse({ ...base, result: { ...result, secret: 'forbidden' } }).success).toBe(false);
    }
    for (const result of [
      { operation: 'pause_runtime', outcome: 'restart_scheduled' },
      { operation: 'restart_server', outcome: 'rejected', reason: 'body_not_allowed' },
      { operation: 'stop_project', outcome: 'returned', runtime_status: 'stopped' },
      { operation: 'pause_runtime', outcome: 'returned', runtime_status: 'unknown' },
    ]) expect(loggedEventSchema.safeParse({ ...base, result }).success).toBe(false);
    expect(loggedEventSchema.safeParse({ ...base, actor: 'analyst', result: results[0] }).success).toBe(false);
  });

  it('rejects removed metadata, generic routing fields, and removed event kinds', () => {
    expect(loggedEventSchema.safeParse({ ...events[0], metadata: {} }).success).toBe(false);
    expect(loggedEventSchema.safeParse({ ...events[0], session_id: 'agent:analyst:global' }).success).toBe(false);
    expect(loggedEventSchema.safeParse({ id: 'old', timestamp, kind: 'card_history_appended' }).success).toBe(false);
  });
});
