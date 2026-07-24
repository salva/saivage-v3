import { describe, expect, it } from '@jest/globals';
import {
  SECRET_REDACTION_PLACEHOLDER,
  OUTBOUND_REDACTION_SOURCES,
  redactForOutbound,
  redactSnippetForOutbound,
  redactTextForOutbound,
} from '../../src/redaction/index.js';

describe('outbound redaction', () => {
  it('has the exact singular-cutover source inventory', () => {
    expect(OUTBOUND_REDACTION_SOURCES).toEqual([
      'provider-exchange', 'logged-event', 'control-action', 'operator-card', 'runtime-card-runs', 'card-history', 'card-diff', 'config', 'process-view', 'webfetch-invocation', 'webfetch-result', 'tool-invocation', 'agent-conversation', 'ws-envelope', 'mcp-status', 'mcp-tools', 'dynamic',
    ]);
  });

  describe('WebSocket status envelopes', () => {
    it('preserves admitted connected passthrough keys while redacting secret-bearing values', () => {
      const projected = redactForOutbound({
        source: 'ws-envelope',
        value: {
          type: 'status',
          content: {
            event: 'connected',
            sessionId: 'agent:analyst:global',
            timestamp: '2026-07-24T12:00:00.000Z',
            clientCount: 1,
            safeExtension: 'visible',
            apiKey: 'synthetic-connected-secret',
          },
        },
      });

      expect(projected).toEqual({
        type: 'status',
        content: {
          event: 'connected',
          sessionId: 'agent:analyst:global',
          timestamp: '2026-07-24T12:00:00.000Z',
          clientCount: 1,
          safeExtension: 'visible',
          apiKey: SECRET_REDACTION_PLACEHOLDER,
        },
      });
    });

    it('preserves acknowledged status exactly', () => {
      const acknowledged = {
        type: 'status' as const,
        content: {
          event: 'analyst_turn_acknowledged' as const,
          sessionId: 'agent:analyst:global' as const,
          restart: null,
        },
      };

      expect(redactForOutbound({ source: 'ws-envelope', value: acknowledged })).toEqual(acknowledged);
    });
  });

  describe('structured values', () => {
    it('masks nested secret keys, handles arrays and cycles, and preserves non-secret values', () => {
      const circular: Record<string, unknown> = { safe: 'kept' };
      circular['self'] = circular;

      const result = redactForOutbound({ source: 'dynamic', value: {
        title: 'visible',
        nested: {
          apiKey: 'synthetic-api-key',
          items: [{ password: 'synthetic-password', count: 3 }, 'safe'],
        },
        circular,
      } });

      expect(result).toEqual({
        title: 'visible',
        nested: {
          apiKey: SECRET_REDACTION_PLACEHOLDER,
          items: [{ password: SECRET_REDACTION_PLACEHOLDER, count: 3 }, 'safe'],
        },
        circular: { safe: 'kept', self: '[Circular]' },
      });
    });

    it('uses active-path cycles, independently projects repeated siblings, ignores toJSON, and preserves serializer undefined behavior', () => {
      const shared = { text: 'tok_shared_secret' };
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const throwingToJson = {
        visible: 'safe',
        toJSON(): never { throw new Error('must not run'); },
      };

      const projected = redactForOutbound({ source: 'dynamic', value: {
        first: shared,
        second: shared,
        circular,
        error: Object.assign(new Error('token=synthetic-error-secret'), { leaked: 'synthetic-custom-field' }),
        throwingToJson,
        omitted: undefined,
        array: [undefined],
        apiKey: 'synthetic-key',
        retryToken: 12,
        auth: true,
      } });

      expect(projected).toEqual({
        first: { text: 'tok-[REDACTED]' },
        second: { text: 'tok-[REDACTED]' },
        circular: { self: '[Circular]' },
        error: 'token=[REDACTED]',
        throwingToJson: { visible: 'safe', toJSON: undefined },
        omitted: undefined,
        array: [undefined],
        apiKey: '[REDACTED]',
        retryToken: 0,
        auth: false,
      });
      expect(JSON.parse(JSON.stringify(projected))).toEqual({
        first: { text: 'tok-[REDACTED]' },
        second: { text: 'tok-[REDACTED]' },
        circular: { self: '[Circular]' },
        error: 'token=[REDACTED]',
        throwingToJson: { visible: 'safe' },
        array: [null],
        apiKey: '[REDACTED]',
        retryToken: 0,
        auth: false,
      });
      expect(JSON.stringify(projected)).not.toContain('synthetic-custom-field');
    });

    it('does not truncate admitted dynamic values by depth or entry count', () => {
      let deep: Record<string, unknown> = { value: 'kept' };
      for (let depth = 0; depth < 10; depth += 1) deep = { child: deep };
      const wide = Object.fromEntries(Array.from({ length: 101 }, (_, index) => [`field${index}`, index]));

      const projected = redactForOutbound({ source: 'dynamic', value: { deep, wide } }) as { deep: unknown; wide: Record<string, unknown> };
      let cursor = projected.deep;
      for (let depth = 0; depth < 10; depth += 1) {
        expect(cursor).toEqual(expect.objectContaining({ child: expect.anything() }));
        cursor = (cursor as Record<string, unknown>)['child'];
      }
      expect(cursor).toEqual({ value: 'kept' });
      expect(Object.keys(projected.wide)).toHaveLength(101);
    });
  });

  describe('text and dynamic conversion', () => {
    it('preserves plain text and environment references', () => {
      expect(redactTextForOutbound('ordinary diagnostic text')).toBe('ordinary diagnostic text');
      expect(redactTextForOutbound('{"apiKey":"${PROVIDER_API_KEY}"}')).toBe('{"apiKey":"${PROVIDER_API_KEY}"}');
    });

    it.each([
      ['JSON', '{"apiKey":"synthetic-json-secret","safe":"visible"}', '{"apiKey":"[REDACTED]","safe":"visible"}'],
      ['YAML', 'password: synthetic-yaml-secret\nsafe: visible', 'password: [REDACTED]\nsafe: visible'],
      ['escaped JSON', 'payload={\\"accessToken\\":\\"synthetic-escaped-secret\\"}', 'payload={\\"accessToken\\":\\"[REDACTED]\\"}'],
      ['inline assignment', 'run token=synthetic-assignment-secret now', 'run token=[REDACTED] now'],
      ['URL query credential', 'https://example.test/path?api_key=synthetic-query-secret&safe=yes', 'https://example.test/path?api_key=[REDACTED]'],
      ['bearer credential', 'Authorization: Bearer synthetic-bearer-secret', 'Authorization: [REDACTED]'],
      ['credential literals', 'sk-synthetic tid=synthetic ghu_synthetic rt_synthetic tok_synthetic', 'sk-[REDACTED] tid-[REDACTED] ghu-[REDACTED] rt-[REDACTED] tok-[REDACTED]'],
    ])('redacts %s text with the current exact output', (_kind, input, expected) => {
      expect(redactTextForOutbound(input)).toBe(expected);
    });

    it('converts Error and unserializable dynamic values before redaction', () => {
      expect(redactTextForOutbound(new Error('token=synthetic-error-secret'))).toBe('token=[REDACTED]');
      expect(redactTextForOutbound({ value: 1n })).toBe('[unserializable dynamic value]');
    });
  });

  it('redacts the complete text before applying the required snippet bound', () => {
    const rawSecret = 'synthetic-secret-that-crosses-the-boundary';
    const result = redactSnippetForOutbound(`prefix Bearer ${rawSecret} safe-tail`, 30);

    expect(result).toBe('prefix Bearer [REDACTED] safe-');
    expect(result).toHaveLength(30);
    expect(result).not.toContain(rawSecret);
  });
});
