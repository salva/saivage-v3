import { afterEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';

import { CandidateAvailabilityStore } from '../../src/agents/candidate-availability-store.js';
import { ApplicationPersistenceHealth } from '../../src/application/persistence-health.js';
import { appLogEntrySchema, AppLogStore, readAppLogEntries, type AppLogEntry } from '../../src/persistence/app-log.js';
import { parseGrowingFile, serializeGrowingEnvelope } from '../../src/persistence/growing-file.js';
import { appLogFile } from '../../src/persistence/layout.js';
import { providerExchangeAppLogEntry } from '../../src/persistence/provider-exchange-log.js';

const roots: string[] = [];
function root(): string { const value = mkdtempSync(join(tmpdir(), 'saivage-growing-contract-')); roots.push(value); return value; }
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

const time = '2026-07-14T00:00:00.000Z';
const event = (): AppLogEntry => ({ id: 'evt-1', timestamp: time, type: 'event', data: { id: 'evt-1', kind: 'runtime_diagnostic', timestamp: time, error_message: 'failure', metadata: { arbitrary: { nested: true } } } });

describe('strict growing-file contract', () => {
  it('serializes one exact envelope and flattens grouped rows in physical order', () => {
    const schema = z.object({ id: z.string(), nested: z.object({ value: z.number() }).strict() }).strict();
    const first = serializeGrowingEnvelope([{ id: 'a', nested: { value: 1 } }, { id: 'b', nested: { value: 2 } }], schema);
    const second = serializeGrowingEnvelope([{ id: 'c', nested: { value: 3 } }], schema);
    expect(first.toString()).toBe('{"version":1,"type":"rows","rows":[{"id":"a","nested":{"value":1}},{"id":"b","nested":{"value":2}}]}\n');
    expect(parseGrowingFile('test.jsonl', `${first}${second}`, schema).map((row) => row.id)).toEqual(['a', 'b', 'c']);
  });

  it('rejects unknown envelope, row, and known-nested fields without stripping', () => {
    const schema = z.object({ id: z.string(), nested: z.object({ value: z.number() }).strict() }).strict();
    for (const value of [
      { version: 1, type: 'rows', rows: [{ id: 'a', nested: { value: 1 } }], extra: true },
      { version: 1, type: 'rows', rows: [{ id: 'a', nested: { value: 1 }, extra: true }] },
      { version: 1, type: 'rows', rows: [{ id: 'a', nested: { value: 1, extra: true } }] },
    ]) expect(() => parseGrowingFile('test.jsonl', `${JSON.stringify(value)}\n`, schema)).toThrow(/malformed/);
  });

  it('validates every retained app-log union member and identity correlation', () => {
    const provider = providerExchangeAppLogEntry({
      session_id: 'planner:project', source_input_id: 'input-1', attempt_index: 0, timestamp: time,
      payload: { contract_id: 'c', contract_name: 'contract', transport: 'generic', provider: 'p', model: 'm', source_input_id: 'input-1', attempt_index: 0, request_params: { opaque: { accepted: true } }, started_at: time, completed_at: time, status: 'error', terminal_tool_fired: null, error: { name: 'Error', message: 'failed' } },
    });
    const rows: AppLogEntry[] = [
      event(),
      { id: 'err-1', timestamp: time, type: 'error', data: { id: 'err-1', timestamp: time, kind: 'error', message: 'failed', metadata: { opaque: [1, 2] } } },
      { id: 'ctl-1', timestamp: time, type: 'control_action', data: { id: 'ctl-1', actor: 'runtime', surface: 'runtime', action: 'test', target_kind: null, target_id: null, params_summary: '', outcome: 'ok', outcome_summary: 'ok', created_at: time } },
      provider,
      { id: 'review-1', timestamp: time, type: 'content_review', data: { id: 'review-1', source_kind: 'tool', source_ref: 'tool:test', status: 'passed', summary: 'ok', risk: 'low', created_at: time } },
    ];
    expect(rows.map((row) => appLogEntrySchema.parse(row).type)).toEqual(['event', 'error', 'control_action', 'provider_exchange', 'content_review']);
    expect(() => appLogEntrySchema.parse({ ...event(), id: 'wrong' })).toThrow(/payload identity/);
    expect(() => appLogEntrySchema.parse({ id: 'old', timestamp: time, type: 'card_deleted', data: {} })).toThrow();
    expect(() => appLogEntrySchema.parse({ ...event(), data: { ...event().data, unknown: true } })).toThrow();
  });

  it('atomically publishes the first app-log envelope, appends the second, and reloads typed rows', () => {
    const projectRoot = root();
    const store = new AppLogStore(projectRoot, new ApplicationPersistenceHealth());
    store.restabilize();
    expect(existsSync(appLogFile(projectRoot))).toBe(false);
    store.append(event());
    store.append({ id: 'err-1', timestamp: time, type: 'error', data: { id: 'err-1', timestamp: time, kind: 'error', message: 'failed' } });
    expect(readFileSync(appLogFile(projectRoot), 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
    expect(readAppLogEntries(projectRoot, 'error')[0]?.data.message).toBe('failed');
  });

  it('fails startup on zero-byte canonical app-log and provider-availability targets without deleting them', () => {
    const appRoot = root(); const appPath = appLogFile(appRoot); mkdirSync(dirname(appPath), { recursive: true }); writeFileSync(appPath, '');
    expect(() => new AppLogStore(appRoot, new ApplicationPersistenceHealth()).restabilize()).toThrow(/empty/);
    expect(existsSync(appPath)).toBe(true);

    const availabilityRoot = root(); const availability = new CandidateAvailabilityStore(availabilityRoot, new ApplicationPersistenceHealth());
    mkdirSync(dirname(availability.jsonlPath), { recursive: true }); writeFileSync(availability.jsonlPath, '');
    expect(() => availability.restabilize()).toThrow(/empty/);
    expect(existsSync(availability.jsonlPath)).toBe(true);
  });
});
