import { afterEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appLogEntrySchema, type AppLogEntry } from '../../src/contracts/app-log.js';
import { AppLogPublicationError, appendAppLogEntry, readAppLogEntries } from '../../src/persistence/app-log.js';
import { appLogFile } from '../../src/persistence/layout.js';
import { serializeGrowingEnvelope } from '../../src/persistence/growing-file.js';

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

  it('wraps preparation and validation once with exact operation context before filesystem work', () => {
    const projectRoot = root();
    const preparationFailure = new Error('prepare failed');
    const operationError = new Error('operation failed');
    let thrown: unknown;
    try { appendAppLogEntry(projectRoot, 'event', () => { throw preparationFailure; }, { operationError }); }
    catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(AppLogPublicationError);
    expect(thrown).toMatchObject({ entryType: 'event', publicationCause: preparationFailure, operationError });
    expect(existsSync(join(projectRoot, '.saivage'))).toBe(false);

    expect(() => appendAppLogEntry(projectRoot, 'event', () => ({ type: 'control_action' } as never))).toThrow(AppLogPublicationError);
    expect(() => appendAppLogEntry(projectRoot, 'event', () => ({ type: 'event', data: { kind: 'runtime_diagnostic' } } as never))).toThrow(AppLogPublicationError);

    const existing = new AppLogPublicationError('event', new Error('already wrapped'));
    expect(() => appendAppLogEntry(projectRoot, 'event', () => { throw existing; })).toThrow(existing);
  });

  it('first-publishes one exact newline-terminated envelope into a missing tree', () => {
    const projectRoot = root(); const entry = event('first');
    expect(appendAppLogEntry(projectRoot, 'event', () => entry, { publicationTemporaryId: () => '11111111-1111-4111-8111-111111111111' })).toEqual(entry);
    expect(readFileSync(appLogFile(projectRoot))).toEqual(serializeGrowingEnvelope([entry], appLogEntrySchema));
  });

  it('physically commits duplicate logical ids and rejects them before lane filtering', () => {
    const projectRoot = root(); const duplicate = event('same');
    append(projectRoot, duplicate); append(projectRoot, duplicate);
    expect(() => readAppLogEntries(projectRoot)).toThrow(/duplicate logical id 'same'/);
    expect(() => readAppLogEntries(projectRoot, 'control_action')).toThrow(/duplicate logical id 'same'/);
  });

  it('truncates only an unterminated final suffix on a strict read', () => {
    const projectRoot = root(); append(projectRoot, event('first'));
    const path = appLogFile(projectRoot); const canonical = readFileSync(path);
    writeFileSync(path, Buffer.concat([canonical, Buffer.from('partial')]));
    expect(readAppLogEntries(projectRoot, 'event').map((entry) => entry.data.id)).toEqual(['first']);
    expect(readFileSync(path)).toEqual(canonical);
  });

  it('appends after complete malformed data without reading or retrying and preserves strict read failure', () => {
    const projectRoot = root(); append(projectRoot, event('first'));
    const path = appLogFile(projectRoot); writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('{complete malformed}\n')]));
    const before = readFileSync(path); const later = event('later', '2026-07-20T00:00:01.000Z');
    expect(append(projectRoot, later)).toEqual(later);
    expect(readFileSync(path)).toEqual(Buffer.concat([before, serializeGrowingEnvelope([later], appLogEntrySchema)]));
    expect(() => readAppLogEntries(projectRoot)).toThrow(/malformed/);
  });
});
