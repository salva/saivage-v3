import { afterEach, expect, test, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, openSync, writeSync, closeSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTestProcessRunner, cleanupTestProcessRunners } from '../helpers/test-process-runner.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { runGitWorkflow } from '../../src/runtime/git-workflow.js';
import { randomUUID } from 'node:crypto';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await cleanupTestProcessRunners(root); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-stdin-')); roots.push(root);
  const composition = createTestProcessRunner(root);
  const runner = composition.processRunner;
  const scope = runner.createDirectScope(composition.runtimeProcessRootScope, 'stdin', 'runtime_card');
  return { runner, scope };
}

test('one captured stdin carries binary and NUL bytes without argv encoding', async () => {
  const { runner, scope } = fixture();
  const bytes = Buffer.from(Array.from({ length: 262144 }, (_, i) => i % 256));
  const record = runner.spawnCaptured({ file: process.execPath,
    args: ['-e', 'process.stdin.pipe(process.stdout)'], stdin: bytes,
    directScope: scope, category: 'runtime_card', ownerId: 'binary', ownerKind: 'runtime', onSpawn() {} });
  const settled = await runner.waitForSettlement(record.id);
  expect(settled.record.status).toBe('exited');
  expect(readFileSync(record.stdout_path)).toEqual(bytes);
  expect(record.command).not.toContain(bytes.toString('base64'));
});

test.each(['broken-pipe', 'deadline', 'cancel'] as const)('captured stdin %s settles rather than resending or hanging', async mode => {
  const { runner, scope } = fixture();
  const record = runner.spawnCaptured({ file: process.execPath,
    args: ['-e', mode === 'broken-pipe' ? 'process.exit(0)' : 'setTimeout(()=>{}, 30000)'],
    stdin: Buffer.alloc(8 * 1024 * 1024, 123), directScope: scope,
    category: 'runtime_card', ownerId: mode, ownerKind: 'runtime', onSpawn() {} });
  const terminal = runner.waitForSettlement(record.id).then(value => ({ value }), error => ({ error }));
  if (mode !== 'broken-pipe') {
    await new Promise(resolve => setTimeout(resolve, 100));
    await expect(runner.kill(record.id, { directScope: scope, category: 'runtime_card', graceMs: 100, reason: mode }))
      .rejects.toThrow(/stdin/);
  }
  const outcome = await terminal;
  expect('error' in outcome).toBe(true);
  if ('error' in outcome) expect(String(outcome.error)).toMatch(/stdin/);
}, 10000);

test('native capture publication uncertainty is fatal before Git launch or scope cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-fatal-'));
  mkdirSync(join(root, '.saivage/cards/project/records'), { recursive: true });
  const registry = new ManagedProcessGroupRegistry();
  const fatal = new Error('fatal test boundary');
  const port = { publicationOutcomeUnknown: jest.fn((): never => { throw fatal; }) };
  const close = jest.fn(closeSync), rename = jest.fn(() => { throw new Error('injected rename uncertainty'); });
  const runner = new ProcessRunner(root, registry, port, { replacement: {
    open: openSync, write: writeSync, fsync: fsyncSync, close, rename,
  } });
  const cleanup = jest.spyOn(runner, 'closeAndTerminateDirectScope');
  const launch = jest.spyOn(registry, 'launch');
  await expect(runGitWorkflow({ request: { step: 'checkpoint', project_root: root, timeout_ms: 1000,
    source: { source_roots: ['.'], excluded_paths: ['.git', '.saivage'] },
    expected: { branch_ref: 'refs/heads/main', observed_tip: 'a'.repeat(40) } },
    runner, parentScope: registry.rootScope, invocationId: randomUUID(), cardId: 'project',
    binding: { origin: 'activation', activation_id: randomUUID(), parent_card_id: null, node: null },
    signal: new AbortController().signal, assertCurrent() {},
  })).rejects.toBe(fatal);
  expect(port.publicationOutcomeUnknown).toHaveBeenCalledTimes(1);
  expect(cleanup).not.toHaveBeenCalled(); expect(launch).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(1); expect(rename).toHaveBeenCalledTimes(1);
});
