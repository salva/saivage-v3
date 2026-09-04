import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { controlActionAuditEntrySchema } from '../../src/schemas/validators.js';
import { appendAppLogEntry } from '../../src/persistence/app-log.js';
import { appLogFile } from '../../src/persistence/layout.js';
import { listControlActions, recordControlAction } from '../../src/persistence/control-action-audit.js';
import { OUTBOUND_IDENTITY, OUTBOUND_RAW_MARKER } from '../helpers/outbound-identity-fixtures.js';

let projectRoot: string;
beforeEach(() => { projectRoot = mkdtempSync(join(tmpdir(), 'saivage-control-action-audit-')); });
afterEach(() => { rmSync(projectRoot, { recursive: true, force: true }); });

const input = {
  id: 'tok_audit', created_at: '2026-01-01T00:00:00.000Z', actor: 'analyst' as const, surface: 'rest' as const,
  action: OUTBOUND_IDENTITY, target_kind: 'runtime' as const, target_id: 'sk-target', params_summary: `apiKey="${OUTBOUND_RAW_MARKER}"`,
  outcome: 'error' as const, outcome_summary: 'token=hunter2', error: 'password=abc123',
};

describe('control action audit persistence', () => {
  it('prepares, redacts, validates, and appends one control row inside the publication boundary', () => {
    let preparations = 0;
    const created = recordControlAction(projectRoot, () => { preparations += 1; return input; });
    expect(preparations).toBe(1);
    expect(controlActionAuditEntrySchema.parse(created)).toEqual(created);
    expect(created.params_summary).toContain('[REDACTED]');
    expect(created.outcome_summary).toContain('[REDACTED]');
    expect(created.error).toContain('[REDACTED]');
    expect(created).toMatchObject({ id: 'tok_audit', actor: 'analyst', surface: 'rest', action: OUTBOUND_IDENTITY, target_kind: 'runtime', target_id: 'sk-target' });
    const path = join(projectRoot, '.saivage', 'logs', 'app.jsonl');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).not.toContain(OUTBOUND_RAW_MARKER);
    expect(listControlActions(projectRoot)).toEqual([created]);
  });

  it('preserves audit preparation failure before publication', () => {
    const preparationFailure = new Error('audit preparation failed');
    let thrown: unknown;
    try { recordControlAction(projectRoot, () => { throw preparationFailure; }); }
    catch (error) { thrown = error; }
    expect(thrown).toBe(preparationFailure);
    expect(existsSync(join(projectRoot, '.saivage'))).toBe(false);
  });

  it('rejects a duplicate before publication and retains one readable action', () => {
    const created = recordControlAction(projectRoot, () => input);
    expect(() => recordControlAction(projectRoot, () => input)).toThrow(/duplicate logical id 'tok_audit'/);
    const rows = readFileSync(join(projectRoot, '.saivage', 'logs', 'app.jsonl'), 'utf8').trim().split('\n').flatMap((line) => (JSON.parse(line) as { rows: Array<{ data: { id: string } }> }).rows);
    expect(rows.map((row) => row.data.id)).toEqual(['tok_audit']);
    expect(listControlActions(projectRoot)).toEqual([created]);
  });

  it('strictly reads once before redacting, narrowing, and sorting every retained actor row', () => {
    const entries = [
      { ...input, id: 'planner-old', actor: 'planner' as const, target_kind: 'card' as const, target_id: 'card-a', params_summary: 'safe', outcome_summary: 'safe', error: undefined, created_at: '2026-01-01T00:00:00.000Z' },
      { ...input, id: 'analyst-middle', target_kind: 'card' as const, target_id: 'card-b', params_summary: 'safe', outcome_summary: 'safe', error: undefined, created_at: '2026-01-02T00:00:00.000Z' },
      { ...input, id: 'analyst-new', target_kind: 'card' as const, target_id: 'card-a', created_at: '2026-01-03T00:00:00.000Z' },
    ];
    for (const entry of entries) appendAppLogEntry(projectRoot, 'control_action', () => ({ type: 'control_action', data: controlActionAuditEntrySchema.parse(entry) }));

    const all = listControlActions(projectRoot);
    expect(all.map((entry) => entry.id)).toEqual(['analyst-new', 'analyst-middle', 'planner-old']);
    expect(all.at(-1)).toMatchObject({ id: 'planner-old', actor: 'planner' });
    expect(listControlActions(projectRoot, { card_id: 'card-a' }).map((entry) => entry.id)).toEqual(['analyst-new', 'planner-old']);
    expect(listControlActions(projectRoot, { since: '2026-01-02T00:00:00.000Z' }).map((entry) => entry.id)).toEqual(['analyst-new', 'analyst-middle']);
    expect(all[0]).toMatchObject({ action: OUTBOUND_IDENTITY, params_summary: 'apiKey=[REDACTED]', outcome_summary: 'token=[REDACTED]', error: 'password=[REDACTED]' });
  });

  it('fails a narrowed query when any complete canonical stream content is malformed', () => {
    recordControlAction(projectRoot, () => input);
    const path = appLogFile(projectRoot);
    writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('{complete malformed}\n')]));

    expect(() => listControlActions(projectRoot, { card_id: 'card-does-not-match', since: '2099-01-01T00:00:00.000Z' })).toThrow(/malformed/);
  });
});
