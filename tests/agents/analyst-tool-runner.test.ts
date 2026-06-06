import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertAnalystInspectionTarget } from '../../src/workspace/file-access-security.js';
import { runAuditedAnalystTool } from '../../src/agents/analyst-tool-runner.js';
import type { ToolContext } from '../../src/agents/analyst-tools.js';

function setupRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 's02-runner-'));
  mkdirSync(join(root, '.saivage', 'runtime'), { recursive: true });
  return root;
}

function readAudit(root: string): Array<Record<string, unknown>> {
  const raw = readFileSync(join(root, '.saivage', 'runtime', 'control-actions.jsonl'), 'utf-8').trim();
  return raw.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('Audited analyst tool runner', () => {
  it('records schema-safe audit entries for allowed mutations', async () => {
    const root = setupRoot();
    try {
      const ctx: ToolContext = { projectRoot: root, actor: 'analyst', surface: 'web-chat' };
      const result = await runAuditedAnalystTool(ctx, { id: 'card-1' }, {
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
      const ctx: ToolContext = { projectRoot: root, actor: 'analyst', surface: 'web-chat' };
      const result = await runAuditedAnalystTool(ctx, { id: 'card-1' }, {
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
