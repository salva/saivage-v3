import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { Interface } from 'node:readline/promises';
import { join } from 'node:path';
import { run } from '../../src/cli.js';

const [, , fault, ...args] = process.argv;
if (fault === 'release') {
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
} else if (fault === 'late-stderr') {
  const stderrWrite = process.stderr.write;
  const stdoutWrite = process.stdout.write;
  let pending: Error | undefined;
  let intercepted = false;
  process.stderr.write = (...params: unknown[]) => {
    if (!intercepted && String(params[0]).startsWith('GC ')) {
      intercepted = true;
      pending = Object.assign(new Error('injected late advisory write error'), { code: 'EPIPE' });
      return true;
    }
    return Reflect.apply(stderrWrite, process.stderr, params);
  };
  process.stdout.write = (...params: unknown[]) => {
    if (pending) {
      const error = pending;
      pending = undefined;
      process.stderr.emit('error', error);
      fs.writeSync(2, 'LATE_STDERR_ERROR_EMITTED\n');
    }
    return Reflect.apply(stdoutWrite, process.stdout, params);
  };
} else {
  throw new Error('Unknown offline GC child fault');
}
await run(['node', 'saivage', 'gc-work', ...args]);
if (fault === 'release') process.stdout.write('FORBIDDEN_NORMAL_RETURN\n');
