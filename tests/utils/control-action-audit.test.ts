import { initProjectTree } from '../helpers/canonical-project.js';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { controlActionAuditEntrySchema } from '../../src/schemas/validators.js';
import { listControlActions, recordControlAction } from '../../src/persistence/control-action-audit.js';
import { testAppLogs } from '../helpers/app-logs.js';


let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'saivage-control-action-audit-'));
  initProjectTree(projectRoot);
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('control action audit persistence', () => {
  it('appends and reloads validated redacted audit entries after recreation', () => {
    const created = recordControlAction(testAppLogs(projectRoot), {
      id: 'audit-1',
      created_at: '2026-01-01T00:00:00.000Z',
      actor: 'analyst',
      surface: 'web-chat',
      action: 'card.update',
      target_kind: 'card',
      target_id: 'goal-1',
      params_summary: 'apiKey="secret-123" token=hunter2 nested password=abc123',
      outcome: 'error',
      outcome_summary: 'request rejected because secret=bad-value leaked',
      error: 'provider token=shh-secret api-key="still-secret"',
    });

    expect(controlActionAuditEntrySchema.parse(created)).toEqual(created);
    expect(created.params_summary).toContain('[REDACTED]');
    expect(created.params_summary).not.toMatch(/secret-123|hunter2|abc123/);
    expect(created.error).toContain('[REDACTED]');
    expect(created.error).not.toMatch(/shh-secret|still-secret/);

    const auditPath = join(projectRoot, '.saivage', 'logs', 'app.jsonl');
    expect(existsSync(auditPath)).toBe(true);
    const rawLines = readFileSync(auditPath, 'utf-8').trim().split('\n').filter(Boolean);
    expect(rawLines).toHaveLength(1);
    expect(rawLines[0]).not.toMatch(/secret-123|hunter2|abc123|shh-secret|still-secret/);

    const reloaded = listControlActions(projectRoot);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toEqual(created);
    expect(controlActionAuditEntrySchema.parse(reloaded[0])).toEqual(reloaded[0]);
  });

  it('ignores malformed jsonl entries while preserving valid latest entries across reopen', () => {
    recordControlAction(testAppLogs(projectRoot), {
      id: 'audit-1',
      created_at: '2026-01-01T00:00:00.000Z',
      actor: 'analyst',
      surface: 'rest',
      action: 'runtime.pause',
      target_kind: 'runtime',
      target_id: 'project',
      params_summary: 'pause runtime',
      outcome: 'ok',
      outcome_summary: 'paused',
    });

    const auditPath = join(projectRoot, '.saivage', 'logs', 'app.jsonl');
    const appended = [
      readFileSync(auditPath, 'utf-8'),
      '{"id":"broken"\n',
      JSON.stringify({
        id: 'app-audit-2',
        timestamp: '2026-01-02T00:00:00.000Z',
        type: 'control_action',
        data: {
          id: 'audit-2',
          actor: 'analyst',
          surface: 'cli',
          action: 'note.append',
          target_kind: 'note',
          target_id: 'n-goal-1-1',
          params_summary: 'password=swordfish',
          outcome: 'denied',
          outcome_summary: 'denied',
          created_at: '2026-01-02T00:00:00.000Z',
        },
      }) + '\n',
    ].join('');
    writeFileSync(auditPath, appended, 'utf-8');

    expect(() => listControlActions(projectRoot)).toThrow(/malformed/);
  });
});
