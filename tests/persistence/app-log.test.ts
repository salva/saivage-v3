import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appLogEntrySchema, type AppLogEntry } from '../../src/contracts/app-log.js';
import { appendAppLogEntry, initializeAppLog, readAppLogEntries } from '../../src/persistence/app-log.js';
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

describe('strict app-log startup admission', () => {
  it('treats exact missing as absent', () => {
    const projectRoot = root();
    expect(() => initializeAppLog(projectRoot)).not.toThrow();
    expect(existsSync(appLogFile(projectRoot))).toBe(false);
  });

  it('fails on a present zero-byte app log without changing it', () => {
    const projectRoot = root();
    mkdirSync(join(projectRoot, '.saivage'), { recursive: true });
    mkdirSync(join(projectRoot, '.saivage', 'logs'), { recursive: true });
    const path = appLogFile(projectRoot);
    writeFileSync(path, '');
    expect(() => initializeAppLog(projectRoot)).toThrow();
    expect(readFileSync(path)).toEqual(Buffer.alloc(0));
  });

  it('fails on a present complete malformed app log', () => {
    const projectRoot = root();
    mkdirSync(join(projectRoot, '.saivage', 'logs'), { recursive: true });
    const path = appLogFile(projectRoot);
    writeFileSync(path, '{complete malformed}\n');
    expect(() => initializeAppLog(projectRoot)).toThrow();
  });

  it('accepts a present valid app log', () => {
    const projectRoot = root();
    append(projectRoot, event('first'));
    expect(() => initializeAppLog(projectRoot)).not.toThrow();
  });
});

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

  it('publishes a duplicate logical id and rejects it on every complete read and startup validation', () => {
    const projectRoot = root(); const duplicate = event('same');
    append(projectRoot, duplicate);

    expect(append(projectRoot, duplicate)).toEqual(duplicate);
    expect(() => readAppLogEntries(projectRoot)).toThrow(/duplicate logical id 'same'/);
    expect(() => readAppLogEntries(projectRoot, 'event')).toThrow(/duplicate logical id 'same'/);
    expect(() => initializeAppLog(projectRoot)).toThrow(/duplicate logical id 'same'/);
  });

  it('appends after existing cross-lane duplicates and rejects the resulting stream on read and startup', () => {
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
    writeFileSync(path, serializeGrowingEnvelope(duplicateRows, appLogEntrySchema));
    const log = createEventLog(projectRoot);

    expect(log.appendEvent(event('distinct', '2026-07-20T00:00:02.000Z').data)).toEqual(event('distinct', '2026-07-20T00:00:02.000Z').data);
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(() => readAppLogEntries(projectRoot)).toThrow(/duplicate logical id 'cross-lane-duplicate'/);
    expect(() => readAppLogEntries(projectRoot, 'provider_exchange')).toThrow(/duplicate logical id 'cross-lane-duplicate'/);
    expect(() => initializeAppLog(projectRoot)).toThrow(/duplicate logical id 'cross-lane-duplicate'/);
  });

  it('keeps ordinary reads correction-free for an unterminated final suffix', () => {
    const projectRoot = root(); append(projectRoot, event('first'));
    const path = appLogFile(projectRoot); const canonical = readFileSync(path);
    writeFileSync(path, Buffer.concat([canonical, Buffer.from('partial')]));
    expect(() => readAppLogEntries(projectRoot, 'event')).toThrow(/incomplete final envelope/);
    expect(readFileSync(path)).toEqual(Buffer.concat([canonical, Buffer.from('partial')]));
  });

  it('rejects append admission without correcting an interrupted invalid-byte suffix', () => {
    const projectRoot = root(); const first = event('first'); append(projectRoot, first);
    const path = appLogFile(projectRoot); const firstBytes = readFileSync(path);
    writeFileSync(path, Buffer.concat([firstBytes, Buffer.from([0x7b, 0xff, 0x7d])]));
    const second = event('second', '2026-07-20T00:00:01.000Z');

    expect(() => append(projectRoot, second)).toThrow(/incomplete final envelope/);
    expect(readFileSync(path)).toEqual(Buffer.concat([firstBytes, Buffer.from([0x7b, 0xff, 0x7d])]));
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

  it('appends after an earlier malformed line when the final envelope is clean, then strict reads and startup fail', () => {
    const projectRoot = root();
    mkdirSync(join(projectRoot, '.saivage', 'logs'), { recursive: true });
    const path = appLogFile(projectRoot);
    const clean = serializeGrowingEnvelope([event('clean-final')], appLogEntrySchema);
    const before = Buffer.concat([Buffer.from('{earlier malformed}\n'), clean]);
    writeFileSync(path, before);

    const later = event('later', '2026-07-20T00:00:01.000Z');
    expect(append(projectRoot, later)).toEqual(later);
    expect(readFileSync(path).byteLength).toBe(before.byteLength + serializeGrowingEnvelope([later], appLogEntrySchema).byteLength);
    expect(() => readAppLogEntries(projectRoot)).toThrow(/malformed/);
    expect(() => initializeAppLog(projectRoot)).toThrow(/malformed/);
  });
});
