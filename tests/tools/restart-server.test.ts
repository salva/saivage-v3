import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardStore } from '../../src/cards/card-store.js';
import { listControlActions } from '../../src/persistence/index.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { restart_server } from '../../src/tools/analyst-runtime-tools.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';
import { createAnalystControlProvider } from '../../src/tools/analyst-control-provider.js';

function context(projectRoot: string, restartServerAvailable: boolean): ToolContext {
  return { projectRoot, processRunner: new ProcessRunner(projectRoot), store: new CardStore(projectRoot), actor: 'analyst', surface: 'web-chat', restartServerAvailable };
}

describe('restart_server', () => {
  it('is catalogued only for enabled-auth Analyst web chat', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-restart-tool-'));
    try {
      expect(createAnalystControlProvider(context(projectRoot, true)).tools.map((tool) => tool.name)).toContain('restart_server');
      expect(createAnalystControlProvider({ ...context(projectRoot, true), surface: 'rest' }).tools.map((tool) => tool.name)).not.toContain('restart_server');
      expect(createAnalystControlProvider({ ...context(projectRoot, false) }).tools.map((tool) => tool.name)).not.toContain('restart_server');
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('is an audited confirmation request and has no scheduling capability', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-restart-tool-'));
    try {
      await expect(restart_server(context(projectRoot, true))).resolves.toEqual({
        success: true,
        data: { restart: 'confirmation_required', confirmationMessage: 'RESTART SERVER' },
      });
      expect(listControlActions(projectRoot)).toEqual([expect.objectContaining({ outcome: 'ok', outcome_summary: 'restart confirmation required' })]);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('denies unavailable direct calls with an audited authentication reason', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-restart-tool-'));
    try {
      await expect(restart_server(context(projectRoot, false))).resolves.toEqual({
        success: false,
        error: 'Denied by permission policy for runtime.restart_server: restart unavailable: operator authentication disabled.',
        data: { action: 'runtime.restart_server', reason: 'restart unavailable: operator authentication disabled' },
      });
      expect(listControlActions(projectRoot)).toEqual([expect.objectContaining({ outcome: 'denied', outcome_summary: 'permission denied: restart unavailable: operator authentication disabled' })]);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });
});
