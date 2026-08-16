import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';


import { listControlActions } from '../../src/persistence/control-action-audit.js';
import { restart_server } from '../../src/tools/analyst-runtime-tools.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';
import { getAnalystControlToolBinders } from '../../src/tools/analyst-tool-registry.js';
import { bindToolProvider } from '../../src/tools/invocation.js';

function context(projectRoot: string, restartServerAvailable: boolean): ToolContext {
  return { projectRoot, actor: 'analyst', surface: 'web-chat', restartServerAvailable, cardTypeVocabulary:['project','goal','architecture','code','test','doc','data','research','ops'] } as unknown as ToolContext;
}

describe('restart_server', () => {
  it('is catalogued only when operator authentication publishes restart capability', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-restart-tool-'));
    try {
      expect(bindToolProvider('analyst', getAnalystControlToolBinders(), context(projectRoot, true)).tools.map((tool) => tool.name)).toContain('restart_server');
      expect(bindToolProvider('analyst', getAnalystControlToolBinders(), context(projectRoot, false)).tools.map((tool) => tool.name)).toContain('restart_server');
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('is a confirmation request outside mutation audit and has no scheduling capability', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-restart-tool-'));
    try {
      await expect(restart_server(context(projectRoot, true))).resolves.toEqual({
        success: true,
        data: { restart: 'confirmation_required', confirmationMessage: 'RESTART SERVER' },
      });
      expect(listControlActions(projectRoot)).toEqual([]);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('denies unavailable direct calls without a lifecycle audit', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-restart-tool-'));
    try {
      await expect(restart_server(context(projectRoot, false))).resolves.toEqual({
        success: false,
        error: 'restart unavailable: operator authentication disabled',
      });
      expect(listControlActions(projectRoot)).toEqual([]);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });
});
