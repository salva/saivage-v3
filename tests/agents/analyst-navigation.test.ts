import { initProjectTree, CardStore, testConfigAuthority, testInterventionReadiness, testPersistenceHealth } from '../helpers/canonical-project.js';
import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { navigate_back, navigate_workspace } from '../../src/tools/analyst-workspace-tools.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';

import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { createTestProcessRunner } from '../helpers/test-process-runner.js';
import { testAppLogs } from '../helpers/app-logs.js';

import { readAppLogEntries } from '../../src/persistence/app-log.js';

function setupRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 's08-nav-'));
  initProjectTree(root);
  return root;
}

function readAudit(root: string): Array<Record<string, unknown>> {
  return readAppLogEntries(root, 'control_action').map((entry) => entry.data as Record<string, unknown>);
}

describe('analyst navigation tools', () => {
  function ctx(root: string, actor: ToolContext['actor'] = 'analyst'): ToolContext {
    const processRunner = createTestProcessRunner(root);
    const store = new CardStore(root);
    return { projectRoot: root, configAuthority: testConfigAuthority(root), persistenceHealth: testPersistenceHealth(root), interventionReadiness: testInterventionReadiness(), processRunner, processScope: processRunner.createDirectScope(processRunner.analystRootScope, 'test-analyst', 'operator_session'), store, actor, surface: 'web-chat', restartServerAvailable: false, appLogs: testAppLogs(root) };
  }

  it('returns a structured navigate_workspace intent for analyst callers', async () => {
    const root = setupRoot();
    try {
      const target = { kind: 'card' as const, id: 'card-1' };
      const result = await navigate_workspace(ctx(root), { target });
      expect(result).toEqual({ success: true, data: { intent: 'navigate_workspace', target } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('returns a structured navigate_back intent for analyst callers', async () => {
    const root = setupRoot();
    try {
      const result = await navigate_back(ctx(root));
      expect(result).toEqual({ success: true, data: { intent: 'navigate_back' } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps navigation intents outside mutation audit', async () => {
    const root = setupRoot();
    try {
      const toolCtx = ctx(root);
      await navigate_workspace(toolCtx, { target: { kind: 'process', id: 'pid-1' } });
      await navigate_back(toolCtx);
      const entries = readAudit(root);
      expect(entries).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
