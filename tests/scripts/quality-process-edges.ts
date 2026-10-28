import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { executeFiniteOperation, resolveOperationReadablePath } from '../../src/runtime/operation-execution.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner, ProcessEvidenceUnavailableError } from '../../src/runtime/process-runner.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { waitFor } from '../helpers/production-composition-e2e.js';

const tools = process.env.SAIVAGE_QUALITY_NATIVE_ROOT;
const scratch = process.env.SAIVAGE_QUALITY_TEST_SCRATCH;
if (!tools || !scratch || process.env.NODE_DISABLE_COMPILE_CACHE !== '1') throw new Error('Explicit native prerequisites required.');
const fatalChild = process.argv[2] === 'fatal-child';
const root = fatalChild ? process.argv[3]! : mkdtempSync(join(scratch, 'quality-process-'));
const registry = new ManagedProcessGroupRegistry();
const runner = new ProcessRunner(root, registry, { publicationOutcomeUnknown(): never { process.exit(73); } });
const operation = compileProjectWorkflows(TEST_SAIVAGE_CONFIG).operations.get('code-quality.javascript.eslint')!;
const config = { cwd: 'fixtures', native_config: 'fixtures/slow.mjs', source_paths: ['fixtures/clean.js'], exclusions: [],
  node_binary: process.execPath, eslint_module: 'node_modules/eslint', timeout_ms: 30000, terminate_grace_ms: 100 };
