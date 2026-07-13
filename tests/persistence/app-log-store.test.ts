import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from '@jest/globals';
import { AppLogStore, readAppLogEntries, type AppLogEntry } from '../../src/persistence/app-log.js';
import { appLogFile } from '../../src/persistence/layout.js';
import { createMutationLane } from '../../src/application/mutation-lane.js';
import { RootCurrentness } from '../../src/application/mutation-authority.js';

const roots: string[] = [];
const root = () => { const value = mkdtempSync(join(tmpdir(), 'saivage-app-log-store-')); roots.push(value); return value; };
const entry = (id = 'event-1'): AppLogEntry => ({ id, timestamp: '2026-07-13T00:00:00.000Z', type: 'event', data: { id } });
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('AppLogStore', () => {
  it('appends synchronously and idempotently by immutable id', () => {
    const projectRoot = root(); const mutation = createMutationLane(); const store = new AppLogStore(projectRoot, mutation.lane); store.restabilize(mutation.authority);
    expect(store.append(mutation.authority, entry())).toEqual(entry());
    expect(store.append(mutation.authority, entry())).toEqual(entry());
    expect(readAppLogEntries(projectRoot)).toEqual([entry()]);
    expect(() => store.append(mutation.authority, { ...entry(), data: { changed: true } })).toThrow(/different content/);
  });

  it('truncates only an incomplete final row during startup restabilization', () => {
    const projectRoot = root(); const path = appLogFile(projectRoot); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(entry())}\n{"id":"partial"`);
    const mutation = createMutationLane(); const store = new AppLogStore(projectRoot, mutation.lane); store.restabilize(mutation.authority);
    expect(readAppLogEntries(projectRoot)).toEqual([entry()]);
    expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(entry())}\n`);
  });

  it('fails on malformed complete rows and rejects stale authority without a write', () => {
    const malformedRoot = root(); const malformedPath = appLogFile(malformedRoot); mkdirSync(dirname(malformedPath), { recursive: true }); writeFileSync(malformedPath, '{bad}\n');
    const malformedMutation = createMutationLane(); expect(() => new AppLogStore(malformedRoot, malformedMutation.lane).restabilize(malformedMutation.authority)).toThrow(/malformed/);

    const staleRoot = root(); const mutation = createMutationLane(); const store = new AppLogStore(staleRoot, mutation.lane); store.restabilize(mutation.authority); const currentness = new RootCurrentness(); const stale = currentness.installRoot(); currentness.clearRoot(stale);
    expect(() => store.append(stale, entry())).toThrow(/stale/);
    expect(readAppLogEntries(staleRoot)).toEqual([]);
  });
});
