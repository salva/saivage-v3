import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { NotificationCenter } from '../../src/utils/notification-center.js';

describe('process termination notifications deferred', () => {
  it('does not expose process kill helpers that would emit product process-kill notifications', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-process-notification-absence-'));
    try {
      initProjectTree(projectRoot);
      const module = await import('../../src/utils/process-runner.js');
      expect(module).not.toHaveProperty('killProcess');
      expect(module).not.toHaveProperty('killAllRunning');
      const center = new NotificationCenter(projectRoot);
      expect(center.listForOperator()).toHaveLength(0);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
