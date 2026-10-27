import { afterEach, expect, jest, test } from '@jest/globals';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, symlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createSupervisorRuntimeApi } from '../../../src/runtime/actors/supervisor-runtime-api.js';
import { RuntimeGate } from '../../../src/runtime/runtime-gate.js';
import { NO_FRESHNESS_EFFECTS } from '../../../src/contracts/index.js';
import { canonicalValueSha256 } from '../../../src/schemas/index.js';
import { CardService, initProjectTree, TEST_RUNTIME_WORKFLOWS } from '../../helpers/canonical-project.js';
import { cleanupTestProcessRunners, createTestProcessRunner } from '../../helpers/test-process-runner.js';
import { createTestPromptTemplateRegistry } from '../../helpers/prompt-template-registry.js';
import { scriptedAdmissionProvider, testAutonomousCompaction } from '../../helpers/llm-test-helpers.js';
import { testApplicationFatalPort } from '../../helpers/test-application-fatal-port.js';
import { assertCleanGitDelivery, nativeGitRefs } from '../../../src/runtime/git-workflow.js';
import type { GitWorkflowPolicy } from '../../../src/runtime/card-process/card-process-config.js';
import { createObservedCollections } from '../../../src/retrieval/index.js';
import { writeProject, editProject, applyProjectPatch } from '../../../src/tools/project-file-tools.js';
import { webToolBinders } from '../../../src/tools/web-tools.js';
import { bindToolProvider } from '../../helpers/bind-tool-provider.js';
import { buildInvocationSurfaceFixture } from '../../helpers/invocation-surface-fixture.js';
import { invokeTestTool } from '../../helpers/invoke-test-tool.js';
import { McpManager } from '../../../src/mcp/mcp-manager.js';
import { McpLifecycleIngress } from '../../../src/server/composition/mcp-lifecycle-ingress.js';
import { mcpServerDefinitionsPath } from '../../../src/mcp/server-definitions.js';
import { testConfigAuthority } from '../../helpers/canonical-project.js';
import { TEST_SAIVAGE_CONFIG } from '../../helpers/test-saivage-config.js';
import * as YAML from 'yaml';

