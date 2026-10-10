import assert from 'node:assert/strict';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';

const root = process.argv[2]!;
const registry = new ManagedProcessGroupRegistry();
const runner = new ProcessRunner(root, registry, testApplicationFatalPort);
const scope = runner.createDirectScope(registry.rootScope, 'natural-exit', 'runtime_card');
try {
  const record = runner.spawn({
    command: 'exit 0',
    directScope: scope,
    category: 'runtime_card',
    ownerId: 'natural-exit',
    ownerKind: 'agent',
  });
  // Enter the bounded branch synchronously, before child events can settle it.
  assert.equal(runner.get(record.id)!.status, 'running');
  const result = await runner.wait(record.id, 60_000);
  assert.equal(result.status, 'exited');
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
} finally {
  const report = await runner.closeAndTerminateDirectScope({
    directScope: scope,
    category: 'runtime_card',
    reason: 'fixture cleanup',
    graceMs: 100,
  });
  assert.deepEqual(report.failed, []);
}
console.log('process-wait-natural-exit: complete');
