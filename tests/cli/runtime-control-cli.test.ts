import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../../src/cli.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { initRuntimeState, updateRuntimeState } from '../helpers/runtime-state.js';
import { readRuntimeState } from '../../src/runtime/state-api.js';
import { listControlActions } from '../../src/persistence/control-action-audit.js';
import { runtimeProcessLockFile } from '../../src/persistence/layout.js';

describe('direct offline runtime controls', () => {
  const originalCwd = process.cwd();
  afterEach(() => process.chdir(originalCwd));

  it('keeps pause state and service-owned audit inside direct lifecycle-lock execution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-cli-runtime-control-'));
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      initProjectTree(root);
      initRuntimeState(root);
      updateRuntimeState(root, { status: 'running' });
      process.chdir(root);

      await run(['node', 'saivage', 'pause']);

      expect(readRuntimeState(root)?.status).toBe('paused');
      expect(listControlActions(root)).toHaveLength(1);
      expect(listControlActions(root)[0]).toMatchObject({ action: 'runtime.pause', surface: 'cli', outcome: 'ok' });
      expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
    } finally {
      log.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
