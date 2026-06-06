import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { navigate_back, navigate_workspace } from '../../src/tools/analyst-workspace-tools.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';
import { CardStore } from '../../src/cards/card-store.js';

function setupRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 's08-nav-'));
  mkdirSync(join(root, '.saivage', 'runtime'), { recursive: true });
  return root;
}

function readAudit(root: string): Array<Record<string, unknown>> {
  const raw = readFileSync(join(root, '.saivage', 'runtime', 'control-actions.jsonl'), 'utf-8').trim();
  return raw.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('analyst navigation tools', () => {
  it('returns a structured navigate_workspace intent for analyst callers', async () => {
    const root = setupRoot();
    try {
      const target = { kind: 'card' as const, id: 'card-1' };
      const ctx: ToolContext = { projectRoot: root, store: new CardStore(root), actor: 'analyst', surface: 'web-chat' };
      const result = await navigate_workspace(ctx, { target });
      expect(result).toEqual({ success: true, data: { intent: 'navigate_workspace', target } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('denies navigate_workspace for non-analyst actors', async () => {
    const root = setupRoot();
    try {
      const ctx: ToolContext = { projectRoot: root, store: new CardStore(root), actor: 'planner', surface: 'web-chat' };
      const result = await navigate_workspace(ctx, { target: { kind: 'card', id: 'card-1' } });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Denied by authorization policy');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('returns a structured navigate_back intent for analyst callers', async () => {
    const root = setupRoot();
    try {
      const ctx: ToolContext = { projectRoot: root, store: new CardStore(root), actor: 'analyst', surface: 'web-chat' };
      const result = await navigate_back(ctx);
      expect(result).toEqual({ success: true, data: { intent: 'navigate_back' } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('records low-safety audit entries for both navigation actions', async () => {
    const root = setupRoot();
    try {
      const ctx: ToolContext = { projectRoot: root, store: new CardStore(root), actor: 'analyst', surface: 'web-chat' };
      await navigate_workspace(ctx, { target: { kind: 'process', id: 'pid-1' } });
      await navigate_back(ctx);
      const entries = readAudit(root);
      expect(entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ action: 'workspace.navigate', target_kind: 'session', target_id: 'process:pid-1', outcome: 'ok', safety_class: 'low' }),
        expect.objectContaining({ action: 'workspace.navigate_back', target_kind: 'session', target_id: 'workspace', outcome: 'ok', safety_class: 'low' }),
      ]));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
