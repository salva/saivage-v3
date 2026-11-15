import assert from 'node:assert/strict';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Native execution observes the actual builtin bindings, outside Jest's VM modules.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, operation, encoded = '{}'] = process.argv.slice(2);
  const input = JSON.parse(encoded);
  const allocated = [], calls = [];
  const mkdir = fs.mkdtempSync, spawn = childProcess.spawnSync;
  const sentinel = join(tmpdir(), `lay-07-probe-sentinel-${randomUUID()}`);
  fs.writeFileSync(sentinel, 'independently owned');
  fs.mkdtempSync = (...args) => {
    const path = mkdir(...args);
    allocated.push(path);
    return path;
  };
  childProcess.spawnSync = (...args) => {
    let result;
    if (operation === 'mock') result = calls.length === 0
      ? { status: 0, stdout: '', stderr: '' } : input;
    else if (operation === 'partial-emission') {
      const output = args[1].at(-1);
      fs.mkdirSync(join(output, 'scripts'), { recursive: true });
      fs.writeFileSync(join(output, 'scripts/collect-doc-template-inventory.js'), 'throw new Error("partial output");');
      result = { status: 1, stdout: '', stderr: 'fixture emit failure' };
    } else result = spawn(...args);
    calls.push({ args: args[1], status: result.status, stderr: result.stderr, stdout: result.stdout });
    return result;
  };
  syncBuiltinESMExports();
  try {
    const verifier = await import('../../scripts/verify-doc-routes.js');
    assert.equal(allocated.length, 0);
    assert.equal(calls.length, 0);
    let value, error;
    try {
      value = operation === 'aggregate'
        ? verifier.verifyDocSourceContracts({ projectRoot: root })
        : verifier.verifyAgentToolDocs({ projectRoot: root });
    } catch (caught) { error = caught; }
    if (operation === 'aggregate') {
      assert.equal(error, undefined);
      assert.equal(value.ok, true);
      assert.equal(calls.length, 2);
    } else {
      assert.ok(error, 'Expected visible failure');
      assert.equal(calls.length, operation === 'source' ? 0
        : operation === 'schema' || operation === 'mock' ? 2 : 1);
      if (operation === 'schema') {
        assert.deepEqual(calls.map(call => call.status), [0, 1]);
        assert.match(calls[1].stderr, /server\.port:too_small/u);
        assert.equal(calls[1].stdout, '');
      }
    }
    if (calls.length) assert.equal(calls[0].args[0], join(root, 'node_modules/typescript/bin/tsc'));
    if (calls.length === 2) {
      assert.deepEqual(calls[1].args, [join(allocated[0], 'scripts/collect-doc-template-inventory.js')]);
    }
    assert.equal(allocated.length, operation === 'source' ? 0 : 1);
    for (const path of allocated) assert.equal(fs.existsSync(path), false);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'independently owned');
    process.stdout.write(JSON.stringify({ operation, statuses: calls.map(call => call.status), exactCleanup: true, sentinelPreserved: true }));
  } finally {
    fs.mkdtempSync = mkdir;
    childProcess.spawnSync = spawn;
    syncBuiltinESMExports();
    fs.rmSync(sentinel);
  }
}
