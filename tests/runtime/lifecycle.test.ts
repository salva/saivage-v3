import { describe, expect, it } from '@jest/globals';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createRuntimeLifecycleScope } from '../../src/runtime/lifecycle.js';

describe('RuntimeLifecycleScope child processes', () => {
  it('terminates a retained process group after its direct child exits', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'saivage-runtime-lifecycle-'));
    const pidFile = join(directory, 'descendant.pid');
    const child = spawn('sh', ['-c', `sleep 60 & echo $! > ${JSON.stringify(pidFile)}; exit`], {
      detached: true,
      stdio: 'ignore',
    });
    const scope = createRuntimeLifecycleScope('test-child-group-kill');
    scope.registerChildProcess(child, 'kill', 'descendant-group');

    try {
      for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const descendantPid = Number(readFileSync(pidFile, 'utf8').trim());
      if (!Number.isInteger(descendantPid) || descendantPid <= 0) throw new Error('descendant did not report a PID');
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      }

      const report = await scope.dispose();

      expect(report).toEqual([expect.objectContaining({ label: 'descendant-group', status: 'killed' })]);
      expect(() => process.kill(descendantPid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    } finally {
      await scope.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
