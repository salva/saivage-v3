import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEventLog } from '../../src/observability/event-logger.js';
import { createErrorLog } from '../../src/observability/error-logger.js';
import { readAppLogEntries } from '../../src/persistence/app-log.js';
import { ReadModelChangeBroadcaster } from '../../src/application/read-model-changes.js';
import { appLogFile } from '../../src/persistence/layout.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('direct event and error app-log producers', () => {
  it('strictly appends interleaved domain rows to the one direct app log and reads type projections', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-direct-log-'));
    roots.push(root);
    const appLogs = { projectRoot: root };
    expect(Object.keys(appLogs)).toEqual(['projectRoot']);
    const agentsChanged = jest.fn();
    new ReadModelChangeBroadcaster().subscribe({ runtimeChanged: jest.fn(), cardProjectionChanged: jest.fn(), agentsChanged, conversationChanged: jest.fn() });
    const events = createEventLog(root, appLogs);
    const errors = createErrorLog(root, appLogs);
    events.appendEvent({ kind: 'runtime_diagnostic', id: 'event-1', timestamp: '2026-07-15T00:00:00.000Z', error_message: 'diagnostic' });
    errors.appendError({ id: 'error-1', timestamp: '2026-07-15T00:00:01.000Z', message: 'failed', cardId: 'project', phase: 'planner' });
    events.appendEvent({ kind: 'runtime_diagnostic', id: 'event-2', timestamp: '2026-07-15T00:00:02.000Z', error_message: 'next' });

    expect(readAppLogEntries(root).map(({ type, id }) => [type, id])).toEqual([['event', 'event-1'], ['error', 'error-1'], ['event', 'event-2']]);
    expect(events.getEvents().map(({ id }) => id)).toEqual(['event-1', 'event-2']);
    expect(errors.getErrors({ cardId: 'project' })).toEqual([expect.objectContaining({ id: 'error-1', phase: 'planner' })]);
    expect(agentsChanged).not.toHaveBeenCalled();
  });

  it('redacts before append and event/error producers each return once after duplicate physical commit', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-direct-log-'));
    roots.push(root);
    const events = createEventLog(root, { projectRoot: root });
    const errors = createErrorLog(root, { projectRoot: root });
    events.appendEvent({ kind: 'runtime_diagnostic', id: 'same', timestamp: '2026-07-15T00:00:00.000Z', error_message: 'x', metadata: { authorization: 'Bearer synthetic-secret', safe: 'visible' } });
    const serialized = JSON.stringify(events.getEvents()[0]);
    expect(serialized).not.toContain('synthetic-secret');
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).toContain('visible');
    expect(events.appendEvent({ kind: 'runtime_diagnostic', id: 'same', timestamp: '2026-07-15T00:00:00.000Z', error_message: 'duplicate' }).id).toBe('same');
    errors.appendError({ id: 'error-same', timestamp: '2026-07-15T00:00:01.000Z', message: 'failed' });
    expect(errors.appendError({ id: 'error-same', timestamp: '2026-07-15T00:00:01.000Z', message: 'failed again' }).id).toBe('error-same');
    const rows = readFileSync(appLogFile(root), 'utf8').trim().split('\n').flatMap((line) => (JSON.parse(line) as { rows: Array<{ id: string }> }).rows);
    expect(rows.map(({ id }) => id)).toEqual(['same', 'same', 'error-same', 'error-same']);
    expect(() => readAppLogEntries(root)).toThrow(/duplicate id 'same'/);
  });
});
