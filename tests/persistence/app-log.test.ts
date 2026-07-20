import { afterEach, describe, expect, it } from '@jest/globals';
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { appLogEntrySchema, type AppLogEntry } from '../../src/contracts/app-log.js';
import { appendAppLogEntry, readAppLogEntries } from '../../src/persistence/app-log.js';
import { appLogFile } from '../../src/persistence/layout.js';
import { serializeGrowingEnvelope } from '../../src/persistence/growing-file.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function root(): string { const value = mkdtempSync(join(tmpdir(), 'saivage-app-log-')); roots.push(value); return value; }
function event(id: string, timestamp = '2026-07-20T00:00:00.000Z'): AppLogEntry {
  return appLogEntrySchema.parse({ id, timestamp, type: 'event', data: { id, timestamp, kind: 'runtime_diagnostic', error_message: id } });
}
function rawRows(projectRoot: string): AppLogEntry[] {
  return readFileSync(appLogFile(projectRoot), 'utf8').trim().split('\n').flatMap((line) => (JSON.parse(line) as { rows: AppLogEntry[] }).rows);
}

describe('direct app-log append', () => {
  it('rejects invalid incoming identity and timestamp before filesystem work', () => {
    const projectRoot = root();
    const valid = event('outer');
    expect(() => appendAppLogEntry(projectRoot, { ...valid, data: { ...valid.data, id: 'inner' } } as AppLogEntry)).toThrow();
    expect(() => appendAppLogEntry(projectRoot, { ...valid, data: { ...valid.data, timestamp: '2026-07-20T00:00:01.000Z' } } as AppLogEntry)).toThrow();
    expect(existsSync(join(projectRoot, '.saivage'))).toBe(false);
  });

  it('first-publishes one exact newline-terminated envelope into a missing tree', () => {
    const projectRoot = root(); const entry = event('first');
    expect(appendAppLogEntry(projectRoot, entry, () => '11111111-1111-4111-8111-111111111111')).toEqual(entry);
    expect(readFileSync(appLogFile(projectRoot))).toEqual(serializeGrowingEnvelope([entry], appLogEntrySchema));
  });

  it('directly appends after existing malformed complete data and leaves strict failure intact', () => {
    const projectRoot = root(); appendAppLogEntry(projectRoot, event('first'));
    const path = appLogFile(projectRoot);
    const malformed = Buffer.from('{complete malformed}\n');
    writeFileSync(path, Buffer.concat([readFileSync(path), malformed]));
    const before = readFileSync(path);
    const later = event('later', '2026-07-20T00:00:01.000Z');
    expect(appendAppLogEntry(projectRoot, later)).toEqual(later);
    expect(readFileSync(path)).toEqual(Buffer.concat([before, serializeGrowingEnvelope([later], appLogEntrySchema)]));
    expect(() => readAppLogEntries(projectRoot)).toThrow(/malformed/);
  });

  it('physically commits duplicate ids and rejects them globally on unfiltered and filtered strict reads', () => {
    const projectRoot = root(); const duplicate = event('same');
    appendAppLogEntry(projectRoot, duplicate);
    expect(appendAppLogEntry(projectRoot, duplicate)).toEqual(duplicate);
    expect(rawRows(projectRoot).map(({ id }) => id)).toEqual(['same', 'same']);
    expect(() => readAppLogEntries(projectRoot)).toThrow(/duplicate id 'same'/);
    expect(() => readAppLogEntries(projectRoot, 'error')).toThrow(/duplicate id 'same'/);
  });

  it('truncates an unterminated suffix only when a strict full read occurs', () => {
    const projectRoot = root(); appendAppLogEntry(projectRoot, event('first'));
    const path = appLogFile(projectRoot); const canonical = readFileSync(path);
    writeFileSync(path, Buffer.concat([canonical, Buffer.from('partial')]));
    expect(readAppLogEntries(projectRoot).map(({ id }) => id)).toEqual(['first']);
    expect(readFileSync(path)).toEqual(canonical);
  });

  it('appends verbatim after an unterminated suffix and a later strict failure leaves the now-complete malformed line unchanged', () => {
    const projectRoot = root(); const first = event('first'); appendAppLogEntry(projectRoot, first);
    const path = appLogFile(projectRoot);
    const suffix = Buffer.from('{unterminated');
    writeFileSync(path, Buffer.concat([readFileSync(path), suffix]));
    const later = event('later', '2026-07-20T00:00:01.000Z');
    const expected = Buffer.concat([serializeGrowingEnvelope([first], appLogEntrySchema), suffix, serializeGrowingEnvelope([later], appLogEntrySchema)]);
    appendAppLogEntry(projectRoot, later);
    expect(readFileSync(path)).toEqual(expected);
    expect(() => readAppLogEntries(projectRoot)).toThrow(/malformed/);
    expect(readFileSync(path)).toEqual(expected);
  });

  it('never first-publishes over dangling or existing final symlinks', () => {
    for (const dangling of [false, true]) {
      const projectRoot = root(); const logs = join(projectRoot, '.saivage', 'logs');
      const path = appLogFile(projectRoot); const destination = join(logs, dangling ? 'absent.jsonl' : 'destination.jsonl');
      writeFileSync(join(projectRoot, 'placeholder'), '');
      appendAppLogEntry(projectRoot, event(`setup-${dangling}`));
      rmSync(path);
      if (!dangling) writeFileSync(destination, 'original\n');
      symlinkSync(destination, path);
      expect(() => appendAppLogEntry(projectRoot, event(`linked-${dangling}`))).toThrow();
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
      if (!dangling) expect(readFileSync(destination, 'utf8')).toBe('original\n');
    }
  });

  it('never first-publishes over a FIFO path', () => {
    const projectRoot = root(); appendAppLogEntry(projectRoot, event('setup'));
    const path = appLogFile(projectRoot); rmSync(path);
    expect(spawnSync('mkfifo', [path]).status).toBe(0);
    expect(() => appendAppLogEntry(projectRoot, event('fifo'))).toThrow();
    expect(existsSync(path)).toBe(true);
  });
});
