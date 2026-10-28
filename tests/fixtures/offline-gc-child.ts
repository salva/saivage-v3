import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { Interface } from 'node:readline/promises';
import { join } from 'node:path';
import { run } from '../../src/cli.js';

const unlink = fs.unlinkSync;
fs.unlinkSync = (path) => {
  if (String(path) === join(process.cwd(), '.saivage/locks/runtime.lock')) {
    process.stdout.write('RELEASE_UNCERTAIN\n');
    throw new Error('injected unlink failure');
  }
  return unlink(path);
};
syncBuiltinESMExports();
Interface.prototype.close = function () { process.stdout.write('FORBIDDEN_PROMPT_CLOSE\n'); return this; };
await run(['node', 'saivage', 'gc-work']);
process.stdout.write('FORBIDDEN_NORMAL_RETURN\n');
