import { startProcess, killProcess } from '../src/utils/process-runner.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../src/utils/file-tree.js';

const root = mkdtempSync(join(tmpdir(), 'test-sigkill-'));
initProjectTree(root);
const rec = startProcess(root, 'trap "" TERM; sleep 30', { cardId: 'test' });
console.log('Started:', rec.id, 'pid:', rec.pid);

setTimeout(async () => {
  console.log('Killing...');
  const killed = await killProcess(root, rec.id, 200);
  console.log('Result status:', killed.status);
  console.log('Result exit_code:', killed.exit_code);
  rmSync(root, { recursive: true, force: true });
  process.exit(0);
}, 500);
