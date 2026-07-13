import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { TestEventLogger as EventLogger } from '../helpers/observability.js';

const timestamp = '2025-01-01T00:00:00.000Z';

describe('EventLogger runtime event validation', () => {
  const roots: string[] = [];

  function makeSaivageDir(): string {
    const root = mkdtempSync(join(tmpdir(), 'saivage-event-logger-'));
    roots.push(root);
    return join(root, '.saivage');
  }

  afterEach(() => {
    jest.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('strictly rejects invalid current appends before persistence', () => {
    const logger = new EventLogger(makeSaivageDir());
    try {
      expect(() => logger.appendEvent({ kind: 'runtime_diagnostic', timestamp })).toThrow(/LoggedEvent validation failed for kind 'runtime_diagnostic'/);
      expect(logger.getEvents()).toEqual([]);
    } finally {
    }
  });

  it('fails on malformed complete historical rows', () => {
    const saivageDir = makeSaivageDir();
    const logger = new EventLogger(saivageDir);
    try {
      mkdirSync(dirname(logger.getLogPath()), { recursive: true });
      writeFileSync(logger.getLogPath(),
        [
          JSON.stringify({ id: 'app-known', timestamp, type: 'event', data: { id: 'evt-known', kind: 'runtime_diagnostic', timestamp, error_message: 'known' } }),
          JSON.stringify({ id: 'app-old', timestamp, type: 'event', data: { id: 'evt-old', kind: 'legacy_historical_kind', timestamp, old_payload: true } }),
          '{malformed json',
          '',
        ].join('\n'),
      );

      expect(() => logger.getEvents()).toThrow(/malformed/);
    } finally {
    }
  });



  it('redacts secret-like variants in persisted EventLogger observability records', () => {
    const logger = new EventLogger(makeSaivageDir());
    try {
      logger.appendEvent({
        kind: 'runtime_diagnostic',
        id: 'evt-secret-variant-redaction',
        timestamp,
        session_id: 'planner:secret-variant-test',
        error_message: 'variant redaction test',
        error_name: 'TestError',
        provider_error: {
          api_key: 'SYNTHETIC_API_KEY',
          access_token: 'SYNTHETIC_ACCESS_TOKEN',
          refresh_token: 'SYNTHETIC_REFRESH_TOKEN',
          authorization: 'Bearer SYNTHETIC_AUTHORIZATION',
          idempotency_token: 'SYNTHETIC_IDEMPOTENCY_TOKEN',
          idempotency_secret: 'SYNTHETIC_IDEMPOTENCY_SECRET',
          safe: 'visible',
        },
      });
      const [event] = logger.getEvents({ kind: 'runtime_diagnostic' });
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain('SYNTHETIC_API_KEY');
      expect(serialized).not.toContain('SYNTHETIC_ACCESS_TOKEN');
      expect(serialized).not.toContain('SYNTHETIC_REFRESH_TOKEN');
      expect(serialized).not.toContain('SYNTHETIC_AUTHORIZATION');
      expect(serialized).not.toContain('SYNTHETIC_IDEMPOTENCY_TOKEN');
      expect(serialized).not.toContain('SYNTHETIC_IDEMPOTENCY_SECRET');
      expect(serialized).toContain('[REDACTED]');
      expect(serialized).toContain('visible');
    } finally {
    }
  });

  it('redacts runtime_actionable_error idempotency_key', () => {
    const logger = new EventLogger(makeSaivageDir());
    try {
      logger.appendEvent({
        kind: 'runtime_actionable_error',
        id: 'evt-runtime-activation-redaction',
        timestamp,
        actionable_error: {
          code: 'test',
          message: 'test',
          nextAction: 'test',
          idempotency_key: 'run-parent:planner:call-a:code-a',
        },
      });
      const [event] = logger.getEvents({ kind: 'runtime_actionable_error' });
      expect((event as any).actionable_error.idempotency_key).toBe('[REDACTED]');
    } finally {
    }
  });

});
