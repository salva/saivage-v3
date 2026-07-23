import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { APP_CLEANUP_LEAF_TIMEOUT_MS, createAppTerminalCoordinator } from '../../src/boot/app.js';
import { mkdtempSync, rmSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { CardService } from '../helpers/canonical-project.js'; import { RuntimeInterventionBinding } from '../../src/application/intervention-readiness.js'; import { NO_FRESHNESS_EFFECTS } from '../../src/application/freshness-effects.js'; import { SupervisorRuntimeApi } from '../../src/runtime/actors/supervisor-runtime-api.js'; import { initProjectTree } from '../helpers/canonical-project.js'; import { createTestProcessRunner } from '../helpers/test-process-runner.js'; import { createTestPromptTemplateRegistry } from '../helpers/prompt-template-registry.js'; import { testAutonomousCompaction } from '../helpers/llm-test-helpers.js';
import type { LLMProviderPort } from '../../src/runtime/actors/llm-actor.js';

const roots: string[] = [];
function realHarness(provider: LLMProviderPort = { completeTurn: async (_input: unknown, signal: AbortSignal) => new Promise<never>((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }) {
  const root = mkdtempSync(join(tmpdir(), 'saivage-terminal-supervisor-')); roots.push(root); initProjectTree(root); const cards = new CardService(root); const processes = createTestProcessRunner(root); const runner = processes.processRunner;
  const supervisor = new SupervisorRuntimeApi({ ...testAutonomousCompaction, projectRoot: root, processIdentity: { pid: 1, startedAt: 'now' }, actorStore: cards, interventionBinding: new RuntimeInterventionBinding(), provider, conversations: { projectRoot: root }, freshness: NO_FRESHNESS_EFFECTS, processRunner: runner, runtimeProcessRootScope: processes.runtimeProcessRootScope, promptTemplates: createTestPromptTemplateRegistry() });
  const terminal = createAppTerminalCoordinator(); terminal.registerAdmissionCloser('runtime', () => supervisor.closeApplicationAdmission()); terminal.registerCleanupLeaf('runtime', () => supervisor.cleanupForApplicationStop()); return { supervisor, terminal, cards, runner };
}

describe('App terminal coordinator', () => {
  afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

  it('joins real supervisor application halt from concurrent Stop', async () => {
    const { supervisor, terminal } = realHarness();
    const prepared = await supervisor.beginStartProject(); if (!prepared.accepted) throw new Error('rejected'); supervisor.launchStartedProject(prepared.launch);
    const closing = terminal.stop(); await expect(supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: true }); await expect(closing).resolves.toEqual({ warnings: [] }); expect(supervisor.getStatus().status).toBe('stopped');
  });

  it('joins Stop-first through actual terminal cleanup without a second termination', async () => {
    const { supervisor, terminal, runner } = realHarness(); const prepared = await supervisor.beginStartProject(); if (!prepared.accepted) throw new Error('rejected'); supervisor.launchStartedProject(prepared.launch);
    const terminate = jest.spyOn(runner, 'terminateScopeTree'); const stop = supervisor.stopProject();
    await expect(terminal.stop()).resolves.toEqual({ warnings: [] }); await expect(stop).resolves.toMatchObject({ contained: true }); expect(terminate).toHaveBeenCalledTimes(1); expect(supervisor.getStatus().status).toBe('stopped');
  });

  it.each(['result', 'cancel'] as const)('contains an actual already-settled %s runtime without reviving ownership', async (winner) => {
    let calls = 0; const provider = { completeTurn: async () => { calls += 1; return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: String(calls), type: 'function' as const, function: { name: calls === 1 ? 'write' : 'emit_result', arguments: calls === 1 ? JSON.stringify({ path: 'record:///status.md?v=next', content: 'done' }) : JSON.stringify({ outcome: 'complete_direct', summary: 'done' }) } }] }, provider_exchanges: [] }; } };
    const h = realHarness(provider); const prepared = await h.supervisor.beginStartProject(); if (!prepared.accepted) throw new Error('rejected'); h.supervisor.launchStartedProject(prepared.launch);
    if (winner === 'cancel') await h.supervisor.cancelCard('project', 'terminal shutdown');
    else for (let i = 0; i < 200 && h.supervisor.getStatus().status !== 'stopped'; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.supervisor.getStatus().status).toBe('stopped'); const first = h.terminal.stop(); expect(h.terminal.stop()).toBe(first); await expect(first).resolves.toEqual({ warnings: [] }); expect(h.supervisor.getStatus().status).toBe('stopped');
  });

  it('reports an actual supervisor cleanup failure once and retains closing ownership', async () => {
    const h = realHarness(); const prepared = await h.supervisor.beginStartProject(); if (!prepared.accepted) throw new Error('rejected'); h.supervisor.launchStartedProject(prepared.launch);
    jest.spyOn(h.runner, 'terminateScopeTree').mockRejectedValueOnce(new Error('termination failed')); const report = await h.terminal.stop();
    expect(report).toEqual({ warnings: [{ component: 'runtime', code: 'cleanup_failed' }] }); expect(h.supervisor.getStatus().status).toBe('error');
  });

  it('closes admission on an actual stopped supervisor and leaves Stop not-contained', async () => {
    const h = realHarness(); await h.supervisor.start(); await expect(h.terminal.stop()).resolves.toEqual({ warnings: [] }); await expect(h.supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: false });
  });

  it('closes every admission before cleanup and isolates fixed warnings', async () => {
    const terminal = createAppTerminalCoordinator();
    const calls: string[] = [];
    const log = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    terminal.registerAdmissionCloser('http-admission', () => { calls.push('http'); throw new Error('/secret/path token=secret'); });
    terminal.registerAdmissionCloser('runtime', () => { calls.push('runtime'); });
    terminal.registerCleanupLeaf('fastify', async () => { calls.push('fastify'); throw { payload: 'secret' }; });
    terminal.registerCleanupLeaf('live-sync', async () => { calls.push('live-sync'); });

    const report = await terminal.stop();

    expect(calls).toEqual(['http', 'runtime', 'live-sync', 'fastify']);
    expect(report).toEqual({ warnings: [
      { component: 'http-admission', code: 'closer_failed' },
      { component: 'fastify', code: 'cleanup_failed' },
    ] });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.warnings)).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });

  it('shares one report and continues after a bounded hanging leaf', async () => {
    jest.useFakeTimers();
    expect(APP_CLEANUP_LEAF_TIMEOUT_MS).toBe(10_000);
    const terminal = createAppTerminalCoordinator();
    const calls: string[] = [];
    terminal.registerCleanupLeaf('fastify', async () => { calls.push('later'); });
    terminal.registerCleanupLeaf('runtime', () => { calls.push('hanging'); return new Promise<void>(() => undefined); });

    const first = terminal.stop();
    const second = terminal.stop();
    const settled = jest.fn();
    void first.then(settled);
    expect(first).toBe(second);
    expect(calls).toEqual(['hanging']);
    await jest.advanceTimersByTimeAsync(9_999);
    expect(settled).not.toHaveBeenCalled();
    expect(calls).toEqual(['hanging']);
    await jest.advanceTimersByTimeAsync(1);
    const report = await first;
    expect(report).toEqual({ warnings: [{ component: 'runtime', code: 'cleanup_timeout' }] });
    expect(calls).toEqual(['hanging', 'later']);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith(report);
    expect(await second).toBe(report);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears the referenced timer after fast fulfillment and rejection', async () => {
    jest.useFakeTimers();
    for (const rejects of [false, true]) {
      const terminal = createAppTerminalCoordinator();
      terminal.registerCleanupLeaf('runtime', () => rejects ? Promise.reject(new Error('private')) : Promise.resolve());
      const before = jest.getTimerCount();
      const report = await terminal.stop();
      expect(jest.getTimerCount()).toBe(before);
      expect(report.warnings).toEqual(rejects ? [{ component: 'runtime', code: 'cleanup_failed' }] : []);
    }
  });
});
