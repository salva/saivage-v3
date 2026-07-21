import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { controlActionAuditEntrySchema } from '../../src/schemas/validators.js';
import { listControlActions, recordControlAction } from '../../src/persistence/control-action-audit.js';
import { AppLogPublicationError } from '../../src/persistence/app-log.js';

let projectRoot: string;
beforeEach(() => { projectRoot = mkdtempSync(join(tmpdir(), 'saivage-control-action-audit-')); });
afterEach(() => { rmSync(projectRoot, { recursive: true, force: true }); });

const input = {
  id: 'audit-1', created_at: '2026-01-01T00:00:00.000Z', actor: 'analyst' as const, surface: 'rest' as const,
  action: 'runtime.pause', target_kind: 'runtime' as const, target_id: 'project', params_summary: 'apiKey="secret-123"',
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
    const path = join(projectRoot, '.saivage', 'logs', 'app.jsonl');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).not.toMatch(/secret-123|hunter2|abc123/);
    expect(listControlActions(projectRoot)).toEqual([created]);
  });

  it('wraps audit preparation failure with the settled operation error', () => {
    const preparationFailure = new Error('audit preparation failed');
    const operationError = new Error('mutation failed');
    let thrown: unknown;
    try { recordControlAction(projectRoot, () => { throw preparationFailure; }, operationError); }
    catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(AppLogPublicationError);
    expect(thrown).toMatchObject({ entryType: 'control_action', publicationCause: preparationFailure, operationError });
    expect(existsSync(join(projectRoot, '.saivage'))).toBe(false);
  });

  it('commits duplicates physically and fails strict reads without a second effect', () => {
    recordControlAction(projectRoot, () => input);
    recordControlAction(projectRoot, () => input);
    const rows = readFileSync(join(projectRoot, '.saivage', 'logs', 'app.jsonl'), 'utf8').trim().split('\n').flatMap((line) => (JSON.parse(line) as { rows: Array<{ data: { id: string } }> }).rows);
    expect(rows.map((row) => row.data.id)).toEqual(['audit-1', 'audit-1']);
    expect(() => listControlActions(projectRoot)).toThrow(/duplicate logical id/);
  });
});
