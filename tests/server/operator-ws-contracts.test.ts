import { describe, expect, it } from '@jest/globals';
import { eventKindValues } from '../../src/schemas/types.js';
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
          compatibilitySnapshots: 'degraded',
          lastCompatibilitySnapshotWarning: {
            code: 'compatibility-snapshot-degraded',
            operation: 'startup-repair',
            relativePath: '.saivage/cards/tree/project.children.json',
            message: 'Synthetic warning with token=[REDACTED]',
            occurredAt: '2026-01-01T00:00:00.000Z',
            canonicalCommitted: false,
          },
          warnings: [],
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

  it('aligns runtime fanout names with the ARCH-006 event catalog', () => {
    expect([...knownRuntimeFanoutEventNames].sort()).toEqual([...eventKindValues].sort());
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