const invoke = (signal: AbortSignal, timeout: number, observe?: Parameters<typeof executeFiniteOperation>[0]['observe']) => executeFiniteOperation({
  projectRoot: root, invocationId: randomUUID(), operation, config: { ...config, timeout_ms: timeout }, inputs: {},
  processRunner: runner, parentScope: registry.rootScope,
  attribution: { category: 'operator_session', cardId: null, ownerKind: 'operator', ownerId: 'quality-process-fixture' },
  collectOutput: true, signal, observe,
  resolveReadablePath: (path) => resolveOperationReadablePath(root, path),
  retainSettlementFailure() { /* Shared finite body retains and throws it. */ },
});
if (fatalChild) {
  // Deterministic failure at the actual owner's launch boundary, not a fake
  // analyzer result. Fatal process termination must preempt every cleanup/read.
  runner.spawnCaptured = () => { throw new PublicationOutcomeUnknownError(new Error('synthetic launch publication uncertainty')); };
  runner.closeAndTerminateDirectScope = async () => { console.log('FORBIDDEN-CLEANUP'); throw new Error('cleanup'); };
  try {
    await invoke(new AbortController().signal, 30000, (row) => { console.log(row.kind); });
    console.log('FORBIDDEN-RETURN');
  } finally { console.log('FORBIDDEN-FINALLY'); }
} else {
  // Unlike an App fixture, this standalone owner has no listening server.
  // Group-absence polling intentionally uses unreferenced timers after child
  // handles close. Keep this harness alive through settlement AND final cleanup,
  // with a finite failing deadline rather than changing production ownership.
  const harnessDeadline = setTimeout(() => {
    throw new Error('Quality process-edge harness exceeded its 180000ms deadline.');
  }, 180000);
  try {
    cpSync(join(tools, 'node_modules'), join(root, 'node_modules'), { recursive: true });
    cpSync(join(tools, 'fixtures'), join(root, 'fixtures'), { recursive: true });
    // Native config is deliberately slow and creates a managed descendant. No
    // successful findings are synthesized. Real fixed helper and ESLint load it.
    writeFileSync(join(root, 'fixtures/slow.mjs'), `import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {appendFileSync,existsSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
const marker=new URL('./entered.json',import.meta.url);
const staging=new URL('./entered.next.json',import.meta.url);
const prior=existsSync(marker)?readFileSync(marker,'utf8'):null;
if(prior!==null) assert.equal(prior,'{}');
const payload=JSON.stringify({child:child.pid,parent:process.pid});
// Incomplete staging must expose neither partial bytes nor a new canonical file.
writeFileSync(staging,payload.slice(0,1));
if(prior===null) assert.equal(existsSync(marker),false);
else {
  const retained=readFileSync(marker,'utf8');
  assert.equal(retained,prior);
  assert.deepEqual(JSON.parse(retained),{});
}
appendFileSync(staging,payload.slice(1));
renameSync(staging,marker);
await new Promise(()=>{});
export default [];
`);
    const timed = await invoke(new AbortController().signal, 3000);
    assert.equal(timed.result.outcome, 'timed_out');
    assert.equal(timed.result.values.coverage_complete, false);
    assert.equal(timed.evidence.process?.group, 'absent');
    assert.equal(timed.evidence.process?.stdout, 'eof');
    assert.equal(timed.evidence.process?.stderr, 'eof');
    assert.deepEqual(runner.list(), []);
    assert(existsSync(join(root, 'fixtures/entered.json')), 'Timeout must occur after actual native config/descendant entry');
    const first = JSON.parse(readFileSync(join(root, 'fixtures/entered.json'), 'utf8'));
    for (const pid of [first.child, first.parent]) assert.throws(() => process.kill(pid, 0));
    writeFileSync(join(root, 'fixtures/entered.json'), '{}');
    const controller = new AbortController();
    const reason = new Error('exact quality cancellation');
    const cancelled = invoke(controller.signal, 30000);
    const rejects = assert.rejects(cancelled, (error) => error === reason);
    await waitFor(() => JSON.parse(readFileSync(join(root, 'fixtures/entered.json'), 'utf8')).child !== undefined, 'quality descendant entry');
    const second = JSON.parse(readFileSync(join(root, 'fixtures/entered.json'), 'utf8'));
    controller.abort(reason);
    await rejects;
    assert.deepEqual(runner.list(), []);
    for (const pid of [second.child, second.parent]) assert.throws(() => process.kill(pid, 0));
    const already = new AbortController(); already.abort(reason);
    let observed = false;
    await assert.rejects(invoke(already.signal, 30000, () => { observed = true; }), (error) => error === reason);
    assert.equal(observed, false);
    config.native_config = 'fixtures/eslint.config.mjs';
    const spawn = runner.spawnCaptured.bind(runner);
    const spawnFailure = new Error('synthetic process launch failure');
    runner.spawnCaptured = () => { throw spawnFailure; };
    await assert.rejects(invoke(new AbortController().signal, 30000), (error) => error === spawnFailure);
    runner.spawnCaptured = spawn;
    const wait = runner.waitForSettlement.bind(runner);
    runner.waitForSettlement = async (id) => {
      await wait(id);
      throw new ProcessEvidenceUnavailableError(id, 'synthetic capture completion failure');
    };
    await assert.rejects(invoke(new AbortController().signal, 30000), /synthetic capture completion failure/);
    runner.waitForSettlement = wait;
    assert.deepEqual(runner.list(), []);
    const cleanup = runner.closeAndTerminateDirectScope.bind(runner);
    const cleanupFailure = new Error('synthetic scope cleanup failure');
    runner.closeAndTerminateDirectScope = async (...args) => {
      await cleanup(...args);
      throw cleanupFailure;
    };
    await assert.rejects(invoke(new AbortController().signal, 30000), (error) => error === cleanupFailure);
    runner.closeAndTerminateDirectScope = cleanup;
    const fatal = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'fatal-child', root], {
      encoding: 'utf8', timeout: 30000, env: process.env, maxBuffer: 1024 * 1024,
    });
    if (fatal.error) throw fatal.error;
    assert.equal(fatal.status, 73, fatal.stderr);
    assert.equal(fatal.stdout.trim(), 'invocation_started');
    assert(!fatal.stdout.includes('FORBIDDEN'));
    console.log('Quality timeout/cancel descendant joins, spawn/capture/cleanup failure and fatal no-follow-up boundaries passed.');
  } finally {
    try {
      await runner.terminateScopeTree({ rootScope: registry.rootScope, categories: ['operator_session'], reason: 'test cleanup', graceMs: 100 });
      rmSync(root, { recursive: true, force: true });
    } finally {
      clearTimeout(harnessDeadline);
    }
  }
}
