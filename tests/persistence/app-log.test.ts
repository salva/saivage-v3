import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appLogEntrySchema, type AppLogEntry } from '../../src/contracts/app-log.js';
import { appendAppLogEntry, readAppLogEntries } from '../../src/persistence/app-log.js';
import { appLogFile } from '../../src/persistence/layout.js';
import { serializeGrowingEnvelope } from '../../src/persistence/growing-file.js';
import { createEventLog } from '../../src/observability/event-logger.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function root(): string { const value = mkdtempSync(join(tmpdir(), 'saivage-app-log-')); roots.push(value); return value; }
function event(id: string, timestamp = '2026-07-20T00:00:00.000Z'): Extract<AppLogEntry, { type: 'event' }> {
  return appLogEntrySchema.parse({ type: 'event', data: { id, timestamp, kind: 'runtime_diagnostic', error_message: id } }) as Extract<AppLogEntry, { type: 'event' }>;
}
function append(projectRoot: string, entry: Extract<AppLogEntry, { type: 'event' }>): AppLogEntry {
  return appendAppLogEntry(projectRoot, 'event', () => entry);
}

describe('strict app-log publication', () => {
  it('accepts exactly the three {type,data} lanes and rejects old outer fields and removed lanes', () => {
    expect(appLogEntrySchema.parse(event('event'))).toEqual(event('event'));
    expect(appLogEntrySchema.safeParse({ ...event('event'), id: 'outer', timestamp: '2026-07-20T00:00:00.000Z' }).success).toBe(false);
    expect(appLogEntrySchema.safeParse({ type: 'error', data: { id: 'error' } }).success).toBe(false);
    expect(appLogEntrySchema.safeParse({ type: 'content_review', data: { id: 'review' } }).success).toBe(false);
  });

  it('preserves preparation and validation failures before filesystem work', () => {
    const projectRoot = root();
    const preparationFailure = new Error('prepare failed');
    let thrown: unknown;
    try { appendAppLogEntry(projectRoot, 'event', () => { throw preparationFailure; }); }
    catch (error) { thrown = error; }
    expect(thrown).toBe(preparationFailure);
    expect(existsSync(join(projectRoot, '.saivage'))).toBe(false);

    expect(() => appendAppLogEntry(projectRoot, 'event', () => ({ type: 'control_action' } as never))).toThrow(/returned/);
    expect(() => appendAppLogEntry(projectRoot, 'event', () => ({ type: 'event', data: { kind: 'runtime_diagnostic' } } as never))).toThrow();

    const existing = new Error('ordinary preparation failure');
    expect(() => appendAppLogEntry(projectRoot, 'event', () => { throw existing; })).toThrow(existing);
  });

  it('first-publishes one exact newline-terminated envelope into a missing tree', () => {
    const projectRoot = root(); const entry = event('first');
    expect(appendAppLogEntry(projectRoot, 'event', () => entry, { publicationTemporaryId: () => '11111111-1111-4111-8111-111111111111' })).toEqual(entry);
    expect(readFileSync(appLogFile(projectRoot))).toEqual(serializeGrowingEnvelope([entry], appLogEntrySchema));
  });

  it('rejects a duplicate logical id before publication and preserves strict lane reads', () => {
    const projectRoot = root(); const duplicate = event('same');
    append(projectRoot, duplicate);
    const before = readFileSync(appLogFile(projectRoot));

    expect(() => append(projectRoot, duplicate)).toThrow(/duplicate logical id 'same'/);
    expect(readFileSync(appLogFile(projectRoot))).toEqual(before);
    expect(readAppLogEntries(projectRoot)).toEqual([duplicate]);
    expect(readAppLogEntries(projectRoot, 'event')).toEqual([duplicate]);
    expect(readAppLogEntries(projectRoot, 'control_action')).toEqual([]);
  });

  it('rejects a distinct candidate when existing complete rows duplicate an id across lanes', () => {
    const projectRoot = root();
    const path = appLogFile(projectRoot);
    mkdirSync(join(projectRoot, '.saivage'));
    mkdirSync(join(projectRoot, '.saivage', 'logs'));
    const duplicateId = 'cross-lane-duplicate';
    const duplicateRows: AppLogEntry[] = [
      event(duplicateId),
      appLogEntrySchema.parse({
        type: 'control_action',
        data: {
          id: duplicateId,
          actor: 'analyst',
          surface: 'rest',
          action: 'get_status',
          target_kind: 'runtime',
          target_id: 'project',
          params_summary: '',
          outcome: 'ok',
          outcome_summary: 'complete',
          created_at: '2026-07-20T00:00:01.000Z',
        },
      }),
    ];
    const preserved = serializeGrowingEnvelope(duplicateRows, appLogEntrySchema);
    writeFileSync(path, preserved);
    const timelineChanged = jest.fn();
    const log = createEventLog(projectRoot, timelineChanged);

    expect(() => log.appendEvent(event('distinct', '2026-07-20T00:00:02.000Z').data)).toThrow(/duplicate logical id 'cross-lane-duplicate'/);
    expect(readFileSync(path)).toEqual(preserved);
    expect(timelineChanged).not.toHaveBeenCalled();
    expect(() => readAppLogEntries(projectRoot)).toThrow(/duplicate logical id 'cross-lane-duplicate'/);
    expect(() => readAppLogEntries(projectRoot, 'provider_exchange')).toThrow(/duplicate logical id 'cross-lane-duplicate'/);
  });

  it('truncates only an unterminated final suffix on a strict read', () => {
    const projectRoot = root(); append(projectRoot, event('first'));
    const path = appLogFile(projectRoot); const canonical = readFileSync(path);
    writeFileSync(path, Buffer.concat([canonical, Buffer.from('partial')]));
    expect(readAppLogEntries(projectRoot, 'event').map((entry) => entry.data.id)).toEqual(['first']);
    expect(readFileSync(path)).toEqual(canonical);
  });

  it('removes an interrupted invalid-byte suffix before appending the next envelope', () => {
    const projectRoot = root(); const first = event('first'); append(projectRoot, first);
    const path = appLogFile(projectRoot); const firstBytes = readFileSync(path);
    writeFileSync(path, Buffer.concat([firstBytes, Buffer.from([0x7b, 0xff, 0x7d])]));
    const second = event('second', '2026-07-20T00:00:01.000Z');

    expect(append(projectRoot, second)).toEqual(second);
    expect(readAppLogEntries(projectRoot, 'event').map((entry) => entry.data.id)).toEqual(['first', 'second']);
    expect(readFileSync(path)).toEqual(Buffer.concat([
      serializeGrowingEnvelope([first], appLogEntrySchema),
      serializeGrowingEnvelope([second], appLogEntrySchema),
    ]));
  });

  it('fails before appending to complete malformed data and leaves the bytes unchanged', () => {
    const projectRoot = root(); append(projectRoot, event('first'));
    const path = appLogFile(projectRoot); writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('{complete malformed}\n')]));
    const before = readFileSync(path); const later = event('later', '2026-07-20T00:00:01.000Z');
    expect(() => append(projectRoot, later)).toThrow(/malformed/);
    expect(readFileSync(path)).toEqual(before);
  });

  it('fails before appending to a complete invalid-UTF-8 envelope and leaves the bytes unchanged', () => {
    const projectRoot = root(); append(projectRoot, event('first'));
    const path = appLogFile(projectRoot);
    const validEnvelope = serializeGrowingEnvelope([event('invalid-marker', '2026-07-20T00:00:01.000Z')], appLogEntrySchema);
    const marker = Buffer.from('invalid-marker');
    const markerOffset = validEnvelope.indexOf(marker);
    const invalidEnvelope = Buffer.concat([
      validEnvelope.subarray(0, markerOffset),
      Buffer.from([0xff]),
      validEnvelope.subarray(markerOffset + marker.byteLength),
    ]);
    writeFileSync(path, Buffer.concat([readFileSync(path), invalidEnvelope]));
    const before = readFileSync(path);

    expect(() => append(projectRoot, event('later', '2026-07-20T00:00:02.000Z'))).toThrow(/malformed/);
    expect(readFileSync(path)).toEqual(before);
  });
});
