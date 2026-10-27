import { describe, expect, it, jest } from '@jest/globals';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishInitialProjectRuntime, preflightInitialProjectSource, assertInitialProjectPolicy } from '../../src/boot/project-runtime-bootstrap.js';
import { withDirectMutationComposition } from '../../src/boot/direct-mutation-composition.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { DEFAULT_SAIVAGE_CONFIG } from '../../src/config/system-templates/registry.js';
import { compileProjectWorkflowDeclarations, compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { readProjectCardOrAssertInitialPublicationAllowed } from '../../src/persistence/generated-state.js';
import { readCard } from '../../src/persistence/card-files.js';
import { readCardExecutions } from '../../src/persistence/card-execution-log.js';
import { cardConversationVersionIndexFile, runtimeProcessLockFile } from '../../src/persistence/layout.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/index.js';

jest.setTimeout(180000);
function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, timeout: 5000, encoding: 'utf8', env: {
    ...process.env, GIT_AUTHOR_NAME: 'Bootstrap fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Bootstrap fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  } });
  if (result.status !== 0 || result.error) throw new Error(`Fixture Git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}
function fixture(native = true) {
  const root = mkdtempSync(join(tmpdir(), 'bootstrap-'));
  git(root, 'init', '--initial-branch=main');
  writeFileSync(join(root, '.gitignore'), '.saivage/\n');
  writeFileSync(join(root, 'source'), 'source\n');
  git(root, 'add', '--all'); git(root, 'commit', '-m', 'fixture');
  const config = structuredClone(DEFAULT_SAIVAGE_CONFIG);
  if (!native) return { root, workflows: compileProjectWorkflows(config) };
  config.agents[config.analyst_agent]!.tools = config.agents[config.analyst_agent]!.tools.filter(name => name !== 'run_command' && !name.startsWith('mcp_'));
  config.agents.executor!.record_writes.push('git-correction.md');
  for (const definition of Object.values(config.card_types))
    definition.records['git-correction.md'] = { format: 'markdown', schema: 'git-correction.v1', bootstrap: false };
  config.git_workflow = { format_version: 1, enabled: true, delivery_branch: 'main',
    private_ref_namespace: 'refs/saivage/bootstrap', source_roots: ['.'], excluded_paths: ['.git', '.saivage'],
    integration: 'squash', preservation: { source_checkpoint: 'eligible-worktree', interrupted_rebase: 'preserve-source-before-abort' },
    correction: { agent: 'executor', prompt: { reference: 'git-rebase-correction', compactable: true },
      correction_prompt: { reference: 'correct-git-rebase-result', compactable: true } },
    review_bindings: Object.fromEntries(Object.entries(config.card_types).map(([type, definition]) =>
      [type, definition.workflow.nodes.review ? { node: 'review', approved_outcome: 'approved' } : null])),
  };
  const prompts = join(root, '.saivage/config/prompts/process/_shared');
  mkdirSync(prompts, { recursive: true });
  writeFileSync(join(prompts, 'git-rebase-correction.md'), 'Reconstruct the full original work plus useful later corrections on the selected parent. Keep the partial snapshot distinct from original history. Report readiness for native verification, not product completion.');
  writeFileSync(join(prompts, 'correct-git-rebase-result.md'), 'Address the reported verification mismatch; report blocked or failed if correction cannot be completed.');
  // Actual structural compiler; public profile remains guarded until bundle closure.
  writeFileSync(join(root, '.saivage/bootstrap-fixture.json'), JSON.stringify(config));
  return { root, workflows: compileProjectWorkflowDeclarations(config, { projectRoot: root }) };
}
async function initialize(root: string, workflows: ReturnType<typeof compileProjectWorkflows>) {
  await withDirectMutationComposition(root, 'init', testApplicationFatalPort, async owner => {
    owner.createAndBindProjectIdentity();
    await publishInitialProjectRuntime(root, workflows, owner);
  });
}

describe('lifecycle-owned initial publication', () => {
  it('commissions from clean D with sessions and Analyst before head, and refuses reuse before deletion', async () => {
    const { root, workflows } = fixture();
    const tip = git(root, 'rev-parse', 'HEAD');
    const hook = join(root, '.git/hooks/reference-transaction');
    writeFileSync(hook, '#!/bin/sh\nif [ "$1" = prepared ]; then\n' +
      'test ! -e .saivage/cards/project/card-head.json || exit 21\n' +
      'test -f .saivage/cards/project/records/executions.jsonl || exit 22\n' +
      'test -f .saivage/agents/conversations/analyst/index.json || exit 23\n' +
      'test -f .saivage/cards/project/conversations/executor/index.json || exit 24\n' +
      'test ! -e .saivage/agents/conversations/oversight/index.json || exit 25\n' +
      'echo observed > .saivage/bootstrap-order\nfi\n');
    chmodSync(hook, 0o755);
    await initialize(root, workflows);
    expect(readFileSync(join(root, '.saivage/bootstrap-order'), 'utf8')).toContain('observed');
    expect(existsSync(cardConversationVersionIndexFile(root, 'project', 'executor'))).toBe(true);
    const card = readCard(root, 'project')!;
    expect(card.git).toMatchObject({ kind: 'root', observed_tip: tip, base_oid: tip,
      parent: { branch_ref: 'refs/heads/main', observed_tip: tip }, candidate: null, correction: null });
    expect(git(root, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    expect(git(root, 'rev-parse', card.git!.branch_ref)).toBe(tip);
    expect(readCardExecutions(root, 'project').at(-1)).toMatchObject({ outcome: 'commissioned' });
    const before = readFileSync(join(root, '.saivage/cards/project/card-head.json'));
    expect(() => preflightInitialProjectSource(root, workflows)).toThrow(/already exists/);
    expect(readFileSync(join(root, '.saivage/cards/project/card-head.json'))).toEqual(before);
    expect(() => assertInitialProjectPolicy(root, workflows)).not.toThrow();
    expect(() => assertInitialProjectPolicy(root, { ...workflows, gitPolicy: null })).toThrow(/OFF/);
    expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
  });

  it('contains a pending real Git hook on SIGTERM before releasing the initializer lock', async () => {
    const { root } = fixture();
    const hook = join(root, '.git/hooks/reference-transaction');
    writeFileSync(hook, '#!/bin/sh\nif [ "$1" = prepared ]; then\necho pending > .saivage/pending\nsleep 60\nfi\n');
    chmodSync(hook, 0o755);
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'tests/fixtures/native-bootstrap-signal.ts', root],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 150000 });
    expect({ status: child.status, stderr: child.stderr, error: child.error }).toMatchObject({ status: 0, stderr: '', error: undefined });
    expect(child.stdout).toContain('signal-settled-lock-released');
    expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
    expect(existsSync(join(root, '.saivage/cards/project/card-head.json'))).toBe(false);
    expect(() => readProjectCardOrAssertInitialPublicationAllowed(root)).toThrow(/generated state exists/);
  });

  it('refuses ref-only partial initialization before creating generated roots, permitting only a fresh namespace', async () => {
    const { root, workflows } = fixture();
    git(root, 'update-ref', 'refs/heads/saivage/bootstrap/project', git(root, 'rev-parse', 'HEAD'));
    await expect(initialize(root, workflows)).rejects.toThrow(/already exists/);
    for (const name of ['cards', 'agents', 'logs', 'work']) expect(existsSync(join(root, '.saivage', name))).toBe(false);
    const fresh = { ...workflows, gitPolicy: { ...workflows.gitPolicy!, private_ref_namespace: 'refs/saivage/new-bootstrap' } };
    await withDirectMutationComposition(root, 'bound', testApplicationFatalPort, owner => publishInitialProjectRuntime(root, fresh, owner));
    expect(readCard(root, 'project')!.git!.branch_ref).toBe('refs/heads/saivage/new-bootstrap/project');
    expect(git(root, 'rev-parse', 'refs/heads/saivage/bootstrap/project')).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(() => assertInitialProjectPolicy(root, workflows)).toThrow(/does not match/);
  });

  it('OFF initializes without native evidence and rejects partial retained layout', async () => {
    const { root, workflows } = fixture(false);
    await initialize(root, workflows);
    expect(readCard(root, 'project')!.git).toBeNull();
    expect(readCardExecutions(root, 'project')).toEqual([]);
    const partial = fixture(false);
    mkdirSync(join(partial.root, '.saivage/work'), { recursive: true });
    await expect(initialize(partial.root, partial.workflows)).rejects.toThrow(/generated state exists/);
  });

  it('holds initializer exclusion when a native publication reaches a throwing fatal boundary', async () => {
    const { root, workflows } = fixture();
    let injected = false;
    const priorSignals = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') };
    await expect(withDirectMutationComposition(root, 'init', testApplicationFatalPort, async owner => {
      owner.createAndBindProjectIdentity();
      await publishInitialProjectRuntime(root, workflows, { ...owner, assertCurrent() {
        owner.assertCurrent();
        if (!injected && existsSync(join(root, '.saivage/cards/project/records/executions.jsonl'))) {
          injected = true;
          throw new PublicationOutcomeUnknownError();
        }
      } });
    })).rejects.toThrow();
    expect(injected).toBe(true);
    expect(existsSync(runtimeProcessLockFile(root))).toBe(true);
    expect(existsSync(join(root, '.saivage/cards/project/card-head.json'))).toBe(false);
    // A real fatalPort exits; remove only this throwing-port fixture's listeners.
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      for (const listener of process.listeners(signal))
        if (!priorSignals[signal].includes(listener)) process.removeListener(signal, listener);
  });
});
