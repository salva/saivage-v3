import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProjectTree } from '../helpers/canonical-project.js';
import { createTestProcessRunner } from '../helpers/test-process-runner.js';
import type { ManagedProcessScope, ProcessCategory, ProcessRunner } from '../../src/runtime/process-runner.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('ProcessRunner managed process groups', () => {
  let root: string;
  let runner: ProcessRunner;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'proc-runner-'));
    initProjectTree(root);
    runner = createTestProcessRunner(root);
  });

  afterEach(async () => {
    await runner.terminateScopeTree({ rootScope: runner.registry.rootScope, categories: ['runtime_card', 'operator_session', 'service_infrastructure'], reason: 'test cleanup', graceMs: 100 });
    rmSync(root, { recursive: true, force: true });
  });

  function direct(category: ProcessCategory, label: string = category): ManagedProcessScope {
    const parent = category === 'runtime_card' ? runner.runtimeRootScope : category === 'operator_session' ? runner.analystRootScope : runner.mcpRootScope;
    return runner.createDirectScope(parent, label, category);
  }

  function launch(command: string, scope = direct('runtime_card'), category: ProcessCategory = 'runtime_card') {
    return runner.spawn({ command, directScope: scope, category, cardId: category === 'runtime_card' ? 'card-aaaaaaaaaaaaaaaaaaaaaaaaaaaa' : null, ownerId: 'same-owner', ownerKind: category === 'operator_session' ? 'operator' : 'agent' });
  }

  it('records output and keeps the registry instance-local and memory-only', async () => {
    const record = launch('echo stdout; echo stderr >&2');
    await runner.waitForSettlement(record.id);
    expect(runner.get(record.id)).toMatchObject({ status: 'exited', exit_code: 0 });
    expect(readFileSync(record.stdout_path, 'utf8')).toContain('stdout');
    expect(readFileSync(record.stderr_path, 'utf8')).toContain('stderr');
    expect(existsSync(join(root, '.saivage', 'state', 'processes.json'))).toBe(false);
    expect(createTestProcessRunner(root).list()).toEqual([]);
  });

  it('contains a real spawn error and remains usable after a nonexistent cwd', async () => {
    const failedScope = direct('runtime_card', 'failed-launch');
    expect(() => runner.spawn({
      command: 'exit 0',
      directScope: failedScope,
      category: 'runtime_card',
      ownerId: 'same-owner',
      ownerKind: 'agent',
      cwd: join(root, 'missing-cwd'),
    })).toThrow('has no leader PID');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runner.list()).toEqual([]);

    const subsequent = launch('exit 0');
    await expect(runner.waitForSettlement(subsequent.id)).resolves.toMatchObject({ status: 'exited', exitCode: 0 });
  });

  it.each<ProcessCategory>(['runtime_card', 'operator_session', 'service_infrastructure'])('does not finalize an exited wrapper while its %s descendant remains', async (category) => {
    const scope = direct(category);
    const pidFile = join(root, `${category}.pid`);
    const record = launch(`sleep 60 & echo $! > ${JSON.stringify(pidFile)}; exit`, scope, category);
    for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt += 1) await delay(10);
    await delay(75);
    expect(runner.get(record.id)).toMatchObject({ status: 'running' });
    const report = await runner.terminateScopeTree({ rootScope: scope, categories: [category], reason: 'scope complete', graceMs: 100 });
    expect(report).toEqual({ selected: [record.id], stopped: [record.id], failed: [] });
    expect(runner.get(record.id)).toMatchObject({ status: 'killed' });
  });

  it('uses exact direct scope and category rather than owner metadata for kill authorization', async () => {
    const ownerScope = direct('runtime_card', 'duplicate');
    const siblingScope = direct('runtime_card', 'duplicate');
    const record = launch('sleep 60', ownerScope);
    await expect(runner.kill(record.id, { directScope: siblingScope, category: 'runtime_card' })).rejects.toThrow('not bound');
    await expect(runner.kill(record.id, { directScope: ownerScope, category: 'operator_session' })).rejects.toThrow('not bound');
    await expect(runner.kill(record.id, { directScope: ownerScope, category: 'runtime_card', graceMs: 100 })).resolves.toMatchObject({ status: 'killed' });
  });

  it('runtime-card cleanup excludes Analyst and service groups', async () => {
    const runtime = launch('sleep 60', direct('runtime_card'), 'runtime_card');
    const analyst = launch('sleep 60', direct('operator_session'), 'operator_session');
    const service = launch('sleep 60', direct('service_infrastructure'), 'service_infrastructure');
    const report = await runner.terminateScopeTree({ rootScope: runner.registry.rootScope, categories: ['runtime_card'], reason: 'runtime shutdown', graceMs: 100 });
    expect(report.selected).toEqual([runtime.id]);
    expect(runner.get(runtime.id)?.status).toBe('killed');
    expect(runner.get(analyst.id)?.status).toBe('running');
    expect(runner.get(service.id)?.status).toBe('running');
  });
});
