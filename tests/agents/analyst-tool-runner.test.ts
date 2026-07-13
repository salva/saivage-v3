import { initProjectTree, CardStore } from '../helpers/canonical-project.js';
import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertAnalystInspectionTarget } from '../../src/workspace/file-access-security.js';
import { runAuditedAnalystTool } from '../../src/agents/analyst-tool-runner.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';

import { ProcessRunner } from '../../src/runtime/process-runner.js';

import { readAppLogEntries } from '../../src/persistence/app-log.js';

function setupRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 's02-runner-'));
  initProjectTree(root);
  return root;
}

function readAudit(root: string): Array<Record<string, unknown>> {
  return readAppLogEntries(root, 'control_action').map((entry) => entry.data as Record<string, unknown>);
}

describe('Audited analyst tool runner', () => {
  function ctx(root: string): ToolContext {
    return { projectRoot: root, processRunner: new ProcessRunner(root), store: new CardStore(root), actor: 'analyst', surface: 'web-chat', restartServerAvailable: false };
  }

  it('records schema-safe audit entries for allowed mutations', async () => {
    const root = setupRoot();
    try {
      const result = await runAuditedAnalystTool(ctx(root), { id: 'card-1' }, {
        action: 'card.test_low',
        safety_class: 'low',
        target_kind: 'card',
        getTargetId: (params) => String(params.id),
        run: async () => ({ success: true, data: { applied: true } }),
      });
      expect(result.success).toBe(true);
      const [entry] = readAudit(root);
      expect(entry).toMatchObject({ actor: 'analyst', surface: 'web-chat', action: 'card.test_low', target_kind: 'card', target_id: 'card-1', outcome: 'ok' });
      expect(typeof entry.created_at).toBe('string');
      expect(() => new Date(String(entry.created_at)).toISOString()).not.toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('allows destructive analyst tools on web-chat without an out-of-band confirmation gate', async () => {
    const root = setupRoot();
    try {
      const result = await runAuditedAnalystTool(ctx(root), { id: 'card-1' }, {
        action: 'card.test_delete',
        safety_class: 'destructive',
        target_kind: 'card',
        getTargetId: (params) => String(params.id),
        run: async () => ({ success: true, data: { deleted: ['card-1'] } }),
      });
      expect(result.success).toBe(true);
      expect(readAudit(root)[0]).toMatchObject({ action: 'card.test_delete', outcome: 'ok' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('denies secret-classified analyst inspection targets with a redacted message', () => {
    const root = setupRoot();
    try {
      const secretPath = join(root, '.saivage', 'auth-profiles.json');
      writeFileSync(secretPath, 'do-not-read');
      expect(() => assertAnalystInspectionTarget(secretPath)).toThrow('Access denied: secret-bearing path is off-limits.');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