const roots: string[] = [];
const identity = { GIT_AUTHOR_NAME: 'Global fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Global fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
const previous = Object.fromEntries(Object.keys(identity).map(key => [key, process.env[key]]));
afterEach(async () => {
  jest.restoreAllMocks();
  for (const root of roots.splice(0)) await cleanupTestProcessRunners(root);
  for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
});
function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, env: { ...process.env, ...identity }, encoding: 'utf8', timeout: 5000 });
  if (result.status !== 0) throw new Error(`Fixture Git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { resolve, promise }; }
function fixture(on = true) {
  Object.assign(process.env, identity);
  const parent = '/home/salva/g/ml/tmp/2026-10-25-native-hybrid-git-attempt5-global';
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'source-')); roots.push(root);
  git(root, 'init', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), '.saivage/\nunrelated/\n');
  writeFileSync(join(root, 'source.txt'), 'original\n');
  git(root, 'add', '--all'); git(root, 'commit', '-m', 'fixture source');
  const tip = git(root, 'rev-parse', 'HEAD'); initProjectTree(root);
  const store = new CardService(root), processes = createTestProcessRunner(root);
  const namespace = 'refs/saivage/global';
  const branch = nativeGitRefs({ namespace, card_id: 'project' }, randomUUID()).branch_ref;
  git(root, 'branch', branch.slice('refs/heads/'.length));
  const policy: GitWorkflowPolicy = { enabled: true, format_version: 1, delivery_branch: 'main', private_ref_namespace: namespace,
    source_roots: ['.'], excluded_paths: ['.git', '.saivage', 'unrelated'], integration: 'squash',
    preservation: { source_checkpoint: 'eligible-worktree', interrupted_rebase: 'preserve-source-before-abort' },
    correction: { agent: 'executor', prompt: { reference: 'unused', compactable: true }, correction_prompt: { reference: 'unused', compactable: true } },
    review_bindings: Object.fromEntries([...TEST_RUNTIME_WORKFLOWS.cardTypes].map(([type, workflow]) => [type, workflow.states.has('node:review') ? { node: 'review', approved_outcome: 'approved' } : null])) };
  if (on) store.publishGitFacts('project', { kind: 'root', policy_digest: canonicalValueSha256(policy), branch_ref: branch, observed_tip: tip, base_oid: tip,
    parent: { branch_ref: 'refs/heads/main', observed_tip: tip }, candidate: null, last_delivery: null, correction: null });
  const entered = deferred<void>(), release = deferred<void>(), paused = deferred<void>();
  let calls = 0;
  const supervisor = createSupervisorRuntimeApi({ ...testAutonomousCompaction, workflows: on ? { ...TEST_RUNTIME_WORKFLOWS, gitPolicy: policy } : TEST_RUNTIME_WORKFLOWS,
    retrieval: createObservedCollections(root), projectRoot: root, actorStore: store, conversations: { projectRoot: root }, runtimeGate: new RuntimeGate(),
    processRunner: processes.processRunner, runtimeProcessRootScope: processes.runtimeProcessRootScope,
    processIdentity: { pid: 1, startedAt: '2026-10-26T00:00:00.000Z' }, promptTemplates: createTestPromptTemplateRegistry(), fatalPort: testApplicationFatalPort,
    freshness: NO_FRESHNESS_EFFECTS, runtimeStatusChanged: status => { if (status === 'paused') paused.resolve(); },
    provider: scriptedAdmissionProvider(async (_input, signal) => {
      calls++; entered.resolve();
      await Promise.race([release.promise, new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))]);
      signal.throwIfAborted();
      return { result: { kind: 'tool_calls', tool_calls: [{ id: `read-${calls}`, type: 'function', function: { name: 'get_card', arguments: JSON.stringify({ card_id: 'project' }) } }] }, provider_exchanges: [] };
    }) });
  const context = { projectRoot: root, agentName: 'analyst' as const, store, assertGlobalSourceWrite: supervisor.assertGlobalSourceWrite.bind(supervisor) };
  return { root, tip, branch, store, processes, supervisor, context, entered, release, paused, calls: () => calls };
}

test('stopped final effect is synchronous; clean admission makes no index writes/hooks and later Run refuses operator dirt', async () => {
  const f = fixture(); await f.supervisor.start();
  const before = readFileSync(join(f.root, '.git/index'));
  const hook = join(f.root, '.git/hooks/post-index-change');
  writeFileSync(hook, '#!/bin/sh\nprintf unexpected > "$PWD/unexpected-hook"\n'); chmodSync(hook, 0o755);
  try {
    const write = writeProject(f.context, { path: 'source.txt', content: 'operator\n' });
    expect(readFileSync(join(f.root, 'source.txt'), 'utf8')).toBe('operator\n');
    await write;
    expect(readFileSync(join(f.root, '.git/index'))).toEqual(before);
    expect(existsSync(join(f.root, 'unexpected-hook'))).toBe(false);
    await expect(writeProject(f.context, { path: 'later/sub/file', content: 'no' })).rejects.toThrow(/clean source/);
    expect(existsSync(join(f.root, 'later'))).toBe(false);
    await f.supervisor.startProject().catch(error => { expect(String(error)).toMatch(/dirty|source|Git/i); });
    expect(f.calls()).toBe(0);
    expect(git(f.root, 'rev-parse', 'refs/heads/main')).toBe(f.tip);
    expect(readFileSync(join(f.root, 'source.txt'), 'utf8')).toBe('operator\n');
  } finally { await f.supervisor.cleanupForApplicationStop().catch(error => { expect(String(error)).toMatch(/cleanup failed/); }); }
}, 60000);

test('readonly admission checks real staged selection and raw file/mode/link bytes with NUL names', async () => {
  const f = fixture();
  mkdirSync(join(f.root, 'a'));
  writeFileSync(join(f.root, 'a/file'), 'nested');
  writeFileSync(join(f.root, 'a.b'), 'flat');
  writeFileSync(join(f.root, 'new\nline'), 'nul framing');
  writeFileSync(join(f.root, 'executable'), '#!/bin/sh\nexit 0\n'); chmodSync(join(f.root, 'executable'), 0o755);
  symlinkSync('source.txt', join(f.root, 'link'));
  git(f.root, 'add', '--all'); git(f.root, 'commit', '-m', 'native types');
  const expected = { branch_ref: 'refs/heads/main', observed_tip: git(f.root, 'rev-parse', 'HEAD') };
  const source = { source_roots: ['.'], excluded_paths: ['.git', '.saivage', 'unrelated'] };
  try {
    const index = readFileSync(join(f.root, '.git/index'));
    assertCleanGitDelivery(f.root, expected, source);
    expect(readFileSync(join(f.root, '.git/index'))).toEqual(index);
    chmodSync(join(f.root, 'executable'), 0o644);
    expect(() => assertCleanGitDelivery(f.root, expected, source)).toThrow(/modes/);
    chmodSync(join(f.root, 'executable'), 0o755);
    writeFileSync(join(f.root, 'a/file'), 'staged change'); git(f.root, 'add', '--', 'a/file');
    expect(() => assertCleanGitDelivery(f.root, expected, source)).toThrow(/clean real index/);
  } finally { await f.supervisor.cleanupForApplicationStop(); }
});

test.each([true, false])('starting/paused/held final destinations and deferred web save, native=%s', async on => {
  const f = fixture(on); await f.supervisor.start();
  const fetched = deferred<Response>(), fetchEntered = deferred<void>();
  jest.spyOn(globalThis, 'fetch').mockImplementation(() => { fetchEntered.resolve(); return fetched.promise; });
  const surface = buildInvocationSurfaceFixture('analyst', [bindToolProvider('web', webToolBinders, f.context)]);
  const pending = invokeTestTool(surface, 'webfetch', { url: 'https://93.184.216.34', save_as: 'newdir/fetched.txt' });
  await fetchEntered.promise;
  const launched = f.supervisor.startProject();
  try {
    if (on) {
      expect(f.supervisor.getStatus().status).toBe('starting');
      await expect(editProject(f.context, { path: 'source.txt', old_string: 'original', new_string: 'changed' })).rejects.toThrow(/genuinely stopped/);
      await expect(writeProject(f.context, { path: 'project:///newdir/no', content: 'no' })).rejects.toThrow(/genuinely stopped/);
      await expect(writeProject(f.context, { path: `system://${f.root}/newdir/no`, content: 'no' })).rejects.toThrow(/genuinely stopped/);
      const alias = join(f.root, 'unrelated'); mkdirSync(alias);
      symlinkSync(f.root, join(alias, 'alias'));
      await expect(writeProject(f.context, { path: join(alias, 'alias/newdir/no'), content: 'no' })).rejects.toThrow(/symlink|genuinely stopped/);
      await expect(applyProjectPatch(f.context, { patch: 'diff --git a/unrelated/first b/unrelated/first\n--- /dev/null\n+++ b/unrelated/first\n@@ -0,0 +1 @@\n+first\ndiff --git a/source.txt b/source.txt\n--- a/source.txt\n+++ b/source.txt\n@@ -1 +1 @@\n-original\n+changed\n' })).rejects.toThrow(/genuinely stopped/);
      expect(existsSync(join(f.root, 'unrelated/first'))).toBe(false);
    }
    fetched.resolve(new Response('fetched', { status: 200, headers: { 'content-type': 'text/plain' } }));
    const result = await pending;
    expect(result.success).toBe(!on);
    expect(existsSync(join(f.root, 'newdir'))).toBe(!on);
    await launched; await f.entered.promise;
    f.supervisor.pause(); f.release.resolve(); await f.paused.promise;
    expect(f.supervisor.getStatus().status).toBe('paused');
    if (on) await expect(writeProject(f.context, { path: 'source.txt', content: 'no' })).rejects.toThrow(/genuinely stopped/);
    else await writeProject(f.context, { path: 'source.txt', content: 'OFF remains writable' });
    await writeProject(f.context, { path: 'unrelated/note', content: 'permitted' });
    expect(readFileSync(join(f.root, 'unrelated/note'), 'utf8')).toBe('permitted');
    // Record effects retain their own owner, without consuming source admission.
    const gate = jest.fn(() => { throw new Error('source gate must not classify records'); });
    const records = { ...f.context, assertGlobalSourceWrite: gate };
    await writeProject(records, { path: 'record:///brief.md?card=project', content: 'record owner decides' });
    expect(gate).not.toHaveBeenCalled();
    await f.supervisor.stopProject();
    if (on) await expect(writeProject(f.context, { path: 'source.txt', content: 'no' })).rejects.toThrow(/delivery selection/);
  } finally { f.release.resolve(); await launched.catch(() => undefined); await f.supervisor.cleanupForApplicationStop(); }
}, 90000);

