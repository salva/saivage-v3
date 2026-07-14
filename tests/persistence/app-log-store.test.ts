import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from '@jest/globals';
import { AppLogStore, readAppLogEntries, type AppLogEntry } from '../../src/persistence/app-log.js';
import { appLogFile } from '../../src/persistence/layout.js';
import { ApplicationPersistenceHealth } from '../../src/application/persistence-health.js';

const roots: string[] = [];
const root = () => { const value = mkdtempSync(join(tmpdir(), 'saivage-app-log-store-')); roots.push(value); return value; };
const entry = (id = 'event-1'): AppLogEntry => ({ id, timestamp: '2026-07-13T00:00:00.000Z', type: 'event', data: { id, kind: 'runtime_diagnostic', timestamp: '2026-07-13T00:00:00.000Z', error_message: 'test' } });
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe('AppLogStore', () => {
  it('appends synchronously and rejects duplicate ids', () => {
    const projectRoot = root(); const store = new AppLogStore(projectRoot, new ApplicationPersistenceHealth()); store.restabilize();
    expect(store.append(entry())).toEqual(entry());
    expect(() => store.append(entry())).toThrow(/already exists/);
    expect(readAppLogEntries(projectRoot)).toEqual([entry()]);
    expect(() => store.append({ ...entry(), data: { ...entry().data, error_message: 'changed' } } as AppLogEntry)).toThrow(/already exists/);
  });

  it('truncates only an incomplete final row during startup restabilization', () => {
    const projectRoot = root(); const path = appLogFile(projectRoot); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify({ version: 1, type: 'rows', rows: [entry()] })}\n{"version":1`);
    const store = new AppLogStore(projectRoot, new ApplicationPersistenceHealth()); store.restabilize();
    expect(readAppLogEntries(projectRoot)).toEqual([entry()]);
    expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify({ version: 1, type: 'rows', rows: [entry()] })}\n`);
  });

  it('fails on malformed complete rows', () => {
    const malformedRoot = root(); const malformedPath = appLogFile(malformedRoot); mkdirSync(dirname(malformedPath), { recursive: true }); writeFileSync(malformedPath, '{bad}\n');
    expect(() => new AppLogStore(malformedRoot, new ApplicationPersistenceHealth()).restabilize()).toThrow(/malformed/);
  });
});
