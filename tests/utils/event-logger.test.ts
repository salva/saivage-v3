import { describe, it, expect, afterEach, jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { EventLogger } from '../../src/utils/event-logger.js';

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
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Unknown historical runtime event kind 'legacy_historical_kind'"));
    } finally {
      logger.close();
    }
  });

  it('persists validated freeze lifecycle events with required payloads', () => {
    const logger = new EventLogger(makeSaivageDir());
    try {
      logger.appendEvent({ kind: 'frozen', id: 'evt-frozen', timestamp, freeze_id: 'freeze-1', reason: 'operator requested freeze' });
      logger.appendEvent({ kind: 'resumed_from_freeze', id: 'evt-resumed', timestamp, freeze_id: 'freeze-1' });
      logger.flushSync();
      const raw = readFileSync(logger.getLogPath(), 'utf-8');
      expect(raw).toContain('"kind":"frozen"');
      expect(raw).toContain('"kind":"resumed_from_freeze"');
      expect(logger.getEvents().map((event) => event.kind)).toEqual(['frozen', 'resumed_from_freeze']);
    } finally {
      logger.close();
    }
  });
});