test('frozen native capability refuses dynamic MCP persistence, HTTP lifecycle, catalogs and config reconciliation before effects', async () => {
  const f = fixture();
  const configPath = join(f.root, '.saivage/saivage.yaml');
  writeFileSync(configPath, YAML.stringify(TEST_SAIVAGE_CONFIG));
  const authority = testConfigAuthority(f.root);
  const manager = new McpManager({ nativeGit: true, configAuthority: authority,
    processRunner: f.processes.processRunner, mcpProcessRootScope: f.processes.runtimeProcessRootScope,
    eventLogger: { appendEventPrepared() {} } as never });
  const lifecycle = new McpLifecycleIngress(manager, () => undefined, testApplicationFatalPort);
  const connection = { transport: 'stdio' as const, command: process.execPath, args: ['-e', 'throw Error("must not launch")'] };
  const spawn = jest.spyOn(f.processes.processRunner, 'spawnCaptured');
  const original = readFileSync(configPath);
  try {
    expect(() => manager.registerServer('unknown', connection)).toThrow(/unknown source footprint/);
    expect(() => manager.replaceServer('unknown', connection)).toThrow(/unknown source footprint/);
    await expect(lifecycle.startServer('unknown')).rejects.toThrow(/unknown source footprint/);
    await expect(lifecycle.restartServer('unknown')).rejects.toThrow(/unknown source footprint/);
    expect(() => manager.refreshServerCatalog('unknown', 'binding')).toThrow(/unknown source footprint/);
    await expect(manager.invokeTool('unknown', 'binding', 'catalog', 'tool', {})).rejects.toThrow(/unknown source footprint/);
    expect(existsSync(mcpServerDefinitionsPath(f.root))).toBe(false);
    expect(readFileSync(configPath)).toEqual(original);
    // Later operator config does not enlarge the frozen ON owner, even if the
    // newly read document says OFF. No connector or subprocess is admitted.
    writeFileSync(configPath, YAML.stringify({ ...TEST_SAIVAGE_CONFIG, git_workflow: { format_version: 1, enabled: false }, mcpServers: { unknown: { ...connection, autostart: true } } }));
    await expect(manager.reconcilePersistedConfig()).rejects.toThrow(/unknown source footprint/);
    await expect(lifecycle.startServer('unknown')).rejects.toThrow(/unknown source footprint/);
    expect(spawn).not.toHaveBeenCalled();
    expect(lifecycle.hasActiveLifecycleCall()).toBe(false);
  } finally { await manager.cleanupForApplicationStop(); await f.supervisor.cleanupForApplicationStop(); }
});
