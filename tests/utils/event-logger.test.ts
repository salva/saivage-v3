import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { EventLogger } from '../../src/observability/event-logger.js';

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
      expect(() => logger.appendEvent({ kind: 'goal_completed', timestamp })).toThrow(/LoggedEvent validation failed for kind 'goal_completed'/);
      logger.flushSync();
      expect(logger.getEvents()).toEqual([]);
    } finally {
      logger.close();
    }
  });

  it('uses tolerant historical parsing and skips unknown-kind records without failing the whole log', () => {
    const saivageDir = makeSaivageDir();
    const logger = new EventLogger(saivageDir);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      writeFileSync(
        logger.getLogPath(),
        [
          JSON.stringify({ id: 'evt-known', kind: 'started', timestamp, project_root: '/tmp/project' }),
          JSON.stringify({ id: 'evt-old', kind: 'legacy_historical_kind', timestamp, old_payload: true }),
          '{malformed json',
          '',
        ].join('\n'),
      );

      const events = logger.getEvents();
      expect(events.map((event) => event.kind)).toEqual(['started']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Ignoring invalid runtime event log record'));
    } finally {
      logger.close();
    }
  });



  it('redacts secret-like variants in persisted EventLogger observability records', () => {
    const logger = new EventLogger(makeSaivageDir());
    try {
      logger.appendEvent({
        kind: 'llm_attempt',
        id: 'evt-secret-variant-redaction',
        timestamp,
        session_id: 'planner:secret-variant-test',
        role: 'planner',
        attempt: 1,
        same_candidate_attempt: 1,
        provider: 'openai',
        model: 'gpt-test',
        account: '_',
        started_at: timestamp,
        duration_ms: 0,
        outcome: {
          kind: 'failed',
          failure_class: 'unknown',
          recovery_action: 'abort_without_retry',
          error_name: 'TestError',
          error_message: 'variant redaction test',
          error_preview: 'variant redaction test',
        },
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
      const [event] = logger.getEvents({ kind: 'llm_attempt' });
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
      logger.close();
    }
  });

  it('persists schema-valid runtime_activation activation idempotency_key', () => {
    const logger = new EventLogger(makeSaivageDir());
    try {
      logger.appendEvent({
        kind: 'runtime_activation',
        id: 'evt-runtime-activation-redaction',
        timestamp,
        activation: {
          activation_id: 'act-1',
          idempotency_key: 'run-parent:planner:call-a:code-a',
          parent_card_id: 'goal-a',
          parent_run_id: 'run-parent',
          parent_session_id: 'planner:goal-a',
          parent_tool_call_id: 'call-a',
          child_card_id: 'code-a',
          status: 'pending',
          requested_at: timestamp,
          updated_at: timestamp,
          precondition: 'accepted',
          runtime_run_id: 'run-child',
          error: null,
        },
      });
      const [event] = logger.getEvents({ kind: 'runtime_activation' });
      expect((event as any).activation.idempotency_key).toBe('run-parent:planner:call-a:code-a');
    } finally {
      logger.close();
    }
  });

});
